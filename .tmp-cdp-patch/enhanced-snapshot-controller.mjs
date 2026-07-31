import assert from 'node:assert/strict';
import { build } from '../extension/node_modules/esbuild/lib/main.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'nco-deep-controller-'));
const outfile = join(temp, 'deep-inspector.mjs');
const debuggerOutfile = join(temp, 'debugger-controller.mjs');

try {
  await build({
    entryPoints: [fileURLToPath(new URL('../extension/src/control/deep-inspector.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
  });
  await build({
    entryPoints: [fileURLToPath(new URL('../extension/src/control/debugger-controller.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: debuggerOutfile,
  });
  const { executeDeepInspect } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const { executeDebuggerAction } = await import(`${pathToFileURL(debuggerOutfile).href}?t=${Date.now()}`);

  let attached = 0;
  let detached = 0;
  const methods = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabs: { get: async (tabId) => ({ id: tabId }) },
    debugger: {
      attach(_target, _version, callback) { attached++; callback(); },
      detach(_target, callback) { detached++; callback(); },
      sendCommand(_target, method, params, callback) {
        methods.push(method);
        if (method === 'DOMSnapshot.captureSnapshot') {
          callback({ strings: [], documents: [{ frameId: 'root', nodes: { backendNodeId: [] }, layout: { nodeIndex: [] } }] });
        } else if (method === 'Page.getFrameTree') {
          callback({ frameTree: { frame: { id: 'root', url: 'https://example.test/' } } });
        } else if (method === 'Page.getLayoutMetrics') {
          callback({});
        } else if (method === 'Accessibility.getFullAXTree' && params.frameId === 'root') {
          callback({ nodes: [] });
        } else if (method === 'DOM.getDocument') {
          callback({ root: { nodeId: 1 } });
        } else if (method === 'Page.captureScreenshot') {
          callback({ data: 'base64-shot' });
        } else {
          globalThis.chrome.runtime.lastError = { message: `unexpected ${method}` };
          callback();
          globalThis.chrome.runtime.lastError = undefined;
        }
      },
    },
  };

  const success = await executeDeepInspect(7, { retries: 0, timeoutMs: 100 });
  assert.equal(success.ok, true);
  assert.equal(success.data.deepInspection.schema, 'nco.deep-inspection.v1');
  assert.equal(attached, 1);
  assert.equal(detached, 1, 'a session attached by this extension must be detached exactly once');
  assert.equal(methods.some((method) => method.startsWith('Runtime.')), false);

  globalThis.chrome.debugger.attach = (_target, _version, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'Another debugger is already attached to the tab' };
    callback();
    globalThis.chrome.runtime.lastError = undefined;
  };
  const busy = await executeDeepInspect(8, { retries: 0, timeoutMs: 100 });
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'debugger_busy');
  assert.equal(detached, 1, 'a debugger session owned by somebody else must never be detached');

  const blockedBeforeAttach = attached;
  const blockedMethods = [
    'Runtime.evaluate',
    'Input.dispatchKeyEvent',
    'DOM.setOuterHTML',
    'DOM.setAttributeValue',
    'DOM.setFileInputFiles',
    'Input.insertText',
    'Input.dispatchDragEvent',
    'Input.foo',
    'DOM.foo',
  ];
  for (const method of blockedMethods) {
    const result = await executeDebuggerAction('CDP_EXECUTE', { method });
    assert.equal(result.ok, false, `${method} must be blocked`);
    assert.equal(result.error?.code, 'cdp_method_blocked', `${method} error code`);
    assert.match(result.error?.message ?? '', new RegExp(method.replace('.', '\\.')), `${method} must appear in error message`);
  }
  assert.equal(attached, blockedBeforeAttach, 'blocked CDP_EXECUTE must fail before debugger attach');

  globalThis.chrome.debugger.attach = (_target, _version, callback) => { attached++; callback(); };
  globalThis.chrome.debugger.sendCommand = (_target, method, _params, callback) => {
    if (method === 'DOMSnapshot.captureSnapshot') {
      globalThis.chrome.runtime.lastError = { message: 'snapshot failed' };
      callback();
      globalThis.chrome.runtime.lastError = undefined;
    } else if (method === 'DOM.getDocument') {
      callback({ root: { nodeId: 42 } });
    } else if (method === 'Page.captureScreenshot') {
      callback({ data: 'allowed-shot' });
    } else callback({});
  };
  const allowedDoc = await executeDebuggerAction('CDP_EXECUTE', { method: 'DOM.getDocument', tabId: 21 });
  assert.equal(allowedDoc.ok, true);
  assert.deepEqual(allowedDoc.data?.result, { root: { nodeId: 42 } });
  const allowedShot = await executeDebuggerAction('CDP_EXECUTE', { method: 'Page.captureScreenshot', tabId: 21 });
  assert.equal(allowedShot.ok, true);
  assert.deepEqual(allowedShot.data?.result, { data: 'allowed-shot' });

  const midFailure = await executeDeepInspect(9, { retries: 0, timeoutMs: 100 });
  assert.equal(midFailure.ok, false);
  assert.equal(detached, 4, 'mid-command failure must still detach exactly once');

  let activeSessions = 0;
  let maxActiveSessions = 0;
  globalThis.chrome.debugger.attach = (_target, _version, callback) => {
    attached++;
    activeSessions++;
    maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
    callback();
  };
  globalThis.chrome.debugger.detach = (_target, callback) => { detached++; activeSessions--; callback(); };
  globalThis.chrome.debugger.sendCommand = (_target, method, params, callback) => {
    const respond = () => {
      if (method === 'DOMSnapshot.captureSnapshot') callback({ strings: [], documents: [{ frameId: 'root', nodes: { backendNodeId: [] }, layout: { nodeIndex: [] } }] });
      else if (method === 'Page.getFrameTree') callback({ frameTree: { frame: { id: 'root', url: 'https://example.test/' } } });
      else if (method === 'Accessibility.getFullAXTree' && params.frameId === 'root') callback({ nodes: [] });
      else callback({});
    };
    if (method === 'DOMSnapshot.captureSnapshot') setTimeout(respond, 15); else respond();
  };
  maxActiveSessions = 0;
  await Promise.all([executeDeepInspect(10, { retries: 0, timeoutMs: 100 }), executeDeepInspect(10, { retries: 0, timeoutMs: 100 })]);
  assert.equal(maxActiveSessions, 1, 'same-tab debugger work must be serialized');
  maxActiveSessions = 0;
  await Promise.all([executeDeepInspect(11, { retries: 0, timeoutMs: 100 }), executeDeepInspect(12, { retries: 0, timeoutMs: 100 })]);
  assert.ok(maxActiveSessions >= 2, 'different tabs may inspect in parallel');

  console.log('enhanced snapshot controller: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
