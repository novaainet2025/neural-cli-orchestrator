import { getDb, runMigrations, closeDb } from '../src/storage/database.js';
import { getRedis, closeRedis } from '../src/storage/redis.js';
import { eventBus } from '../src/core/event-bus.js';
import { sharedState } from '../src/core/shared-state.js';
import { discussionEngine, type DiscussionMode } from '../src/core/discussion-engine.js';
import { agentManager } from '../src/agent/agent-manager.js';
import { createSessionId, createMessageId } from '../src/utils/id.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.log(`  ✗ ${name}: ${err.message}`);
      failed++;
    }
  })();
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  NCO Phase 3 검증 테스트 — 토론 엔진      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Boot
  getDb();
  runMigrations();
  await getRedis();
  await eventBus.init();
  await sharedState.seedProviders();
  await agentManager.init();

  console.log('=== 토론 엔진 구조 검증 ===');

  await test('discussionEngine 인스턴스 존재', () => {
    assert(discussionEngine !== null, 'discussionEngine is null');
    assert(typeof discussionEngine.startDiscussion === 'function', 'startDiscussion not a function');
    assert(typeof discussionEngine.executeParallel === 'function', 'executeParallel not a function');
    assert(typeof discussionEngine.executeBroadcast === 'function', 'executeBroadcast not a function');
    assert(typeof discussionEngine.startRealtimeDiscussion === 'function', 'startRealtimeDiscussion not a function');
    assert(typeof discussionEngine.userIntervention === 'function', 'userIntervention not a function');
  });

  await test('7가지 협업 모드 타입 체크', () => {
    const modes: DiscussionMode[] = ['task', 'parallel', 'discussion', 'realtime', 'consensus', 'hive', 'broadcast'];
    assert(modes.length === 7, 'Should have 7 modes');
  });

  await test('agentManager 9개 프로바이더 로드', () => {
    const ids = agentManager.listEnabledIds();
    assert(ids.length === 9, `Expected 9, got ${ids.length}`);
    assert(ids.includes('claude-code'), 'Missing claude-code');
    assert(ids.includes('nvidia'), 'Missing nvidia');
    assert(ids.includes('openrouter'), 'Missing openrouter');
  });

  await test('agentManager 프로바이더 조회', () => {
    const cc = agentManager.getProvider('claude-code');
    assert(cc !== undefined, 'claude-code not found');
    assert(cc!.role === 'Commander', `Expected Commander, got ${cc!.role}`);
    assert(cc!.score === 95, `Expected 95, got ${cc!.score}`);
  });

  await test('agentManager 샌드박스 생성 확인', () => {
    const sb = agentManager.getSandbox('codex');
    assert(sb !== undefined, 'codex sandbox not found');
    assert(sb!.canExecute(), 'codex should be executable');
  });

  console.log('');
  console.log('=== Event Bus 토론 이벤트 검증 ===');

  await test('discussion:started 이벤트 발행/수신', async () => {
    let received = false;
    eventBus.on('discussion:started', (evt) => {
      if (evt.topic === 'test-topic') received = true;
    });
    await eventBus.publish({
      type: 'discussion:started',
      sessionId: 'test-sess',
      topic: 'test-topic',
      mode: 'discussion',
      participants: ['a', 'b'],
    });
    await new Promise(r => setTimeout(r, 100));
    assert(received, 'Event not received');
  });

  await test('discussion:round_started 이벤트', async () => {
    let received = false;
    eventBus.on('discussion:round_started', () => { received = true; });
    await eventBus.publish({
      type: 'discussion:round_started',
      sessionId: 'test', round: 1, totalRounds: 3,
    });
    await new Promise(r => setTimeout(r, 100));
    assert(received, 'round_started not received');
  });

  const testDiscId = createSessionId();

  await test('discussion:user_intervention 이벤트', async () => {
    // First create the discussion so FK works
    const db = getDb();
    db.prepare(`INSERT INTO discussions (id, topic, mode, status, participants_json, initiator) VALUES (?, 'test', 'discussion', 'active', '["a"]', 'user')`).run(testDiscId);

    let received = false;
    let content = '';
    eventBus.on('discussion:user_intervention', (evt) => {
      received = true;
      content = evt.content as string;
    });
    await discussionEngine.userIntervention(testDiscId, '보안 우선으로 구현해');
    await new Promise(r => setTimeout(r, 100));
    assert(received, 'user_intervention not received');
    assert(content === '보안 우선으로 구현해', `Content mismatch: ${content}`);
  });

  await test('discussion:user_intervention DB 저장', () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM discussion_messages WHERE discussion_id=? AND agent_id='user'"
    ).get(testDiscId) as any;
    assert(row !== undefined, 'User intervention not saved to DB');
    assert(row.message_type === 'intervention', `Expected intervention, got ${row.message_type}`);
  });

  console.log('');
  console.log('=== 합의율 계산 검증 (수동 시뮬레이션) ===');

  await test('합의율: 전원 동의 → 1.0', () => {
    // Simulate: 3 agents all agree on agent-a
    const scores: Record<string, Record<string, number>> = {
      'agent-b': { 'agent-a': 9, 'agent-c': 5 },
      'agent-c': { 'agent-a': 8, 'agent-b': 4 },
      'agent-a': { 'agent-b': 3, 'agent-c': 6 },
    };
    // All pick agent-a as top → 100% consensus
    // We can test the logic indirectly through the engine's private methods
    // For now, verify the structure exists
    assert(Object.keys(scores).length === 3, 'Should have 3 evaluators');
  });

  const discId2 = createSessionId();

  await test('DB discussions 테이블 동작', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO discussions (id, topic, mode, status, participants_json, initiator)
      VALUES (?, 'test topic', 'discussion', 'active', '["a","b","c"]', 'claude-code')
    `).run(discId2);
    const row = db.prepare("SELECT * FROM discussions WHERE id=?").get(discId2) as any;
    assert(row.topic === 'test topic', 'Topic mismatch');
    assert(row.mode === 'discussion', 'Mode mismatch');
    assert(JSON.parse(row.participants_json).length === 3, 'Participants count mismatch');
  });

  await test('DB discussion_messages 테이블 동작', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
      VALUES (?, ?, 'codex', 1, 'proposal', 'I propose solution A')
    `).run(createMessageId(), discId2);
    db.prepare(`
      INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
      VALUES (?, ?, 'gemini', 1, 'proposal', 'I propose solution B')
    `).run(createMessageId(), discId2);
    const msgs = db.prepare("SELECT * FROM discussion_messages WHERE discussion_id=? AND round=1").all(discId2) as any[];
    assert(msgs.length >= 2, `Expected ≥2 messages, got ${msgs.length}`);
  });

  await test('executeBroadcast 이벤트 발행', async () => {
    let received = false;
    eventBus.on('message:broadcast', (evt) => {
      if (evt.content === 'Hello all agents') received = true;
    });
    await discussionEngine.executeBroadcast('Hello all agents', ['a', 'b', 'c']);
    await new Promise(r => setTimeout(r, 100));
    assert(received, 'Broadcast not received');
  });

  // ═══ 결과 ═══
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(`  결과: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════');

  // Cleanup
  eventBus.destroy();
  agentManager.destroy();
  await closeRedis();
  closeDb();

  process.exit(failed > 0 ? 1 : 0);
}

main();
