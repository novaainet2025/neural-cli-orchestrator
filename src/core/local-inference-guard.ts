/**
 * 로컬 추론 서버(ollama) 위생 가드
 *
 * **왜 필요한가.** 2026-08-06 실측: ollama 태스크가 7일간 96건 성공하다 08-05 04~10시
 * 구간부터 완전히 멈췄고, 24시간 기준 58/58 이 `lease_expired` 로 죽었다. 그런데
 * 프로바이더 자체는 살아 있었다 — 실패 원문이 프로바이더 오류가 아니라 전부 리스 만료였다.
 *
 * 원인은 NCO 밖이었다. `/api/generate` 가 **부하 0에서도 0.18초 만에 503** 을 냈다:
 *   `{"error":"server busy, please try again.  maximum pending requests exceeded"}`
 *
 * 파고 보니 셋이 겹쳐 있었다.
 *   ① `llama-server` 프로세스 2개가 **11시간 50분 · 12시간 25분째 RSS 9MB** — 모델을
 *      끝내 못 올린 채 스케줄러 슬롯만 점유. `ollama serve` 재기동에도 살아남았다.
 *   ② 대상이 아닌 모델(qwen3:14b)이 `expires_at: 2318-11-17`, 즉 `keep_alive=-1` 로
 *      11.9GB 를 무기한 점유.
 *   ③ NCO 가 요청하는 모델(qwen3:30b-a3b, 18.6GB)은 슬롯도 메모리도 못 얻어 요청이
 *      계속 쌓였고, 대기 큐가 상한을 넘겨 이후 모든 요청이 즉시 503.
 *
 * 서비스 재기동 + 고아 정리 후 30b 가 **36.2초에 정상 응답**했다. 즉 모델도 하드웨어도
 * 멀쩡했고 **스케줄러 상태만 꼬여 있었다.** 기기 메모리는 51.5GB 로 여유가 있었다.
 *
 * **NCO 가 이것을 못 알아챘다는 것이 진짜 문제다.** 503 을 받고도 태스크를 계속 밀어넣어
 * 전부 리스 만료로 태웠다. 이 모듈은 그 상태를 **태스크를 태우기 전에** 잡는다.
 *
 * 여기서는 판정만 한다(순수 함수). 실제 종료·차단은 호출부가 결정한다.
 */

/** 모델을 올린 서버라면 최소 이 정도 RSS 는 나온다. 그 아래면 적재에 실패한 것이다. */
export const LOADED_RSS_FLOOR_BYTES = 500 * 1024 * 1024;

/** 이 시간을 넘도록 적재를 못 끝냈으면 정상 기동 중이 아니라 멈춘 것으로 본다. */
export const STUCK_LOADER_GRACE_MS = 10 * 60_000;

/** ollama 스케줄러가 큐 상한을 넘겼을 때 내는 본문. 이 문자열이 판정 기준이다. */
export const OLLAMA_QUEUE_FULL_MARKER = 'maximum pending requests exceeded';

export interface InferenceProcessSample {
  pid: number;
  ppid: number;
  /** Resident set size, 바이트 */
  rssBytes: number;
  /** 프로세스가 살아 있던 시간, 밀리초 */
  elapsedMs: number;
  command: string;
}

export type InferenceProcessVerdict = 'healthy' | 'orphan' | 'stuck-loader' | 'starting';

export interface InferenceProcessJudgement {
  pid: number;
  verdict: InferenceProcessVerdict;
  reason: string;
}

function isLocalInferenceServer(command: string): boolean {
  // ollama 는 모델마다 llama-server 를 띄운다. `ollama serve` 본체는 대상이 아니다.
  return /\bllama-server\b/.test(command);
}

/**
 * 프로세스 하나를 판정한다.
 *
 * 순서가 중요하다. **고아 판정이 먼저다** — 부모가 사라진 프로세스는 RSS 가 크든 작든
 * 아무도 거두지 않으므로 메모리를 붙든 채 영원히 남는다. 실제로 오늘 두 개가
 * `ollama serve` 재기동을 넘겨 살아남았다.
 */
export function judgeInferenceProcess(
  sample: InferenceProcessSample,
  livePids: ReadonlySet<number>,
  now: { graceMs?: number; rssFloorBytes?: number } = {},
): InferenceProcessJudgement {
  const graceMs = now.graceMs ?? STUCK_LOADER_GRACE_MS;
  const rssFloor = now.rssFloorBytes ?? LOADED_RSS_FLOOR_BYTES;

  if (!isLocalInferenceServer(sample.command)) {
    return { pid: sample.pid, verdict: 'healthy', reason: '추론 서버가 아님' };
  }

  const parentGone = sample.ppid <= 1 || !livePids.has(sample.ppid);
  if (parentGone) {
    return {
      pid: sample.pid,
      verdict: 'orphan',
      reason: `부모(${sample.ppid})가 없음 — 아무도 거두지 않는다`,
    };
  }

  if (sample.rssBytes >= rssFloor) {
    return { pid: sample.pid, verdict: 'healthy', reason: `모델 적재됨(RSS ${Math.round(sample.rssBytes / 1e6)}MB)` };
  }

  // RSS 가 낮아도 방금 뜬 것이면 적재 중일 수 있다. 유예 안에서는 건드리지 않는다.
  if (sample.elapsedMs < graceMs) {
    return { pid: sample.pid, verdict: 'starting', reason: `적재 중(${Math.round(sample.elapsedMs / 1000)}초 경과)` };
  }

  return {
    pid: sample.pid,
    verdict: 'stuck-loader',
    reason: `${Math.round(sample.elapsedMs / 60_000)}분째 RSS ${Math.round(sample.rssBytes / 1e6)}MB — 적재 실패 후 슬롯만 점유`,
  };
}

export function selectReapableInferenceProcesses(
  samples: readonly InferenceProcessSample[],
  options: { graceMs?: number; rssFloorBytes?: number } = {},
): InferenceProcessJudgement[] {
  const livePids = new Set(samples.map(s => s.pid));
  return samples
    .map(sample => judgeInferenceProcess(sample, livePids, options))
    .filter(j => j.verdict === 'orphan' || j.verdict === 'stuck-loader');
}

export interface OllamaProbeResult {
  /** HTTP 상태 코드. 도달 실패면 0 */
  statusCode: number;
  /** 응답 본문 (앞부분이면 충분하다) */
  body: string;
}

export type OllamaHealthVerdict = 'healthy' | 'queue-jammed' | 'unreachable' | 'error';

export interface OllamaHealthJudgement {
  verdict: OllamaHealthVerdict;
  /** 태스크를 배정해도 되는가 */
  dispatchable: boolean;
  reason: string;
}

/**
 * ollama 응답으로 배정 가능 여부를 판정한다.
 *
 * **핵심은 503 큐 만원을 `unreachable` 과 구분하는 것이다.** 둘 다 배정 불가지만 조치가
 * 다르다 — 도달 실패는 서비스가 죽은 것이고, 큐 만원은 **살아 있는데 스케줄러가 꼬인 것**
 * 이라 고아·멈춘 로더를 거둬야 풀린다. 오늘 사고가 정확히 후자였고, 구분이 없어서
 * NCO 가 "프로바이더 정상"으로 보고 태스크를 계속 밀어넣었다.
 */
export function judgeOllamaHealth(probe: OllamaProbeResult): OllamaHealthJudgement {
  if (probe.statusCode === 0) {
    return { verdict: 'unreachable', dispatchable: false, reason: 'ollama 에 도달할 수 없음' };
  }
  if (probe.body.includes(OLLAMA_QUEUE_FULL_MARKER)) {
    return {
      verdict: 'queue-jammed',
      dispatchable: false,
      reason: '스케줄러 대기 큐가 만원 — 고아·멈춘 로더 정리가 필요하다',
    };
  }
  if (probe.statusCode >= 500) {
    return { verdict: 'error', dispatchable: false, reason: `ollama 5xx (${probe.statusCode})` };
  }
  if (probe.statusCode >= 400) {
    return { verdict: 'error', dispatchable: false, reason: `ollama 4xx (${probe.statusCode})` };
  }
  return { verdict: 'healthy', dispatchable: true, reason: 'ollama 정상' };
}

/**
 * 대상 모델이 실제로 올라와 있는지 본다.
 *
 * `/api/ps` 에 다른 모델만 있으면 **요청 모델은 콜드 적재**를 해야 한다. 오늘처럼 다른
 * 모델이 `keep_alive=-1` 로 고정돼 있으면 그 적재가 영영 끝나지 않는다.
 */
export interface LoadedModel {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  expiresAt?: string;
}

export interface ModelResidencyJudgement {
  loaded: boolean;
  /** 다른 모델이 무기한 고정돼 있는가 */
  pinnedByOther: boolean;
  cpuFallback: boolean;
  reason: string;
}

/** `keep_alive=-1` 은 사실상 무한대 만료 시각으로 나타난다. 100년이면 충분히 판정된다. */
export const INDEFINITE_PIN_THRESHOLD_MS = 100 * 365 * 24 * 3600_000;

export function judgeModelResidency(
  targetModel: string,
  loaded: readonly LoadedModel[],
  nowMs: number,
): ModelResidencyJudgement {
  const target = loaded.find(m => m.name === targetModel);
  if (target) {
    const cpuFallback = target.sizeVramBytes < target.sizeBytes;
    return {
      loaded: true,
      pinnedByOther: false,
      cpuFallback,
      reason: cpuFallback
        ? `${targetModel} 적재됨 — 다만 VRAM 밖으로 밀려 CPU 추론 중이라 매우 느리다`
        : `${targetModel} 적재됨`,
    };
  }

  const pinned = loaded.filter(m => {
    if (!m.expiresAt) return false;
    const at = Date.parse(m.expiresAt);
    return Number.isFinite(at) && at - nowMs > INDEFINITE_PIN_THRESHOLD_MS;
  });

  if (pinned.length > 0) {
    return {
      loaded: false,
      pinnedByOther: true,
      cpuFallback: false,
      reason: `${targetModel} 미적재 · ${pinned.map(m => m.name).join(', ')} 가 무기한 고정돼 자리를 못 얻는다`,
    };
  }

  return {
    loaded: false,
    pinnedByOther: false,
    cpuFallback: false,
    reason: `${targetModel} 미적재 — 콜드 적재가 필요하다`,
  };
}
