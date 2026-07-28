import { describe, expect, it } from 'vitest';
import { buildOrchestratedCliArgs } from './orchestrated-loop.js';

describe('task model override CLI propagation', () => {
  it.each([
    ['codex', 'gpt-5.6-sol', '-m'],
    ['opencode', 'openrouter/~anthropic/claude-sonnet-latest', '-m'],
    ['cursor-agent', 'gpt-5.6-sol-high', '--model'],
    ['agy', 'gemini-3.6-flash-high', '--model'],
    ['hermes', 'gpt-5.6-terra', '-m']
  ])('%s forwards %s through %s', (id, model, flag) => {
    const args = buildOrchestratedCliArgs(
      { id, model: id },
      [],
      'Reply OK',
      null,
      model
    );
    expect(args).toContain(flag);
    expect(args[args.indexOf(flag) + 1]).toBe(model);
    expect(args.at(-1)).toBe('Reply OK');
  });

  it('does not send routing aliases as literal model names', () => {
    expect(buildOrchestratedCliArgs(
      { id: 'cursor-agent', model: 'cursor' },
      [],
      'Reply OK'
    )).not.toContain('--model');
  });
});
