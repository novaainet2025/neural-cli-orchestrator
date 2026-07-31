import type { ControllerResult } from './content-controller.js';
import { activeTab } from './content-controller.js';
import { DESTRUCTIVE_LABEL_RE } from '../shared/destructive.js';
import { withTabDebuggerLock } from './debugger-lock.js';

declare const process: { env?: Record<string, string | undefined> };

// CDP_EXECUTE is intentionally much narrower than the internal CDP commands
// used for FORCE_* escalation below.  Keep block rules before allow rules so a
// future broad allow prefix cannot expose one of these dangerous commands.
const CDP_BLOCKED_METHODS = [
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Fetch.',
  'Network.setCookie',
  'Network.deleteCookies',
  'Storage.',
  'Browser.',
  // 좌표/키 입력은 클릭·제출을 직접 일으켜 패널 승인 경로를 우회할 수 있다.
  'Input.dispatchMouseEvent',
  'Input.dispatchTouchEvent',
  'Input.emulateTouchFromMouseEvent',
  'Input.synthesizeTapGesture',
  'Input.dispatchKeyEvent',
] as const;
// Public CDP_EXECUTE is read-only fail-closed. Internal FORCE_*/CDP_CLICK/CDP_TYPE paths
// call Runtime/Input directly and are not subject to this allowset.
const CDP_ALLOWED_METHODS = [
  'DOM.enable',
  'DOM.disable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getAttributes',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.getOuterHTML',
  'DOM.getNodeForLocation',
  'DOM.performSearch',
  'DOM.getSearchResults',
  'DOM.discardSearchResults',
  'Page.captureScreenshot',
  'Network.getResponseBody',
] as const;
const NCO_CDP_ALLOW_UNSAFE = process.env?.NCO_CDP_ALLOW_UNSAFE === '1';
/** ref=eN / eN → [data-nco-ref="eN"] (dom-controller.resolveSelector 와 동일 규칙 — 순환 import 회피 위해 로컬 복제).
 *  CDP 에스컬레이션도 click/type 과 동일하게 안정 ref 를 타겟으로 받아들이게 한다. */
function resolveRef(selector: string): string {
  const m = selector.trim().match(/^(?:ref=)?(e\d+)$/);
  return m ? `[data-nco-ref="${m[1]}"]` : selector;
}

function cdpExecuteAllowed(method: string): boolean {
  if (NCO_CDP_ALLOW_UNSAFE) return true;
  if (CDP_BLOCKED_METHODS.some((blocked) => method === blocked || method.startsWith(blocked))) return false;
  return CDP_ALLOWED_METHODS.includes(method as typeof CDP_ALLOWED_METHODS[number]);
}

/**
 * CDP(chrome.debugger) 신뢰 입력 — 강제 제어의 최종 에스컬레이션.
 * DOM 합성 이벤트를 무시·차단하는 페이지도 CDP 가 보내는 입력은 브라우저 레벨의 "신뢰된(trusted)"
 * 이벤트라 대부분 통과한다. attach → 좌표/포커스 확보 → Input.dispatch → detach.
 *
 * 지원 액션:
 *  CDP_CLICK { selector }         — 요소 중심 좌표에 실제 마우스 press/release
 *  CDP_TYPE  { selector, text }   — 요소 포커스 후 Input.insertText
 *  CDP_EXECUTE { method, params } — 명시 허용된 읽기 전용 CDP 커맨드(고급)
 */
export async function executeDebuggerAction(
  action: string,
  payload: Record<string, unknown>,
): Promise<ControllerResult> {
  if (action === 'CDP_EXECUTE') {
    const method = String(payload.method ?? '');
    if (!method) return { ok: false, error: { code: 'invalid_argument', message: 'method 필요' } };
    if (!cdpExecuteAllowed(method)) {
      return { ok: false, error: { code: 'cdp_method_blocked', message: `Blocked CDP method: ${method}` } };
    }
  }
  const dbg = (chrome as unknown as { debugger?: typeof chrome.debugger }).debugger;
  if (!dbg) {
    return { ok: false, error: { code: 'debugger_unavailable', message: 'chrome.debugger 권한이 없거나 사용할 수 없습니다(manifest permissions 에 "debugger" 필요).' } };
  }
  const tab = await activeTab(payload.tabId);
  if (!tab?.id) return { ok: false, error: { code: 'no_active_tab', message: '활성 탭 없음' } };
  return withTabDebuggerLock(tab.id, async () => {
  const target = { tabId: tab.id! };

  const send = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      dbg.sendCommand(target, method, params ?? {}, (res?: unknown) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve(res as T);
      });
    });

  let attached = false;
  try {
    await new Promise<void>((resolve, reject) => {
      dbg.attach(target, '1.3', () => {
        const err = chrome.runtime.lastError;
        // 다른 debugger/DevTools가 소유한 세션은 사용하거나 detach하지 않는다.
        if (err) reject(new Error(err.message)); else resolve();
      });
    });
    attached = true;
    await send('DOM.enable');
    await send('Runtime.enable');

    if (action === 'CDP_CLICK' || action === 'FORCE_CLICK') {
      const rawSelector = typeof payload.selector === 'string' ? payload.selector.trim() : '';
      let pt: { x: number; y: number } | null = null;
      if (!rawSelector) {
        const x = payload.x;
        const y = payload.y;
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
          return { ok: false, error: { code: 'invalid_argument', message: 'CDP click requires a selector or finite x/y coordinates' } };
        }
        if (payload.confirmed !== true) {
          return { ok: false, error: { code: 'confirmation_required', message: 'Coordinate CDP click requires panel confirmation' } };
        }
        pt = { x, y };
      } else {
        const sel = resolveRef(rawSelector);
        const inspected = await send<{ result?: { value?: { x: number; y: number; label: string } | null } }>('Runtime.evaluate', {
          expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const t = e.closest('button,a,[role="button"],input[type="submit"],input[type="button"],[onclick]') || e; t.scrollIntoView({block:'center',inline:'center'}); const r = t.getBoundingClientRect(); const label = [t.getAttribute('aria-label'), t.getAttribute('title'), t instanceof HTMLInputElement ? t.value : '', t instanceof HTMLElement ? t.innerText : '', t.textContent].filter(v => typeof v === 'string' && v.trim()).join(' '); return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2), label }; })()`,
          returnByValue: true,
        });
        const value = inspected.result?.value;
        if (!value) return { ok: false, error: { code: 'not_found', message: `CDP: 요소 없음 ${sel}` } };
        if (payload.confirmed !== true && DESTRUCTIVE_LABEL_RE.test(value.label)) {
          return { ok: false, error: { code: 'confirmation_required', message: 'Destructive CDP click requires panel confirmation' } };
        }
        pt = { x: value.x, y: value.y };
      }
      const base = { x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      return { ok: true, data: { strategy: 'cdp-mouse', x: pt.x, y: pt.y } };
    }

    if (action === 'CDP_TYPE' || action === 'FORCE_TYPE') {
      const sel = resolveRef(String(payload.selector ?? ''));
      const text = String(payload.text ?? '');
      const focused = await send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); if ('value' in e) { try { e.value=''; } catch(_){} } return document.activeElement === e; })()`,
        returnByValue: true,
      });
      if (!focused.result?.value) return { ok: false, error: { code: 'not_focusable', message: `CDP: 포커스 실패 ${sel}` } };
      await send('Input.insertText', { text });
      return { ok: true, data: { strategy: 'cdp-insertText' } };
    }

    if (action === 'CDP_EXECUTE') {
      const method = String(payload.method ?? '');
      const res = await send(method, (payload.params as Record<string, unknown>) ?? {});
      return { ok: true, data: { result: res as Record<string, unknown> } };
    }

    return { ok: false, error: { code: 'unsupported_cdp', message: `Unsupported CDP action: ${action}` } };
  } catch (e) {
    return { ok: false, error: { code: 'cdp_failed', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    if (attached) { try { await new Promise<void>((r) => dbg.detach(target, () => { void chrome.runtime.lastError; r(); })); } catch { /* ignore */ } }
  }
  });
}
