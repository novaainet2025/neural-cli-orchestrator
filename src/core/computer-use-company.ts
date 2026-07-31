import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROVIDER = 'codex';
const LEASE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const DEFAULT_WAIT_MS = 5 * 60_000;
const MAX_METADATA_BYTES = 16 * 1024;

interface RuntimeMetadata {
  pid: number;
  endpoint: string;
  authToken: string;
}

interface RuntimeEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

export interface ComputerUseRuntimeStatus {
  ownerRunId: string | null;
  provider: typeof PROVIDER;
  expiresAt: number | null;
  enabled: boolean;
  appliedProviders: string[];
  verified: boolean;
}

export interface ComputerUseLease {
  release(): Promise<void>;
}

export interface AcquireComputerUseOptions {
  waitMs?: number;
  onWaiting?: (ownerRunId: string | null) => void;
  onHeartbeatError?: (error: Error) => void;
  callRuntime?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

function runtimeMetadataPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'nova-use', 'nova-runtime.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error('APPDATA is unavailable');
    return join(appData, 'nova-use', 'nova-runtime.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nova-use', 'nova-runtime.json');
}

function parseRuntimeMetadataFile(path: string, info: { isFile(): boolean; size: number; mode: number }): RuntimeMetadata {
  if (!info.isFile() || info.size <= 0 || info.size > MAX_METADATA_BYTES) {
    throw new Error('nova-use runtime metadata is invalid');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('nova-use runtime metadata permissions are unsafe');
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeMetadata>;
  const pid = raw.pid;
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) throw new Error('nova-use runtime pid is invalid');
  if (typeof raw.authToken !== 'string' || raw.authToken.length < 32) throw new Error('nova-use runtime token is invalid');
  if (typeof raw.endpoint !== 'string') throw new Error('nova-use runtime endpoint is invalid');
  const endpoint = new URL(raw.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('nova-use runtime endpoint must be loopback');
  }
  try { process.kill(pid!, 0); } catch { throw new Error('nova-use runtime is not running'); }
  return raw as RuntimeMetadata;
}

async function loadRuntimeMetadata(): Promise<RuntimeMetadata> {
  const path = runtimeMetadataPath();
  const info = await stat(path);
  return parseRuntimeMetadataFile(path, info);
}

/** Sync variant for team-runner T1 context injection (buildTeamDataContext is synchronous). */
export function probeComputerUseRuntimeSync(): ComputerUseObservability['runtime'] {
  try {
    const path = runtimeMetadataPath();
    const runtime = parseRuntimeMetadataFile(path, statSync(path));
    const endpointHost = new URL(runtime.endpoint).hostname;
    return { available: true, pid: runtime.pid, endpointHost };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ComputerUseObservability {
  runtime: {
    available: boolean;
    pid?: number;
    endpointHost?: string;
    error?: string;
  };
  policy: {
    provider: typeof PROVIDER;
    leaseMs: number;
    heartbeatMs: number;
    maxWaitMs: number;
  };
  timestamp: string;
}

/** Read-only probe: nova-use runtime metadata without acquiring the control lease. */
export async function probeComputerUseRuntime(): Promise<ComputerUseObservability['runtime']> {
  try {
    const runtime = await loadRuntimeMetadata();
    const endpointHost = new URL(runtime.endpoint).hostname;
    return { available: true, pid: runtime.pid, endpointHost };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildComputerUseObservability(
  runtime: ComputerUseObservability['runtime'],
): ComputerUseObservability {
  return {
    runtime,
    policy: {
      provider: PROVIDER,
      leaseMs: LEASE_MS,
      heartbeatMs: HEARTBEAT_MS,
      maxWaitMs: Number(process.env.NCO_COMPUTER_USE_WAIT_MS || DEFAULT_WAIT_MS),
    },
    timestamp: new Date().toISOString(),
  };
}

export async function callNovaRuntime<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const runtime = await loadRuntimeMetadata();
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `nco-${Date.now()}`,
      authToken: runtime.authToken,
      method,
      params,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const envelope = await response.json() as RuntimeEnvelope<T>;
  if (!response.ok || envelope.ok !== true) {
    throw new Error(envelope.error?.message || `nova-use runtime RPC failed (${response.status})`);
  }
  return envelope.result as T;
}

function assertExclusiveCodex(status: ComputerUseRuntimeStatus): void {
  if (
    status.provider !== PROVIDER
    || !status.enabled
    || !status.verified
    || status.appliedProviders.length !== 1
    || status.appliedProviders[0] !== PROVIDER
  ) {
    throw new Error('Computer Use activation failed closed: Codex-only state was not confirmed');
  }
}

function busyOwner(error: unknown): string | null | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/PC_CONTROL_BUSY:([^\s]+)/);
  return match ? match[1] : undefined;
}

export async function acquireComputerUseLease(
  runId: string,
  options: AcquireComputerUseOptions = {},
): Promise<ComputerUseLease> {
  const call = options.callRuntime ?? callNovaRuntime;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = options.waitMs ?? Number(process.env.NCO_COMPUTER_USE_WAIT_MS || DEFAULT_WAIT_MS);
  const deadline = Date.now() + Math.max(0, waitMs);
  let status: ComputerUseRuntimeStatus;

  while (true) {
    try {
      status = await call('hub.computerUse.acquire', {
        runId,
        provider: PROVIDER,
        leaseMs: LEASE_MS,
      }) as ComputerUseRuntimeStatus;
      break;
    } catch (error) {
      const owner = busyOwner(error);
      if (owner === undefined) throw error;
      options.onWaiting?.(owner);
      if (Date.now() >= deadline) {
        throw new Error(`Computer Use 대기 시간 초과: 실행 ${owner ?? 'unknown'}이(가) 제어 중`);
      }
      await pause(1_000);
    }
  }
  assertExclusiveCodex(status);

  let closed = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = (): void => {
    if (closed || heartbeatInFlight) return;
    heartbeatInFlight = call('hub.computerUse.heartbeat', {
      runId,
      leaseMs: LEASE_MS,
    }).then((value) => assertExclusiveCodex(value as ComputerUseRuntimeStatus)).catch((error: unknown) => {
      options.onHeartbeatError?.(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { heartbeatInFlight = undefined; });
  };
  const timer = setInterval(heartbeat, HEARTBEAT_MS);
  timer.unref?.();

  return {
    async release(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await heartbeatInFlight;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const released = await call('hub.computerUse.release', { runId }) as ComputerUseRuntimeStatus;
          if (released.enabled || released.appliedProviders.length > 0) {
            throw new Error('Computer Use release was not confirmed');
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await pause(250);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}
