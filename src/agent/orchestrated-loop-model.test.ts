import { beforeEach, describe, expect, it } from 'vitest';
import { classifyCircuitError } from '../security/circuit-breaker-registry.js';
import {
  buildOrchestratedCliArgs,
  clearCursorFallbackPreference,
  executeWithCursorModelFallback,
  extractCodexJsonlAgentText,
  preferDiagnosticSummary,
  MAX_ORCHESTRATED_HISTORY_CHARS,
  resolveCursorFallbackModel,
  trimOrchestratedConversationHistory,
} from './orchestrated-loop.js';
import { parseToolCalls } from './tool-parser.js';

describe('Codex JSONL assistant text recovery', () => {
  it('returns the last non-empty agent message when an empty message follows XML', () => {
    const toolCall = '<nco-tool name="readFile"><arg name="path">/tmp/project/package.json</arg></nco-tool>';
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: toolCall },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-2', type: 'agent_message', text: '' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');

    const recovered = extractCodexJsonlAgentText(stdout);
    expect(recovered).toBe(toolCall);
    expect(parseToolCalls(recovered!)).toEqual([{
      tool: 'readFile',
      args: { path: '/tmp/project/package.json' },
    }]);
  });

  it('leaves formatted stdout and OpenCode JSON events to their existing paths', () => {
    expect(extractCodexJsonlAgentText('plain formatted response')).toBeUndefined();
    expect(extractCodexJsonlAgentText(JSON.stringify({
      type: 'text',
      part: { text: 'OpenCode response' },
    }))).toBeUndefined();
  });
});

describe('orchestrated conversation history', () => {
  it('retains six capped tool-result pages needed for a multi-file review', () => {
    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'original task' },
    ];
    for (let index = 0; index < 6; index++) {
      history.push({ role: 'assistant', content: `<tool_call>${index}</tool_call>` });
      history.push({ role: 'user', content: `Tool results:\n${String(index).repeat(8_000)}` });
    }

    trimOrchestratedConversationHistory(history);

    expect(history).toHaveLength(13);
    expect(history[0]?.content).toBe('original task');
    expect(history.some(message => message.content.includes('0'.repeat(100)))).toBe(true);
    expect(MAX_ORCHESTRATED_HISTORY_CHARS).toBeGreaterThan(48_000);
  });

  it('drops complete oldest pairs when the bounded context is exceeded', () => {
    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'original task' },
    ];
    for (let index = 0; index < 12; index++) {
      history.push({ role: 'assistant', content: `call-${index}` });
      history.push({ role: 'user', content: `result-${index}` });
    }

    trimOrchestratedConversationHistory(history, 3, 1_000);

    expect(history.map(message => message.content)).toEqual([
      'original task',
      'call-9', 'result-9',
      'call-10', 'result-10',
      'call-11', 'result-11',
    ]);
  });
});

describe('task model override CLI propagation', () => {
  it.each([
    [{ id: 'codex', model: 'codex' }, 'gpt-5.6-sol', '-m'],
    [{ id: 'opencode', model: 'opencode' }, 'openrouter/~anthropic/claude-sonnet-latest', '-m'],
    [{ id: 'cursor-agent', model: 'cursor-agent' }, 'gpt-5.6-sol-high', '--model'],
    [{ id: 'agy', model: 'agy' }, 'gemini-3.6-flash-high', '--model'],
    [{
      id: 'hermes', model: 'hermes', command: 'codex',
      runtime: {
        executor: 'orchestrated-cli' as const,
        adapter: 'codex' as const,
        profile: 'readonly-tool-worker' as const,
        promptTransport: 'argv' as const,
      },
    }, 'gpt-5.6-terra', '-m'],
  ])('$0.id forwards $1 through $2', (provider, model, flag) => {
    const args = buildOrchestratedCliArgs(
      provider,
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
    const args = buildOrchestratedCliArgs(
      {
        id: 'cursor-agent',
        model: 'custom-routing-alias',
        runtime: {
          executor: 'orchestrated-cli',
          adapter: 'cursor',
          promptTransport: 'argv',
          modelTransport: 'override-only',
        },
      },
      [],
      'Reply OK'
    );
    expect(args).not.toContain('--model');
    expect(args).toEqual(expect.arrayContaining([
      '--auto-review',
      '--sandbox',
      'enabled',
    ]));
  });

  it('does not send the NCO agy-internal routing alias to AGY as a model', () => {
    const args = buildOrchestratedCliArgs(
      {
        id: 'agy',
        model: 'agy-internal',
        runtime: {
          executor: 'orchestrated-cli',
          adapter: 'agy',
          promptTransport: 'argv',
          modelTransport: 'override-only',
        },
      },
      [],
      'Reply OK'
    );
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toEqual(expect.arrayContaining([
      '--mode',
      'accept-edits',
      '--sandbox',
    ]));
    expect(args.at(-2)).toBe('--print');
    expect(args.at(-1)).toBe('Reply OK');
  });

  it('forwards an explicit task model even when the configured model is an internal alias', () => {
    const args = buildOrchestratedCliArgs(
      {
        id: 'dynamic-host',
        model: 'internal-route',
        runtime: {
          executor: 'orchestrated-cli',
          adapter: 'codex',
          promptTransport: 'argv',
          modelTransport: 'override-only',
        },
      },
      [],
      'Reply OK',
      null,
      'gpt-5.6-terra',
    );
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-terra']));
  });

  it('forces OpenCode through the isolated text-only agent', () => {
    const args = buildOrchestratedCliArgs(
      { id: 'opencode', model: 'opencode/big-pickle' },
      ['run', '--auto', '--agent', 'ambient-agent', '--session', 'ambient-session'],
      'Reply OK',
    );

    expect(args).toEqual([
      'run',
      '--pure',
      '--agent',
      'nco-orchestrated',
      '-m',
      'opencode/big-pickle',
      '--format',
      'json',
      'Reply OK',
    ]);
    expect(args).not.toContain('--auto');
    expect(args).not.toContain('ambient-agent');
    expect(args).not.toContain('ambient-session');
  });

  it.each([
    { id: 'codex', model: 'codex' },
    {
      id: 'hermes', model: 'hermes', command: 'codex',
      runtime: {
        executor: 'orchestrated-cli' as const,
        adapter: 'codex' as const,
        profile: 'readonly-tool-worker' as const,
        promptTransport: 'argv' as const,
      },
    },
  ])(
    '$id isolates the nested CLI from native tools and ambient MCP configuration',
    (provider) => {
      const defaultArgs = buildOrchestratedCliArgs(
        provider,
        [],
        'Reply OK',
      );
      expect(defaultArgs).toEqual(expect.arrayContaining([
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        'mcp_servers={}',
        'features.shell_tool=false',
        'features.unified_exec=false',
        'agents.enabled=false',
        'web_search="disabled"',
      ]));
      expect(defaultArgs[defaultArgs.indexOf('--sandbox') + 1]).toBe('read-only');

      const networkArgs = buildOrchestratedCliArgs(
        provider,
        [],
        'Reply OK',
        null,
        undefined,
        true,
      );
      // localNetworkAccess belongs to NCO's guarded runCommand path. It must not
      // re-enable the nested Codex shell or workspace writes and bypass CommandGate.
      expect(networkArgs).not.toContain('sandbox_workspace_write.network_access=true');
      expect(networkArgs[networkArgs.indexOf('--sandbox') + 1]).toBe('read-only');
    },
  );
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

  it('uses the Cursor adapter contract for an arbitrary provider id', async () => {
    const attempts: Array<string | undefined> = [];
    const result = await executeWithCursorModelFallback({
      providerId: 'pc-reviewer',
      providerAdapter: 'cursor',
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

  it('allows a task-type selected Cursor model to use the bounded fallback', async () => {
    const attempts: Array<string | undefined> = [];
    const result = await executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerAdapter: 'cursor',
      providerModel: 'cursor',
      requestedModel: 'claude-fable-5-thinking-high',
      modelSelection: 'task-type',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        attempts.push(model);
        if (attempts.length === 1) throw providerError;
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toEqual(['claude-fable-5-thinking-high', 'composer-2.5']);
  });

  it('never substitutes a caller-explicit Cursor model', async () => {
    const attempts: Array<string | undefined> = [];
    await expect(executeWithCursorModelFallback({
      providerId: 'cursor-agent',
      providerAdapter: 'cursor',
      providerModel: 'cursor',
      requestedModel: 'claude-fable-5-thinking-high',
      modelSelection: 'explicit',
      fallbackModel: 'composer-2.5',
      execute: async model => {
        attempts.push(model);
        throw providerError;
      },
    })).rejects.toBe(providerError);
    expect(attempts).toEqual(['claude-fable-5-thinking-high']);
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
    expect(resolveCursorFallbackModel(undefined)).toBe('auto');
  });
});

describe('preferDiagnosticSummary — 배너가 진짜 사유를 가리지 않게 (Y)', () => {
  // 실측(2026-08-07): codex 태스크 116건의 error 가 전부
  // `codex: CLI failed exit=1 — Reading additional input from stdin...` 이었다.
  // 그 문구만 보면 stdin 결함으로 읽히지만 같은 실행의 stdout 에
  // `{"type":"error","message":"You've hit your usage limit …"}` 가 있었다. 쿼터 소진이다.
  const BANNER = 'Reading additional input from stdin...';
  const QUOTA = '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits."}';

  it('배너 대신 쿼터 줄을 요약으로 올린다', () => {
    const summary = preferDiagnosticSummary(BANNER, `${BANNER}\n${QUOTA}`);
    expect(summary).toContain('usage limit');
    expect(summary).not.toBe(BANNER);
  });

  it('요약에 이미 사유가 있으면 건드리지 않는다', () => {
    const already = 'quota exceeded for this project';
    expect(preferDiagnosticSummary(already, `${already}\n${QUOTA}`)).toBe(already);
  });

  it('분류할 사유가 없으면 원래 요약을 유지한다', () => {
    expect(preferDiagnosticSummary(BANNER, `${BANNER}\nsome unrelated output`)).toBe(BANNER);
  });

  it('출력이 비어도 안전하다', () => {
    expect(preferDiagnosticSummary(BANNER, '')).toBe(BANNER);
  });

  it('**서킷이 열리도록 error 에 사유가 실린다** — 이것이 목적이다', () => {
    // 배너만 남으면 classifyCircuitError 가 error 에서 아무것도 못 찾아 서킷이 안 열린다.
    const summary = preferDiagnosticSummary(BANNER, `${BANNER}\n${QUOTA}`);
    expect(classifyCircuitError(summary)).not.toBeNull();
    expect(classifyCircuitError(BANNER)).toBeNull();
  });
});
