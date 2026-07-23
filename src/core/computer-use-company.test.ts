import { describe, expect, it, vi } from 'vitest';
import {
  acquireComputerUseLease,
  type ComputerUseRuntimeStatus,
} from './computer-use-company.js';

function status(overrides: Partial<ComputerUseRuntimeStatus> = {}): ComputerUseRuntimeStatus {
  return {
    ownerRunId: 'run-a',
    provider: 'codex',
    expiresAt: Date.now() + 30_000,
    enabled: true,
    appliedProviders: ['codex'],
    verified: true,
    ...overrides,
  };
}

describe('Computer Use company lease', () => {
  it('기존 제어자가 있으면 보고·대기한 뒤 Codex 단독 제어권을 얻고 종료 시 회수', async () => {
    let acquireCalls = 0;
    const methods: string[] = [];
    const callRuntime = vi.fn(async (method: string): Promise<unknown> => {
      methods.push(method);
      if (method === 'hub.computerUse.acquire' && acquireCalls++ === 0) {
        throw new Error('PC_CONTROL_BUSY:run-existing');
      }
      if (method === 'hub.computerUse.release') {
        return status({ ownerRunId: null, expiresAt: null, enabled: false, appliedProviders: [], verified: false });
      }
      return status();
    });
    const onWaiting = vi.fn();

    const lease = await acquireComputerUseLease('run-a', {
      callRuntime,
      onWaiting,
      sleep: async () => undefined,
      waitMs: 5_000,
    });
    expect(onWaiting).toHaveBeenCalledWith('run-existing');
    expect(methods.slice(0, 2)).toEqual(['hub.computerUse.acquire', 'hub.computerUse.acquire']);

    await lease.release();
    expect(methods.at(-1)).toBe('hub.computerUse.release');
  });

  it('Codex 외 프로바이더가 함께 적용된 응답은 fail-closed로 거부', async () => {
    const callRuntime = vi.fn(async (): Promise<unknown> =>
      status({ appliedProviders: ['codex', 'claude'] }));

    await expect(acquireComputerUseLease('run-a', { callRuntime }))
      .rejects.toThrow('Codex-only state was not confirmed');
  });

  it('회수 확인 실패 시 세 번 재시도하고 오류를 반환', async () => {
    const callRuntime = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'hub.computerUse.release') throw new Error('runtime unavailable');
      return status();
    });
    const lease = await acquireComputerUseLease('run-a', {
      callRuntime,
      sleep: async () => undefined,
    });

    await expect(lease.release()).rejects.toThrow('runtime unavailable');
    expect(callRuntime.mock.calls.filter(([method]) => method === 'hub.computerUse.release')).toHaveLength(3);
  });
});
