import { describe, expect, it } from 'vitest';
import { createPaLifecycle, DEFAULT_STICKY_TTL_MS, PaLifecycle } from './pa-lifecycle.js';

describe('PaLifecycle (P2-10 PA 수명주기 비용 노브)', () => {
  it('기본 모드는 sticky, 명시 매핑은 우선한다', () => {
    const pa = createPaLifecycle({ modes: { ollama: 'always-on', codex: 'on-demand' } });
    expect(pa.modeOf('ollama')).toBe('always-on');
    expect(pa.modeOf('codex')).toBe('on-demand');
    expect(pa.modeOf('unknown')).toBe('sticky');
    expect(pa.defaultMode).toBe('sticky');
    expect(pa.stickyTtlMs).toBe(DEFAULT_STICKY_TTL_MS);
  });

  it('sticky: TTL 이내면 웜 유지, 초과면 축출 대상', () => {
    const pa = new PaLifecycle({ defaultMode: 'sticky', stickyTtlMs: 1000 });
    pa.markUsed('a', 10_000);
    expect(pa.shouldKeepWarm('a', 10_500)).toBe(true); // 500ms 경과 < 1000
    expect(pa.shouldKeepWarm('a', 11_000)).toBe(true); // 정확히 TTL
    expect(pa.shouldKeepWarm('a', 11_001)).toBe(false); // 초과
    expect(pa.evictable(11_001)).toEqual(['a']);
    expect(pa.evictable(10_500)).toEqual([]);
  });

  it('always-on: 항상 웜 유지, 절대 축출 안 됨', () => {
    const pa = new PaLifecycle({ modes: { brain: 'always-on' }, stickyTtlMs: 1 });
    pa.markUsed('brain', 0);
    expect(pa.shouldKeepWarm('brain', 10_000_000)).toBe(true);
    expect(pa.evictable(10_000_000)).toEqual([]);
  });

  it('on-demand: 웜 유지 안 함, markUsed는 레지스트리에 남기지 않음', () => {
    const pa = new PaLifecycle({ modes: { worker: 'on-demand' } });
    pa.markUsed('worker', 100);
    expect(pa.shouldKeepWarm('worker', 100)).toBe(false);
    expect(pa.snapshot()).toEqual([]);
  });

  it('markUsed 재호출은 lastUsedAt을 갱신해 웜 창을 연장한다', () => {
    const pa = new PaLifecycle({ stickyTtlMs: 1000 });
    pa.markUsed('a', 0);
    expect(pa.shouldKeepWarm('a', 1500)).toBe(false); // 만료
    pa.markUsed('a', 1500); // 재사용 → 갱신
    expect(pa.shouldKeepWarm('a', 2000)).toBe(true); // 500ms 경과
  });

  it('evict는 레지스트리에서 제거한다', () => {
    const pa = new PaLifecycle({ stickyTtlMs: 1000 });
    pa.markUsed('a', 0);
    pa.evict('a');
    expect(pa.shouldKeepWarm('a', 100)).toBe(false);
    expect(pa.snapshot()).toEqual([]);
  });

  it('setMode 오버라이드가 반영된다', () => {
    const pa = new PaLifecycle();
    expect(pa.modeOf('x')).toBe('sticky');
    pa.setMode('x', 'always-on');
    expect(pa.modeOf('x')).toBe('always-on');
  });

  it('음수 TTL은 거부', () => {
    expect(() => new PaLifecycle({ stickyTtlMs: -1 })).toThrow();
  });
});
