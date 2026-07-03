import { describe, it, expect } from 'vitest';
import {
  makeDelegationPayloadSchema,
  validateDelegationPayload,
} from './delegation-payload.js';

const KNOWN = ['claude-code', 'codex', 'opencode', 'ollama'];

describe('makeDelegationPayloadSchema', () => {
  it('accepts a payload whose ai is a known agent and applies defaults', () => {
    const schema = makeDelegationPayloadSchema(KNOWN);
    const parsed = schema.safeParse({ ai: 'codex', prompt: 'do the thing' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ai).toBe('codex');
      expect(parsed.data.mode).toBe('task');
      expect(parsed.data.workspaceId).toBe('default');
      expect(parsed.data.priority).toBe(0);
    }
  });

  it('rejects an unknown agent with a clear message naming it and the known set', () => {
    const schema = makeDelegationPayloadSchema(KNOWN);
    const parsed = schema.safeParse({ ai: 'gpt-5', prompt: 'hello' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join(' | ');
      expect(msg).toContain("Unknown agent 'gpt-5'");
      expect(msg).toContain('Known: claude-code, codex, opencode, ollama');
    }
  });

  it('throws when knownAgentIds is empty (a schema that accepts nothing is a bug)', () => {
    expect(() => makeDelegationPayloadSchema([])).toThrow(/non-empty/);
  });
});

describe('validateDelegationPayload', () => {
  it('blocks an unknown agent at intake with ok:false (no runtime deferral)', () => {
    const result = validateDelegationPayload(
      { ai: 'aider', prompt: 'refactor' },
      KNOWN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown agent 'aider'");
      expect(result.error).toContain('ai:');
    }
  });

  it('accepts a valid delegation and returns typed data with defaults', () => {
    const result = validateDelegationPayload(
      { ai: 'ollama', prompt: 'verify output', mode: 'parallel', priority: 5 },
      KNOWN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ai).toBe('ollama');
      expect(result.data.mode).toBe('parallel');
      expect(result.data.priority).toBe(5);
      expect(result.data.workspaceId).toBe('default');
    }
  });

  it('rejects a missing/empty prompt', () => {
    const missing = validateDelegationPayload({ ai: 'codex' }, KNOWN);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('prompt');

    const empty = validateDelegationPayload({ ai: 'codex', prompt: '' }, KNOWN);
    expect(empty.ok).toBe(false);
  });

  it('rejects a missing ai field (delegation must name a target)', () => {
    const result = validateDelegationPayload({ prompt: 'no target' }, KNOWN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ai');
  });

  it('is deterministic: same input yields the same result', () => {
    const input = { ai: 'zzz', prompt: 'x' };
    const a = validateDelegationPayload(input, KNOWN);
    const b = validateDelegationPayload(input, KNOWN);
    expect(a).toEqual(b);
  });
});
