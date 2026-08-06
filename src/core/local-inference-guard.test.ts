import { describe, it, expect } from 'vitest';
import {
  judgeInferenceProcess,
  selectReapableInferenceProcesses,
  judgeOllamaHealth,
  judgeModelResidency,
  LOADED_RSS_FLOOR_BYTES,
  STUCK_LOADER_GRACE_MS,
  OLLAMA_QUEUE_FULL_MARKER,
  INDEFINITE_PIN_THRESHOLD_MS,
  type InferenceProcessSample,
} from './local-inference-guard.js';

const LLAMA = '/opt/homebrew/Cellar/ollama/0.32.5/libexec/lib/ollama/llama-server --model /blobs/sha256-abc --port 61356';

const sample = (over: Partial<InferenceProcessSample> = {}): InferenceProcessSample => ({
  pid: 100,
  ppid: 50,
  rssBytes: 13.6e9,
  elapsedMs: 3600_000,
  command: LLAMA,
  ...over,
});

describe('judgeInferenceProcess', () => {
  const live = new Set([50, 100]);

  it('모델을 올린 서버는 건드리지 않는다', () => {
    expect(judgeInferenceProcess(sample(), live).verdict).toBe('healthy');
  });

  it('llama-server 가 아니면 대상이 아니다', () => {
    // `ollama serve` 본체를 죽이면 서비스가 통째로 내려간다.
    const j = judgeInferenceProcess(sample({ command: '/opt/homebrew/bin/ollama serve' }), live);
    expect(j.verdict).toBe('healthy');
  });

  describe('고아 — 부모가 사라진 경우', () => {
    // 실측: pid 41243·42007 이 `ollama serve` 재기동을 넘겨 살아남았다.
    it('부모 pid 가 살아 있지 않으면 고아', () => {
      const j = judgeInferenceProcess(sample({ ppid: 38528 }), new Set([100]));
      expect(j.verdict).toBe('orphan');
      expect(j.reason).toContain('38528');
    });

    it('ppid 1 로 재부모화된 것도 고아', () => {
      expect(judgeInferenceProcess(sample({ ppid: 1 }), live).verdict).toBe('orphan');
    });

    it('**RSS 가 커도** 고아면 거둔다 — 아무도 안 거두면 메모리를 영원히 붙든다', () => {
      const j = judgeInferenceProcess(sample({ ppid: 1, rssBytes: 13.6e9 }), live);
      expect(j.verdict).toBe('orphan');
    });
  });

  describe('멈춘 로더 — 적재를 끝내지 못한 경우', () => {
    // 실측: RSS 9,296KB(9.3MB) 로 11시간 50분 · 12시간 25분.
    it('유예를 넘겨 RSS 가 바닥이면 멈춘 것으로 본다', () => {
      const j = judgeInferenceProcess(sample({ rssBytes: 9.3e6, elapsedMs: 12 * 3600_000 }), live);
      expect(j.verdict).toBe('stuck-loader');
      expect(j.reason).toContain('720분째');
    });

    it('막 뜬 것은 적재 중이므로 건드리지 않는다', () => {
      const j = judgeInferenceProcess(sample({ rssBytes: 9.3e6, elapsedMs: 30_000 }), live);
      expect(j.verdict).toBe('starting');
    });

    it('유예 경계 — 직전은 starting, 직후는 stuck-loader', () => {
      const at = (elapsedMs: number) =>
        judgeInferenceProcess(sample({ rssBytes: 1e6, elapsedMs }), live).verdict;
      expect(at(STUCK_LOADER_GRACE_MS - 1)).toBe('starting');
      expect(at(STUCK_LOADER_GRACE_MS)).toBe('stuck-loader');
    });

    it('RSS 경계 — 하한 이상이면 적재 성공으로 본다', () => {
      const at = (rssBytes: number) =>
        judgeInferenceProcess(sample({ rssBytes, elapsedMs: 12 * 3600_000 }), live).verdict;
      expect(at(LOADED_RSS_FLOOR_BYTES)).toBe('healthy');
      expect(at(LOADED_RSS_FLOOR_BYTES - 1)).toBe('stuck-loader');
    });
  });
});

describe('selectReapableInferenceProcesses', () => {
  it('오늘 관측된 그대로를 재현한다 — 건강한 1개는 남고 고아 2개만 걸린다', () => {
    // ps 실측(2026-08-06): 31313 RSS 13.6GB 정상 · 41243·42007 RSS 9.3MB 고아.
    // 부모 38528(`ollama serve`)은 재기동으로 사라졌다.
    const reapable = selectReapableInferenceProcesses([
      sample({ pid: 3356, ppid: 2600, rssBytes: 11.9e9, elapsedMs: 27_000 }),
      sample({ pid: 41243, ppid: 38528, rssBytes: 9.3e6, elapsedMs: 11 * 3600_000 }),
      sample({ pid: 42007, ppid: 38528, rssBytes: 9.3e6, elapsedMs: 12 * 3600_000 }),
      sample({ pid: 2600, ppid: 1, rssBytes: 18e6, command: '/opt/homebrew/bin/ollama serve' }),
    ]);
    expect(reapable.map(r => r.pid).sort()).toEqual([41243, 42007]);
  });

  it('정리 대상이 없으면 빈 배열', () => {
    expect(selectReapableInferenceProcesses([sample({ pid: 1, ppid: 1, command: 'node x' })])).toEqual([]);
  });

  it('빈 입력도 안전하다', () => {
    expect(selectReapableInferenceProcesses([])).toEqual([]);
  });
});

describe('judgeOllamaHealth', () => {
  it('큐 만원을 도달 실패와 구분한다 — 조치가 다르다', () => {
    // 이 구분이 없어서 NCO 가 "프로바이더 정상"으로 보고 태스크를 계속 태웠다.
    const jammed = judgeOllamaHealth({
      statusCode: 503,
      body: `{"error":"server busy, please try again.  ${OLLAMA_QUEUE_FULL_MARKER}"}`,
    });
    expect(jammed.verdict).toBe('queue-jammed');
    expect(jammed.dispatchable).toBe(false);

    const down = judgeOllamaHealth({ statusCode: 0, body: '' });
    expect(down.verdict).toBe('unreachable');
    expect(down.dispatchable).toBe(false);
  });

  it('큐 만원은 5xx 일반 오류로 뭉뚱그리지 않는다', () => {
    const generic = judgeOllamaHealth({ statusCode: 503, body: '{"error":"something else"}' });
    expect(generic.verdict).toBe('error');
  });

  it('정상 응답이면 배정 가능', () => {
    const ok = judgeOllamaHealth({ statusCode: 200, body: '{"models":[]}' });
    expect(ok.verdict).toBe('healthy');
    expect(ok.dispatchable).toBe(true);
  });

  it('어떤 판정이든 healthy 가 아니면 배정하지 않는다', () => {
    for (const probe of [
      { statusCode: 0, body: '' },
      { statusCode: 404, body: 'not found' },
      { statusCode: 500, body: 'boom' },
      { statusCode: 503, body: OLLAMA_QUEUE_FULL_MARKER },
    ]) {
      expect(judgeOllamaHealth(probe).dispatchable).toBe(false);
    }
  });
});

describe('judgeModelResidency', () => {
  const NOW = Date.parse('2026-08-06T17:00:00Z');

  it('대상 모델이 올라와 있으면 정상', () => {
    const j = judgeModelResidency('qwen3:30b-a3b', [
      { name: 'qwen3:30b-a3b', sizeBytes: 18.6e9, sizeVramBytes: 18.6e9 },
    ], NOW);
    expect(j).toMatchObject({ loaded: true, pinnedByOther: false, cpuFallback: false });
  });

  it('VRAM 밖으로 밀리면 CPU 폴백으로 표시한다 — 매우 느려진다', () => {
    // kangnote 기기 사례: size 10.1GB · size_vram 0 → 한 문장에 129.7초.
    const j = judgeModelResidency('qwen3:14b', [
      { name: 'qwen3:14b', sizeBytes: 10.1e9, sizeVramBytes: 0 },
    ], NOW);
    expect(j.cpuFallback).toBe(true);
    expect(j.reason).toContain('CPU');
  });

  it('다른 모델이 무기한 고정돼 있으면 그것을 지목한다', () => {
    // 실측: qwen3:14b 가 expires_at 2318-11-17 (keep_alive=-1) 로 11.9GB 점유.
    const j = judgeModelResidency('qwen3:30b-a3b', [
      { name: 'qwen3:14b', sizeBytes: 11.9e9, sizeVramBytes: 11.9e9, expiresAt: '2318-11-17T00:52:31Z' },
    ], NOW);
    expect(j.loaded).toBe(false);
    expect(j.pinnedByOther).toBe(true);
    expect(j.reason).toContain('qwen3:14b');
    expect(j.reason).toContain('무기한');
  });

  it('정상 TTL 로 올라온 다른 모델은 고정으로 보지 않는다 — 곧 비워진다', () => {
    const j = judgeModelResidency('qwen3:30b-a3b', [
      { name: 'qwen3:14b', sizeBytes: 11.9e9, sizeVramBytes: 11.9e9, expiresAt: '2026-08-06T17:05:00Z' },
    ], NOW);
    expect(j.pinnedByOther).toBe(false);
    expect(j.reason).toContain('콜드 적재');
  });

  it('고정 임계는 100년 — 경계 검증', () => {
    const far = new Date(NOW + INDEFINITE_PIN_THRESHOLD_MS + 60_000).toISOString();
    const near = new Date(NOW + INDEFINITE_PIN_THRESHOLD_MS - 60_000).toISOString();
    const at = (expiresAt: string) => judgeModelResidency('target', [
      { name: 'other', sizeBytes: 1, sizeVramBytes: 1, expiresAt },
    ], NOW).pinnedByOther;
    expect(at(far)).toBe(true);
    expect(at(near)).toBe(false);
  });

  it('아무것도 안 올라와 있으면 콜드 적재 필요', () => {
    const j = judgeModelResidency('qwen3:30b-a3b', [], NOW);
    expect(j).toMatchObject({ loaded: false, pinnedByOther: false });
  });

  it('만료 시각이 없거나 깨져 있어도 던지지 않는다', () => {
    expect(() => judgeModelResidency('t', [
      { name: 'o', sizeBytes: 1, sizeVramBytes: 1, expiresAt: 'not-a-date' },
    ], NOW)).not.toThrow();
  });
});
