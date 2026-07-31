import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// persistTaskReassignment / loadTaskMetadata 는 모듈 스코프 getDb()를 쓴다.
// decision-log 도 같은 모듈을 쓰므로 mock 하나로 둘 다 덮인다(로그 실패는 내부에서 삼킨다).
let db: Database.Database | null = null;
vi.mock('../storage/database.js', () => ({
  getDb: () => db,
}));

const {
  attemptHistoryMonotonicEnabled,
  mergeAttemptedAgents,
  persistTaskReassignment,
} = await import('./task-queue.js');
const { decideFinalEscalation } = await import('./task-escalation.js');

/**
 * 회귀 고정 대상(T1, 2026-07-30 task_ATkeua4HRwS_T-tQ / team_tech-port-02-safety-license):
 * escalationHistory[0].attemptedAgents = ["cursor-agent","codex","claude-code"] 였는데
 * 최종 top-level attemptedAgents 가 ["codex","hermes"] 로 3→2 역행했고, 그 결과
 * 06:11:39 에 이미 queue_wait_timeout 으로 실패한 codex 가 재선택되어 30분을 더 소진한 뒤
 * 07:23:59 timeout(idle) 로 산출물 0 종료했다.
 */
const PERSISTED_HISTORY = ['cursor-agent', 'codex', 'claude-code'];
const SHRUNK_PATCH = ['codex', 'hermes'];

describe('mergeAttemptedAgents (시도이력 단조 증가)', () => {
  it('실측 역행 케이스에서 어느 쪽도 잃지 않는 합집합을 만든다', () => {
    expect(mergeAttemptedAgents(PERSISTED_HISTORY, SHRUNK_PATCH))
      .toEqual(['cursor-agent', 'codex', 'claude-code', 'hermes']);
  });

  it('순서를 보존하고 중복은 한 번만 남긴다', () => {
    expect(mergeAttemptedAgents(['a', 'b'], ['b', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('결과 길이는 절대 persisted 보다 짧아지지 않는다', () => {
    const merged = mergeAttemptedAgents(PERSISTED_HISTORY, []);
    expect(merged).toEqual(PERSISTED_HISTORY);
    expect(merged.length).toBeGreaterThanOrEqual(PERSISTED_HISTORY.length);
  });

  it('persisted 가 배열이 아니거나 오염돼도 incoming 만으로 안전하게 동작한다', () => {
    expect(mergeAttemptedAgents(undefined, SHRUNK_PATCH)).toEqual(SHRUNK_PATCH);
    expect(mergeAttemptedAgents('codex', SHRUNK_PATCH)).toEqual(SHRUNK_PATCH);
    expect(mergeAttemptedAgents([1, '', null, 'codex'], ['hermes'])).toEqual(['codex', 'hermes']);
  });
});

describe('attemptHistoryMonotonicEnabled (롤백 토글)', () => {
  it('기본값은 on 이다', () => {
    expect(attemptHistoryMonotonicEnabled(undefined)).toBe(true);
    expect(attemptHistoryMonotonicEnabled('')).toBe(true);
    expect(attemptHistoryMonotonicEnabled('1')).toBe(true);
  });

  it('NCO_ATTEMPT_HISTORY_MONOTONIC=0 이면 종전(덮어쓰기) 동작으로 복귀한다', () => {
    expect(attemptHistoryMonotonicEnabled('0')).toBe(false);
    expect(attemptHistoryMonotonicEnabled(' 0 ')).toBe(false);
  });
});

describe('persistTaskReassignment (DB 왕복)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        assigned_to TEXT,
        metadata_json TEXT,
        updated_at TEXT
      );
      INSERT INTO tasks (id, assigned_to, metadata_json)
      VALUES ('task_ATkeua4HRwS_T-tQ', 'codex', '${JSON.stringify({
        attemptedAgents: PERSISTED_HISTORY,
        teamId: 'team_tech-port-02-safety-license',
      })}');
    `);
    delete process.env.NCO_ATTEMPT_HISTORY_MONOTONIC;
  });

  afterEach(() => {
    db?.close();
    db = null;
    delete process.env.NCO_ATTEMPT_HISTORY_MONOTONIC;
  });

  function readMetadata(): Record<string, unknown> {
    const row = db!.prepare('SELECT metadata_json FROM tasks WHERE id=?')
      .get('task_ATkeua4HRwS_T-tQ') as { metadata_json: string };
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  }

  it('좁은 metadataPatch 가 persisted 시도이력을 덮어쓰지 못한다', () => {
    persistTaskReassignment('task_ATkeua4HRwS_T-tQ', 'codex', 'hermes', {
      attemptedAgents: SHRUNK_PATCH,
    });

    const metadata = readMetadata();
    expect(metadata.attemptedAgents).toEqual(['cursor-agent', 'codex', 'claude-code', 'hermes']);
    // 패치에 없던 기존 필드는 그대로 보존된다.
    expect(metadata.teamId).toBe('team_tech-port-02-safety-license');
    expect(metadata.reassignedFrom).toBe('codex');
  });

  it('토글을 0 으로 내리면 정확히 이전(덮어쓰기) 동작이다 — 롤백 경로 확인', () => {
    process.env.NCO_ATTEMPT_HISTORY_MONOTONIC = '0';

    persistTaskReassignment('task_ATkeua4HRwS_T-tQ', 'codex', 'hermes', {
      attemptedAgents: SHRUNK_PATCH,
    });

    expect(readMetadata().attemptedAgents).toEqual(SHRUNK_PATCH);
  });
});

describe('역행한 시도이력이 죽은 프로바이더를 재선택시킨다 (수정의 이유)', () => {
  const knownAgents = ['codex', 'cursor-agent', 'claude-code', 'hermes', 'opencode', 'ollama'];

  it('합집합 이력에서는 이미 시도한 provider 를 다시 고르지 않는다', () => {
    const attemptedAgents = mergeAttemptedAgents(PERSISTED_HISTORY, SHRUNK_PATCH);

    const decision = decideFinalEscalation({
      failedAgentId: 'hermes',
      failureReason: 'timeout(idle)',
      attemptedAgents,
      circuitOpenAgents: [],
      knownAgents,
    });

    if (decision.action === 'escalate') {
      expect(attemptedAgents).not.toContain(decision.nextAgentId);
    }
    // give-up 이어도 회귀는 아니다 — 금지 사항은 "시도이력에 있는 provider 재선택"뿐이다.
    expect(decision.metadataPatch?.attemptedAgents ?? attemptedAgents)
      .toEqual(expect.arrayContaining(PERSISTED_HISTORY));
  });
});
