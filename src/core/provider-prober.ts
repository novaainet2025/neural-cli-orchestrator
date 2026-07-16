import { randomUUID } from 'node:crypto';
import { agentManager } from '../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { getRedis, isRedisConnected } from '../storage/redis.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('provider-prober');
const PROBE_TIMEOUT_MS = 30_000;
const LOCK_TTL_MS = 60_000;
// 과금 방어(agy 리뷰 반영): 유료 프로바이더는 프로브 간격을 길게 시작하고,
// 실패할 때마다 지수 백오프(×2, 상한 60분). 무료/로컬은 2분 시작.
const PAID_INITIAL_GAP_MS = 10 * 60_000;
const FREE_INITIAL_GAP_MS = 2 * 60_000;
const MAX_GAP_MS = 60 * 60_000;

interface LocalLock {
  token: string;
  expiresAt: number;
}

interface ProbeLock {
  release(): Promise<void>;
}

export class ProviderProber {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleRunning = false;
  private readonly localLocks = new Map<string, LocalLock>();
  // agentId → {nextAt, gapMs}: 프로브 스케줄(백오프) 상태. 서킷 reset 시 자동 소거.
  private readonly probeSchedule = new Map<string, { nextAt: number; gapMs: number }>();

  start(intervalMs = 120_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runCycle(), intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;

    try {
      const enabledIds = agentManager.listEnabledIds();
      const now = Date.now();
      const targets = circuitBreakerRegistry
        .listSnapshots(enabledIds)
        .filter(snapshot => snapshot.state === 'open' && snapshot.reason !== 'auth')
        .filter(snapshot => this.dueForProbe(snapshot.agentId, now));

      // 닫힌(회복된) 서킷의 백오프 상태 정리
      const openIds = new Set(
        circuitBreakerRegistry.listSnapshots(enabledIds)
          .filter(s => s.state === 'open')
          .map(s => s.agentId),
      );
      for (const agentId of this.probeSchedule.keys()) {
        if (!openIds.has(agentId)) this.probeSchedule.delete(agentId);
      }

      await Promise.all(targets.map(snapshot => this.probeOpenProvider(snapshot.agentId)));
    } catch (error) {
      log.warn({ error }, 'Provider probe cycle failed');
    } finally {
      this.cycleRunning = false;
    }
  }

  private async probeOpenProvider(agentId: string): Promise<void> {
    const lock = await this.acquireLock(agentId);
    if (!lock) return;

    try {
      const recovered = await agentManager.probeProvider(agentId, 'PING', PROBE_TIMEOUT_MS);

      if (!recovered) {
        this.recordProbeFailure(agentId);
        return;
      }

      this.probeSchedule.delete(agentId);
      circuitBreakerRegistry.reset(agentId);
      log.info({ agentId }, 'Active provider probe succeeded; circuit reset');
    } catch (error) {
      this.recordProbeFailure(agentId);
      log.debug({ agentId, error }, 'Active provider probe failed');
    } finally {
      await lock.release();
    }
  }

  /** 백오프 스케줄상 프로브 시점이 됐는지. 최초 관측 시 비용 등급별 초기 지연을 부여한다. */
  private dueForProbe(agentId: string, now: number): boolean {
    const entry = this.probeSchedule.get(agentId);
    if (!entry) {
      const isPaid = agentManager.getProvider(agentId)?.cost === 'paid';
      const gapMs = isPaid ? PAID_INITIAL_GAP_MS : FREE_INITIAL_GAP_MS;
      // 무료/로컬은 첫 사이클에 즉시 프로브(빠른 회복), 유료는 초기 지연으로 과금 방어.
      this.probeSchedule.set(agentId, { nextAt: isPaid ? now + gapMs : now, gapMs });
      return !isPaid;
    }
    return now >= entry.nextAt;
  }

  /** 프로브 실패 시 간격을 2배(상한 60분)로 늘린다. */
  private recordProbeFailure(agentId: string): void {
    const entry = this.probeSchedule.get(agentId);
    const gapMs = Math.min((entry?.gapMs ?? FREE_INITIAL_GAP_MS) * 2, MAX_GAP_MS);
    this.probeSchedule.set(agentId, { nextAt: Date.now() + gapMs, gapMs });
  }

  private async acquireLock(agentId: string): Promise<ProbeLock | null> {
    const key = `nco:probe:${agentId}`;
    const token = randomUUID();

    if (isRedisConnected()) {
      try {
        const redis = await getRedis();
        const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
        if (acquired !== 'OK') return null;

        return {
          release: async () => {
            await redis.eval(
              `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                  return redis.call('DEL', KEYS[1])
                end
                return 0
              `,
              1,
              key,
              token,
            );
          },
        };
      } catch (error) {
        log.warn({ agentId, error }, 'Redis probe lock unavailable; using local lock');
      }
    }

    const now = Date.now();
    const existing = this.localLocks.get(agentId);
    if (existing && existing.expiresAt > now) return null;
    this.localLocks.set(agentId, { token, expiresAt: now + LOCK_TTL_MS });

    return {
      release: async () => {
        if (this.localLocks.get(agentId)?.token === token) {
          this.localLocks.delete(agentId);
        }
      },
    };
  }
}

export const providerProber = new ProviderProber();
