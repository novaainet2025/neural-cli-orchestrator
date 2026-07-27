import { describe, expect, it } from 'vitest';
import {
  formatStructuredCommand,
  isCliImplementationRequest,
  searchCommandCatalog,
  splitCommandArgs,
  structuredInvocation,
  validateStructuredCommand
} from './commandSchema.js';
import { commandRegistry, customCommandDefs } from '../commands/registry.js';

const entries = [
  { name: '/model', usage: '/model [id]', help: 'model' },
  { name: '/task', usage: '/task [ai] <prompt>', help: 'task' },
  { name: '/inter-session', usage: '/inter-session [connect|send <to> <text>|broadcast <text>|list|status|disconnect]', help: 'peer' },
  { name: '/mcp', usage: '/mcp [list|call <server> <tool> [json] dangerous]', help: 'mcp' },
  { name: '/doctor', usage: '/doctor [runtime|commands|all]', help: 'doctor' },
  { name: '/help', usage: '/help [command]', help: 'help' }
];

const VALID_BUILTIN_ARGS: Record<string, string[]> = {
  '/task': ['검토해줘'],
  '/parallel': ['비교해줘'],
  '/conductor': ['작업'],
  '/commander': ['작업'],
  '/hive': ['작업'],
  '/discussion': ['주제'],
  '/teams': [],
  '/tasks': [],
  '/providers': [],
  '/agents': [],
  '/model': [],
  '/cancel': ['task-1'],
  '/status': ['task-1'],
  '/invocations': [],
  '/kanban': [],
  '/direct': [],
  '/statusbar': [],
  '/plan': [],
  '/permissions': ['default'],
  '/approval': ['default'],
  '/help': [],
  '/exit': [],
  '/kb': ['검색어'],
  '/hooks': [],
  '/settings': [],
  '/expand': [],
  '/report': [],
  '/mcp': [],
  '/route': [],
  '/clear': [],
  '/continue': [],
  '/resume': [],
  '/checkpoint': [],
  '/checkpoints': [],
  '/rewind': ['checkpoint-1'],
  '/branch': [],
  '/branches': [],
  '/fork': [],
  '/archive': [],
  '/archives': [],
  '/unarchive': ['archive-1'],
  '/switch': ['branch-1'],
  '/compact': [],
  '/retry': ['task-1'],
  '/reroute': ['task-1'],
  '/daemon': ['worker', 'start'],
  '/emergency-stop': ['점검'],
  '/circuit': [],
  '/circuit-reset': [],
  '/watch': ['task-1'],
  '/voice': [],
  '/skills': [],
  '/api': ['GET', 'nco:/health'],
  '/cost': [],
  '/diff': ['task-1'],
  '/doctor': [],
  '/stats': [],
  '/apply': ['change.patch'],
  '/worktree': ['list'],
  '/repomap': [],
  '/sandbox': ['echo ok'],
  '/workspace': ['list'],
  '/architect': ['설계'],
  '/pr': ['list'],
  '/agent': ['상태 확인'],
  '/history': [],
  '/commands': [],
  '/nco': ['status'],
  '/ax': ['GET', '/health'],
  '/inter-session': ['status']
};

const minimalCustomArgs = (usage: string): string[] => {
  let requiredUsage = '';
  let optionalDepth = 0;
  for (const character of usage) {
    if (character === '[') optionalDepth += 1;
    else if (character === ']') optionalDepth = Math.max(0, optionalDepth - 1);
    else if (optionalDepth === 0) requiredUsage += character;
  }
  return [...requiredUsage.matchAll(/<([^>]+)>/g)].map(() => 'value');
};

describe('structured command schema', () => {
  it('round-trips quoted structured arguments', () => {
    const line = formatStructuredCommand({ command: '/task', args: ['agy', 'nova cli의 "장점" 요약'] });
    expect(splitCommandArgs(line).slice(1)).toEqual(['agy', 'nova cli의 "장점" 요약']);
  });

  it('rejects usage placeholders instead of executing them', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/inter-session', ['send', '<to>', '<text>']),
      entries
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('validates model names against live providers', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/model', ['nova-cli-default']),
      entries,
      { providerIds: ['mlx', 'codex'] }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('validates every comma-separated inter-session peer', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/inter-session', ['send', 'nova-a,nova-missing', '안녕']),
      entries,
      { peerNames: ['nova-a', 'nova-b'] }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('allows multiple known peers as a structured target list', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/inter-session', ['send', 'nova-a,nova-b', '서로 인사해']),
      entries,
      { peerNames: ['nova-a', 'nova-b'] }
    );
    expect(result.ok).toBe(true);
  });

  it('rejects inter-session send when the live peer list is empty', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/inter-session', ['send', 'nova-a', '안녕']),
      entries,
      { peerNames: [] }
    );
    expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('validates MCP servers and appends the handler sentinel for calls', () => {
    const result = validateStructuredCommand(
      structuredInvocation('/mcp', ['call', 'filesystem', 'read_file', '{"path":"a"}']),
      entries,
      { mcpServerNames: ['filesystem'] }
    );
    expect(result.ok && result.routed.line).toContain('dangerous');

    const unknown = validateStructuredCommand(
      structuredInvocation('/mcp', ['call', 'made-up', 'read_file']),
      entries,
      { mcpServerNames: [] }
    );
    expect(unknown).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('validates literal, variant, optional, and subcommand forms used by built-ins', () => {
    const context = {
      providerIds: ['claude-code', 'mlx', 'codex', 'agy'],
      peerNames: ['nova-a'],
      mcpServerNames: ['filesystem']
    };
    const accepted: Array<[string, string[]]> = [
      ['/api', ['GET', 'nco:/health']],
      ['/api', ['POST', 'ax:/jobs', '{"name":"x"}']],
      ['/worktree', []],
      ['/worktree', ['list']],
      ['/worktree', ['add', 'feature']],
      ['/workspace', ['reset']],
      ['/workspace', ['add', '/tmp/project']],
      ['/pr', ['list']],
      ['/pr', ['view', '12']],
      ['/pr', ['checkout', '12', '--repo', 'owner/repo']],
      ['/voice', ['tts', '안녕하세요']],
      ['/skills', ['execute', 'skill-1']],
      ['/hooks', ['run', 'Stop']],
      ['/inter-session', ['broadcast', '안녕']],
      ['/direct', ['on']],
      ['/report', ['auto', 'off']]
    ];
    for (const [command, args] of accepted) {
      expect(
        validateStructuredCommand(structuredInvocation(command, args), commandRegistry.values(), context),
        `${command} ${args.join(' ')}`
      ).toEqual(expect.objectContaining({ ok: true }));
    }

    const rejected: Array<[string, string[]]> = [
      ['/voice', ['tts']],
      ['/skills', ['execute']],
      ['/hooks', ['run']],
      ['/inter-session', ['broadcast']],
      ['/direct', ['bogus']],
      ['/plan', ['bogus']],
      ['/worktree', ['list', 'extra']],
      ['/workspace', ['add']],
      ['/pr', ['checkout']],
      ['/api', ['GET', 'nco:health']]
    ];
    for (const [command, args] of rejected) {
      expect(
        validateStructuredCommand(structuredInvocation(command, args), commandRegistry.values(), context),
        `${command} ${args.join(' ')}`
      ).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
    }
  });

  it('clarifies unknown explicit task and parallel providers instead of changing prompt meaning', () => {
    const context = { providerIds: ['mlx', 'codex', 'agy'] };
    expect(validateStructuredCommand(
      structuredInvocation('/task', ['made-up', '버그 수정']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
    expect(validateStructuredCommand(
      structuredInvocation('/parallel', ['codex,missing', '비교']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
    expect(validateStructuredCommand(
      structuredInvocation('/task', ['codex', '버그 수정']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: true }));
    expect(validateStructuredCommand(
      structuredInvocation('/task', ['provider를 생략한 하나의 프롬프트']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: true }));
    expect(validateStructuredCommand(
      structuredInvocation('/task', ['codex']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
    expect(validateStructuredCommand(
      structuredInvocation('/parallel', ['codex,agy']),
      commandRegistry.values(),
      context
    )).toEqual(expect.objectContaining({ ok: false, kind: 'clarify' }));
  });

  it('directly validates one invocation for every command in the full registry catalog', () => {
    const customNames = new Set(customCommandDefs.map((command) => command.name));
    const builtInNames = [...commandRegistry.keys()].filter((name) => !customNames.has(name)).sort();
    expect(Object.keys(VALID_BUILTIN_ARGS).sort()).toEqual(builtInNames);

    const context = {
      providerIds: ['claude-code', 'mlx', 'codex', 'agy'],
      peerNames: ['nova-a'],
      mcpServerNames: ['filesystem']
    };
    const validated = new Set<string>();
    for (const [name, command] of commandRegistry) {
      const args = VALID_BUILTIN_ARGS[name] ?? minimalCustomArgs(command.usage);
      expect(
        validateStructuredCommand(
          structuredInvocation(name, args),
          commandRegistry.values(),
          context
        ),
        `${name} ${args.join(' ')}`
      ).toEqual(expect.objectContaining({ ok: true }));
      validated.add(name);
    }
    expect(validated.size).toBe(commandRegistry.size);
    expect(validated.size).toBe(builtInNames.length + customNames.size);
    expect([...validated].sort()).toEqual([...commandRegistry.keys()].sort());
  });

  it('recognizes requests to modify nova-cli itself as implementation work', () => {
    expect(isCliImplementationRequest('nova cli에서 provider를 생략하면 기본값을 쓰도록 로직을 수정해')).toBe(true);
    expect(isCliImplementationRequest('현재 모델을 mlx로 바꿔줘')).toBe(false);
  });

  it('searches installed command usage and help without a hand-written route table', () => {
    expect(searchCommandCatalog('inter-session peer', entries).map((entry) => entry.name)).toContain('/inter-session');
    expect(searchCommandCatalog('모든', entries, 50)).toHaveLength(entries.length);
  });
});
