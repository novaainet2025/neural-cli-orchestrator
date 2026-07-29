import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildOrchestratedCliArgs,
  clearCursorFallbackPreference,
  executeWithCursorModelFallback,
  resolveCursorFallbackModel,
} from './orchestrated-loop.js';

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

  it('does not send the NCO agy-internal routing alias to AGY as a model', () => {
    const args = buildOrchestratedCliArgs(
      { id: 'agy', model: 'agy-internal' },
      [],
      'Reply OK'
    );
    expect(args).not.toContain('--model');
    expect(args.at(-2)).toBe('--print');
    expect(args.at(-1)).toBe('Reply OK');
  });
});

describe('Cursor transient model-provider fallback', () => {
  const providerError = Object.assign(
    new Error(
      "cursor-agent: CLI failed exit=1 — NonRetriableError: Provider Error "
      + "We're having trouble connecting to the model provider. "
      + 'This might be temporary - please try again in a moment.',
    ),
    { output: 'NonRetriableError: Provider Error trouble connecting to the model provider', canceled: false },
  );

  beforeEach(() => {
    clearCursorFallbackPreference();
  });

  it('retries the default Cursor route exactly once with the configured fallback', async () => {
    const attempts: Array<string | undefined> = [];
    const result = await executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerModel: 'cursor',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        attempts.push(model);
        if (attempts.length === 1) throw providerError;
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toEqual([undefined, 'composer-2.5']);
  });

  it('does not loop when the fallback model also fails', async () => {
    const attempts: Array<string | undefined> = [];
    await expect(executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerModel: 'cursor',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        attempts.push(model);
        throw providerError;
      },
    })).rejects.toThrow('NonRetriableError');
    expect(attempts).toEqual([undefined, 'composer-2.5']);
  });

  it('prefers the known-good fallback during the bounded cooling window', async () => {
    const firstAttempts: Array<string | undefined> = [];
    await executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerModel: 'cursor',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        firstAttempts.push(model);
        if (firstAttempts.length === 1) throw providerError;
        return 'recovered';
      },
    });

    const laterAttempts: Array<string | undefined> = [];
    const result = await executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerModel: 'cursor',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        laterAttempts.push(model);
        return 'still healthy';
      },
    });

    expect(result).toBe('still healthy');
    expect(firstAttempts).toEqual([undefined, 'composer-2.5']);
    expect(laterAttempts).toEqual(['composer-2.5']);
  });

  it.each([
    { name: 'explicit task model', requestedModel: 'auto', error: providerError },
    { name: 'explicit provider model', providerModel: 'gpt-5.6-sol-high', error: providerError },
    { name: 'cancelled execution', error: { ...providerError, canceled: true } },
    { name: 'authentication failure', error: new Error('Authentication required. Please run login.') },
    { name: 'quota failure', error: new Error("You've hit your weekly limit") },
  ])('does not fallback for $name', async ({ requestedModel, providerModel, error }) => {
    const attempts: Array<string | undefined> = [];
    await expect(executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerModel: providerModel ?? 'cursor',
      requestedModel,
      fallbackModel: 'composer-2.5',
      execute: async model => {
        attempts.push(model);
        throw error;
      },
    })).rejects.toBe(error);
    expect(attempts).toEqual([requestedModel]);
  });

  it('supports environment override and explicit disable values', () => {
    expect(resolveCursorFallbackModel('cursor-grok-4.5-low')).toBe('cursor-grok-4.5-low');
    expect(resolveCursorFallbackModel('off')).toBeNull();
    expect(resolveCursorFallbackModel(undefined)).toBe('composer-2.5');
  });
});
