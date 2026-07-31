import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  evaluateInvocation,
  hasAiAncestor,
  isReadOnlyInvocation,
} = require('../../scripts/pm2-ai-mutation-guard.cjs') as {
  evaluateInvocation: (
    argv: string[],
    chain: Array<{ pid: number; ppid: number; command: string }>,
  ) => { allowed: boolean; reason: string; exitCode?: number };
  hasAiAncestor: (chain: Array<{ command: string }>) => boolean;
  isReadOnlyInvocation: (argv: string[]) => boolean;
};

const codexChain = [
  { pid: 100, ppid: 99, command: '/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox' },
  { pid: 99, ppid: 1, command: '/bin/zsh -l' },
];
const humanChain = [
  { pid: 200, ppid: 1, command: '/bin/zsh -l' },
];

describe('PM2 AI mutation guard', () => {
  it.each([
    { argv: [] },
    { argv: ['jlist'] },
    { argv: ['describe', 'nco-backend'] },
    { argv: ['--silent', 'status'] },
    { argv: ['--version'] },
  ])('recognizes read-only invocation $argv', ({ argv }) => {
    expect(isReadOnlyInvocation(argv)).toBe(true);
  });

  it.each([
    { argv: ['restart', 'nco-backend'] },
    { argv: ['--silent', 'restart', 'nco-backend'] },
    { argv: ['sendSignal', 'SIGINT', 'nco-backend'] },
    { argv: ['startOrReload', 'ecosystem.config.cjs'] },
    { argv: ['trigger', 'nco-backend', 'action'] },
  ])('recognizes mutating invocation $argv', ({ argv }) => {
    expect(isReadOnlyInvocation(argv)).toBe(false);
  });

  it('detects supported AI CLI ancestors', () => {
    expect(hasAiAncestor(codexChain)).toBe(true);
    expect(hasAiAncestor([{ command: 'opencode run --format json' }])).toBe(true);
    expect(hasAiAncestor(humanChain)).toBe(false);
  });

  it('denies AI mutations without an environment-variable override', () => {
    expect(evaluateInvocation(['restart', 'nco-backend'], codexChain)).toEqual({
      allowed: false,
      reason: 'ai_caller_pm2_mutation',
      exitCode: 77,
    });
  });

  it('allows the same mutation from a human-owned terminal', () => {
    expect(evaluateInvocation(['restart', 'nco-backend'], humanChain)).toEqual({
      allowed: true,
      reason: 'human_owned_terminal',
    });
  });

  it('always allows read-only inspection', () => {
    expect(evaluateInvocation(['jlist'], codexChain)).toEqual({
      allowed: true,
      reason: 'read_only',
    });
  });
});
