/**
 * 로컬 추론 서버 위생 — 수집·정리·주기 실행
 *
 * 판정 규칙은 [[local-inference-guard]] 에 있고 여기는 부작용만 담당한다.
 * 분리한 이유는 판정을 프로세스·네트워크 없이 테스트하기 위해서다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import {
  judgeOllamaHealth,
  judgeModelResidency,
  selectReapableInferenceProcesses,
  type InferenceProcessSample,
  type InferenceProcessJudgement,
  type OllamaHealthJudgement,
  type ModelResidencyJudgement,
  type LoadedModel,
} from './local-inference-guard.js';

const execFileAsync = promisify(execFile);
const log = createLogger('local-inference-hygiene');

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const DISABLED = new Set(['0', 'false', 'off']);

export function isLocalInferenceHygieneEnabled(
  toggle: string | undefined = process.env.NCO_LOCAL_INFERENCE_HYGIENE,
): boolean {
  return !DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

export function resolveOllamaBaseUrl(
  configured: string | undefined = process.env.NCO_OLLAMA_BASE_URL,
): string {
  return (configured?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

/**
 * `ps` 의 ELAPSED 표기를 밀리초로 바꾼다. 형식은 `[[dd-]hh:]mm:ss` 다.
 *
 * 오늘 실측값이 `11:50:32`(11시간 50분)과 `01-00:18:36`(1일 18분)이었다. 이 둘을 못
 * 가르면 하루 넘게 멈춘 프로세스를 11분짜리로 읽어 유예 안이라고 판단해 버린다.
 */
export function parseElapsedMs(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const [daysPart, clockPart] = text.includes('-') ? text.split('-', 2) : [null, text];
  const days = daysPart === null ? 0 : Number(daysPart);
  if (!Number.isFinite(days)) return null;

  const parts = clockPart.split(':').map(Number);
  if (parts.some(p => !Number.isFinite(p))) return null;

  let seconds: number;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;

  return (days * 86_400 + seconds) * 1000;
}

/** `ps -eo pid=,ppid=,rss=,etime=,command=` 한 줄을 표본으로 바꾼다. RSS 는 KiB 단위다. */
export function parsePsLine(line: string): InferenceProcessSample | null {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  const elapsedMs = parseElapsedMs(m[4]);
  if (elapsedMs === null) return null;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    rssBytes: Number(m[3]) * 1024,
    elapsedMs,
    command: m[5],
  };
}

export async function sampleInferenceProcesses(): Promise<InferenceProcessSample[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss=,etime=,command='], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split('\n').map(parsePsLine).filter((s): s is InferenceProcessSample => s !== null);
  } catch (err) {
    log.warn({ err }, 'ps 수집 실패 — 이번 주기는 건너뛴다');
    return [];
  }
}

export async function probeOllamaHealth(baseUrl = resolveOllamaBaseUrl()): Promise<OllamaHealthJudgement> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await res.text()).slice(0, 500);
    return judgeOllamaHealth({ statusCode: res.status, body });
  } catch {
    return judgeOllamaHealth({ statusCode: 0, body: '' });
  }
}

export async function readLoadedModels(baseUrl = resolveOllamaBaseUrl()): Promise<LoadedModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<Record<string, unknown>> };
    return (data.models ?? []).map(m => ({
      name: String(m['name'] ?? ''),
      sizeBytes: Number(m['size'] ?? 0),
      sizeVramBytes: Number(m['size_vram'] ?? 0),
      expiresAt: typeof m['expires_at'] === 'string' ? m['expires_at'] : undefined,
    }));
  } catch {
    return [];
  }
}

export interface LocalInferenceHygieneResult {
  mode: 'dry-run' | 'apply';
  health: OllamaHealthJudgement;
  residency: ModelResidencyJudgement | null;
  candidates: InferenceProcessJudgement[];
  reaped: number[];
  failedToReap: number[];
}

/**
 * 한 주기를 돈다.
 *
 * **기본은 dry-run 이다.** 프로세스를 죽이는 일이라 자동 적용은 명시적으로 켜야 한다
 * (`NCO_LOCAL_INFERENCE_REAP=1`). 판정과 로그는 항상 남으므로 켜지 않아도 진단은 된다.
 */
export async function runLocalInferenceHygiene(options: {
  mode?: 'dry-run' | 'apply';
  targetModel?: string;
  baseUrl?: string;
} = {}): Promise<LocalInferenceHygieneResult> {
  const mode = options.mode ?? 'dry-run';
  const baseUrl = options.baseUrl ?? resolveOllamaBaseUrl();

  const [samples, health, loaded] = await Promise.all([
    sampleInferenceProcesses(),
    probeOllamaHealth(baseUrl),
    readLoadedModels(baseUrl),
  ]);

  const residency = options.targetModel
    ? judgeModelResidency(options.targetModel, loaded, Date.now())
    : null;

  const candidates = selectReapableInferenceProcesses(samples);
  const reaped: number[] = [];
  const failedToReap: number[] = [];

  if (mode === 'apply') {
    for (const candidate of candidates) {
      try {
        process.kill(candidate.pid, 'SIGTERM');
        reaped.push(candidate.pid);
        log.warn({ pid: candidate.pid, verdict: candidate.verdict, reason: candidate.reason },
          '멈춘 추론 서버를 정리했다');
      } catch (err) {
        failedToReap.push(candidate.pid);
        log.warn({ pid: candidate.pid, err }, '추론 서버 정리 실패');
      }
    }
  }

  if (!health.dispatchable) {
    log.error({ verdict: health.verdict, reason: health.reason, candidates: candidates.length },
      'ollama 에 태스크를 배정할 수 없는 상태');
  }
  if (residency?.pinnedByOther) {
    log.warn({ reason: residency.reason }, '대상 모델이 다른 모델에 밀려 적재되지 못한다');
  }

  return { mode, health, residency, candidates, reaped, failedToReap };
}

let timer: NodeJS.Timeout | null = null;

export function startLocalInferenceHygiene(options: {
  intervalMs?: number;
  targetModel?: string;
} = {}): void {
  if (timer || !isLocalInferenceHygieneEnabled()) return;
  const configuredInterval = Number(process.env.NCO_LOCAL_INFERENCE_HYGIENE_INTERVAL_MS);
  const intervalMs = options.intervalMs
    ?? (Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : DEFAULT_INTERVAL_MS);
  const mode = DISABLED.has((process.env.NCO_LOCAL_INFERENCE_REAP ?? '0').trim().toLowerCase())
    ? 'dry-run' as const
    : 'apply' as const;

  timer = setInterval(() => {
    void runLocalInferenceHygiene({ mode, targetModel: options.targetModel })
      .catch(err => log.warn({ err }, '추론 위생 주기 실패'));
  }, intervalMs);
  timer.unref?.();
  log.info({ intervalMs, mode }, '로컬 추론 위생 감시 시작');
}

export function stopLocalInferenceHygiene(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
