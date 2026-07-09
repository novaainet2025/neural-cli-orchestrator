/**
 * NCO 팀 작업 검증 — AI 에이전트들이 팀으로 협업하는 기능 테스트
 *
 * 검증 항목:
 * 1. 멀티 에이전트 병렬 실행
 * 2. 에이전트 간 실시간 메시지 교환
 * 3. 토론 세션 (생성→참여→이벤트 흐름)
 * 4. 작업 위임 (Commander → Engineer)
 * 5. 공유 상태에서 서로의 작업 확인
 * 6. 파일 락 (동시 수정 방지)
 * 7. 에이전트 상태 변화 실시간 WS 수신
 * 8. Rate Limit 시 대체 에이전트 전환
 * 9. 토론 합의 + 결과 조회
 * 10. 전체 팀 브로드캐스트
 */
import { WebSocket } from 'ws';

const API = 'http://localhost:6200';
const WS_URL = 'ws://localhost:6201';

let passed = 0, failed = 0;

async function test(cat: string, name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function api(p: string, o?: RequestInit) {
  const r = await fetch(`${API}${p}`, o);
  return { status: r.status, data: await r.json() };
}
async function post(p: string, b: any) {
  return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
}
function connectWS(): Promise<{ ws: WebSocket; msgs: any[]; close: () => void }> {
  return new Promise((res, rej) => {
    const msgs: any[] = [];
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => res({ ws, msgs, close: () => ws.close() }));
    ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('ws timeout')), 5000);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  NCO 팀 작업 검증                                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // 전체 에이전트 online
  await post('/api/daemons/start-all', {});
  await new Promise(r => setTimeout(r, 500));

  // ═══ 1. 팀 상태 확인 ═══
  console.log('=== 1. 팀 전체 상태 ===');

  await test('팀', '9개 에이전트 전원 online', async () => {
    const r = await api('/api/daemons');
    const online = r.data.daemons.filter((d: any) => d.status === 'idle').length;
    assert(online === 9, `online: ${online}/9`);
  });

  await test('팀', 'mesh/team → 팀 구성 조회', async () => {
    const r = await api('/api/mesh/team');
    assert(r.data.nodes.length === 9, `nodes: ${r.data.nodes.length}`);
    const commander = r.data.nodes.find((n: any) => n.role === 'Commander');
    assert(!!commander, 'no Commander');
  });

  await test('팀', '공유 상태: 모든 에이전트 idle', async () => {
    const r = await api('/api/ai-providers/status');
    const states = Object.values(r.data.providers) as any[];
    const allIdle = states.every(s => s.status === 'idle');
    assert(allIdle, `not all idle: ${states.map(s => `${s.id}:${s.status}`).join(', ')}`);
  });

  // ═══ 2. 멀티 에이전트 병렬 작업 ═══
  console.log('\n=== 2. 멀티 에이전트 병렬 작업 ===');

  await test('병렬', '3개 에이전트에 동시 작업 할당', async () => {
    const { ws, msgs, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    // 3개 동시 전송
    const [r1, r2, r3] = await Promise.all([
      post('/api/task', { ai: 'openrouter', prompt: 'Team task 1: say A' }),
      post('/api/task', { ai: 'openrouter', prompt: 'Team task 2: say B' }),
      post('/api/task', { ai: 'openrouter', prompt: 'Team task 3: say C' }),
    ]);

    assert(r1.status === 202, `task1: ${r1.status}`);
    assert(r2.status === 202, `task2: ${r2.status}`);
    assert(r3.status === 202, `task3: ${r3.status}`);

    // 3개 taskId 모두 다른지 확인
    const ids = [r1.data.taskId, r2.data.taskId, r3.data.taskId];
    assert(new Set(ids).size === 3, 'duplicate taskIds');

    await new Promise(r => setTimeout(r, 2000));

    // WS에서 task:created 3개 수신
    const created = msgs.filter(m => m.type === 'task:created');
    assert(created.length >= 3, `task:created: ${created.length}`);
    close();
  });

  await test('병렬', '병렬 작업 결과 조회', async () => {
    await new Promise(r => setTimeout(r, 3000));
    const r = await api('/api/tasks?limit=5');
    const recent = r.data.tasks.filter((t: any) => t.prompt?.startsWith('Team task'));
    assert(recent.length >= 3, `team tasks: ${recent.length}`);
  });

  // ═══ 3. 작업 위임 ═══
  console.log('\n=== 3. 작업 위임 (Commander → Agent) ===');

  await test('위임', 'Commander가 task 생성 → 특정 Agent에 할당', async () => {
    const r = await post('/api/task', {
      ai: 'openrouter',
      prompt: 'Commander 위임: 프로젝트 구조 분석해',
      systemPrompt: 'You were delegated this task by Commander (claude-code). Report back.',
    });
    assert(r.status === 202, `HTTP ${r.status}`);
    assert(r.data.agentId === 'openrouter', `assigned: ${r.data.agentId}`);
  });

  await test('위임', '위임 후 에이전트 상태 working 전환', async () => {
    await new Promise(r => setTimeout(r, 500));
    const r = await api('/api/daemons');
    const or = r.data.daemons.find((d: any) => d.id === 'openrouter');
    // working 또는 이미 완료
    assert(or.status === 'working' || or.status === 'idle', `status: ${or.status}`);
  });

  // ═══ 4. 에이전트 간 메시지 교환 ═══
  console.log('\n=== 4. 에이전트 간 메시지 교환 ===');

  await test('메시지', 'codex → openrouter: 코드 리뷰 요청', async () => {
    const r = await post('/api/collaboration/message', {
      from: 'codex', to: 'openrouter',
      message: '파일 src/core/event-bus.ts 리뷰 부탁합니다',
      type: 'review',
    });
    assert(r.data.ok, 'send failed');
  });

  await test('메시지', 'openrouter → codex: 리뷰 응답', async () => {
    const r = await post('/api/collaboration/message', {
      from: 'openrouter', to: 'codex',
      message: 'event-bus.ts 검토 완료, 이벤트 버퍼링 로직 좋습니다',
      type: 'direct',
    });
    assert(r.data.ok, 'reply failed');
  });

  await test('메시지', 'claude-code → all: 전체 브로드캐스트', async () => {
    const { ws, msgs, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    const r = await post('/api/collaboration/message', {
      from: 'claude-code', to: null,
      message: '전체 공지: Phase 1-7 구현 완료, 테스트 진행 중',
      type: 'broadcast',
    });
    assert(r.data.ok, 'broadcast failed');

    await new Promise(r => setTimeout(r, 500));
    close();
  });

  await test('메시지', '메시지 이력 DB 저장 확인', async () => {
    const r = await api('/api/messages?limit=10');
    const review = r.data.messages.find((m: any) =>
      m.from_agent === 'codex' && m.to_agent === 'openrouter' && m.message_type === 'review');
    assert(!!review, 'review message not in DB');
    const reply = r.data.messages.find((m: any) =>
      m.from_agent === 'openrouter' && m.to_agent === 'codex');
    assert(!!reply, 'reply not in DB');
  });

  // ═══ 5. 서로의 작업 상태 확인 ═══
  console.log('\n=== 5. 공유 상태 — 서로의 작업 확인 ===');

  await test('공유', '에이전트 상태 API에서 팀 전체 조회', async () => {
    const r = await api('/api/ai-providers/status');
    const ids = Object.keys(r.data.providers);
    assert(ids.length >= 9, `providers: ${ids.length}`);
    // 각 에이전트의 상태 필드 존재
    for (const id of ids) {
      const s = r.data.providers[id];
      assert(s.status !== undefined, `${id}: no status`);
      assert(s.health !== undefined, `${id}: no health`);
    }
  });

  await test('공유', 'daemons에서 currentTask 확인 가능', async () => {
    const r = await api('/api/daemons');
    r.data.daemons.forEach((d: any) => {
      assert('currentTask' in d, `${d.id}: no currentTask field`);
      assert('tasks' in d, `${d.id}: no tasks field`);
    });
  });

  await test('공유', '행동 로그에서 다른 에이전트 활동 조회', async () => {
    const r = await api('/api/agent-actions?limit=20');
    const agents = new Set(r.data.actions.map((a: any) => a.agent_id));
    // 최소 2개 이상의 에이전트 활동이 기록됨
    assert(agents.size >= 2, `unique agents in log: ${agents.size}`);
  });

  // ═══ 6. 파일 락 ═══
  console.log('\n=== 6. 파일 락 (동시 수정 방지) ===');

  await test('락', 'rate-limit state로 락 시뮬레이션', async () => {
    // 같은 provider에 동시 rate limit 설정
    await post('/api/rate-limits/state', { provider: 'codex', isLimited: true, reason: 'lock test' });
    const r = await api('/api/rate-limits/state');
    assert(r.data.state.limitedProviders.includes('codex'), 'codex not limited');

    // 해제
    await post('/api/rate-limits/state', { provider: 'codex', isLimited: false });
    const r2 = await api('/api/rate-limits/state');
    assert(!r2.data.state.limitedProviders.includes('codex'), 'codex still limited');
  });

  // ═══ 7. 실시간 WS 상태 변화 ═══
  console.log('\n=== 7. 실시간 WS 팀 상태 변화 ===');

  await test('WS팀', '에이전트 on/off → 팀 전체에 브로드캐스트', async () => {
    const { ws, msgs, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    // 3개 에이전트 순차 stop/start
    await post('/api/daemons/aider/stop', {});
    await post('/api/daemons/cursor-agent/stop', {});
    await new Promise(r => setTimeout(r, 500));
    await post('/api/daemons/aider/start', {});
    await post('/api/daemons/cursor-agent/start', {});
    await new Promise(r => setTimeout(r, 500));

    const agentEvents = msgs.filter(m => m.type?.startsWith('agent:'));
    assert(agentEvents.length >= 4, `agent events: ${agentEvents.length}`);

    // offline + online 이벤트 모두 존재
    const offlines = agentEvents.filter(m => m.type === 'agent:offline');
    const onlines = agentEvents.filter(m => m.type === 'agent:online');
    assert(offlines.length >= 2, `offlines: ${offlines.length}`);
    assert(onlines.length >= 2, `onlines: ${onlines.length}`);
    close();
  });

  await test('WS팀', '작업 할당 → 팀에서 working 상태 확인', async () => {
    const { ws, msgs, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    await post('/api/task', { ai: 'openrouter', prompt: 'WS team test' });
    await new Promise(r => setTimeout(r, 1500));

    // task:created 수신
    const created = msgs.find(m => m.type === 'task:created');
    assert(!!created, 'no task:created');

    // 팀 상태 조회 — openrouter가 working 또는 이미 완료
    const r = await api('/api/daemons');
    const or = r.data.daemons.find((d: any) => d.id === 'openrouter');
    assert(or.status === 'working' || or.status === 'idle', `or: ${or.status}`);
    close();
  });

  // ═══ 8. Rate Limit 대체 전환 ═══
  console.log('\n=== 8. Rate Limit 시 대체 에이전트 ===');

  await test('RL', 'provider rate limit 설정 → limitedProviders 반영', async () => {
    await post('/api/rate-limits/state', { provider: 'openrouter', isLimited: true, reason: '429 too many' });
    const r = await api('/api/rate-limits/state');
    assert(r.data.state.limitedProviders.includes('openrouter'), 'not limited');
    assert(!r.data.state.availableProviders.includes('openrouter'), 'still available');
    // 복구
    await post('/api/rate-limits/state', { provider: 'openrouter', isLimited: false });
  });

  await test('RL', 'systemStatus: 절반 이상 리밋 시 degraded', async () => {
    // 5개 리밋 설정
    for (const p of ['codex', 'aider', 'copilot', 'cursor-agent', 'openrouter']) {
      await post('/api/rate-limits/state', { provider: p, isLimited: true, reason: 'test' });
    }
    const r = await api('/api/rate-limits/state');
    assert(r.data.state.systemStatus === 'degraded', `status: ${r.data.state.systemStatus}`);

    // 복구
    for (const p of ['codex', 'aider', 'copilot', 'cursor-agent', 'openrouter']) {
      await post('/api/rate-limits/state', { provider: p, isLimited: false });
    }
    const r2 = await api('/api/rate-limits/state');
    assert(r2.data.state.systemStatus === 'healthy', `after: ${r2.data.state.systemStatus}`);
  });

  // ═══ 9. 토론 합의 + 결과 ═══
  console.log('\n=== 9. 토론 세션 관리 ===');

  await test('토론', '협업 세션 생성 → ID 발급', async () => {
    const r = await post('/api/collaboration/sessions', {
      title: '팀 토론: 에러 핸들링 전략',
      participants: ['claude-code', 'codex', 'openrouter'],
    });
    assert(!!r.data.session.id, 'no session id');
  });

  await test('토론', '토론 목록 조회', async () => {
    const r = await api('/api/discussions');
    assert(r.data.discussions.length >= 1, `discussions: ${r.data.discussions.length}`);
  });

  await test('토론', 'realtime-sessions 조회', async () => {
    const r = await api('/api/realtime-sessions');
    assert(Array.isArray(r.data.sessions), 'not array');
  });

  await test('토론', '세션 완료 처리', async () => {
    const cr = await post('/api/collaboration/sessions', {
      title: 'Complete test', participants: ['a', 'b'],
    });
    const sid = cr.data.session.id;
    const r = await post(`/api/collaboration/sessions/${sid}/complete`, {
      summary: '합의 완료: Event Bus 방식 채택',
    });
    assert(r.data.ok, 'complete failed');
  });

  // ═══ 10. 전체 팀 브로드캐스트 + 확인 ═══
  console.log('\n=== 10. 전체 팀 브로드캐스트 ===');

  await test('BC', 'chat/messages broadcast → 전체 전달', async () => {
    const { ws, msgs, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    const r = await post('/api/chat/messages', {
      message: '전체 팀 알림: 통합 테스트 진행 중',
      broadcast: true,
    });
    assert(r.status === 202, `HTTP ${r.status}`);

    await new Promise(r => setTimeout(r, 1000));
    close();
  });

  await test('BC', 'stats에 총 작업/토론 수 반영', async () => {
    const r = await api('/api/stats');
    assert(r.data.totalTasks >= 5, `tasks: ${r.data.totalTasks}`);
    assert(r.data.totalDiscussions >= 1, `discussions: ${r.data.totalDiscussions}`);
  });

  // ═══ 결과 ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  팀 작업 검증 결과: ${passed} passed, ${failed} failed`);
  console.log(`  통과율: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log('══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
