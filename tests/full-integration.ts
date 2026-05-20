/**
 * NCO 전체 기능 통합 테스트 — Phase 1~7 + 실시간 검증
 */
import { WebSocket } from 'ws';

const API = 'http://localhost:6200';
const WS_URL = 'ws://localhost:6201';

let passed = 0;
let failed = 0;
const results: Array<{ category: string; name: string; ok: boolean; detail?: string }> = [];

async function test(category: string, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    results.push({ category, name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    results.push({ category, name, ok: false, detail: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API}${path}`, options);
  return { status: res.status, data: await res.json() };
}

async function post(path: string, body: any) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ─── WebSocket helper ─────────────────────
function connectWS(): Promise<{ ws: WebSocket; messages: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve({ ws, messages, close: () => ws.close() }));
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())); } catch {} });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  NCO 전체 기능 통합 테스트                        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // ═══ 1. 서버 인프라 ═══
  console.log('=== 1. 서버 인프라 ===');

  await test('서버', 'GET /health → healthy', async () => {
    const r = await api('/health');
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(r.data.status === 'healthy', `status: ${r.data.status}`);
  });

  await test('서버', 'GET /api/health → healthy:true', async () => {
    const r = await api('/api/health');
    assert(r.data.healthy === true, 'not healthy');
  });

  await test('서버', 'GET /monitor → HTML 200', async () => {
    const res = await fetch(`${API}/monitor`);
    assert(res.status === 200, `HTTP ${res.status}`);
    const html = await res.text();
    assert(html.includes('NCO Live Monitor'), 'missing title');
  });

  await test('서버', 'Redis 연결', async () => {
    const r = await api('/health');
    assert(r.data.runtime.redis === true, 'redis not connected');
  });

  // ═══ 2. AI 프로바이더 ═══
  console.log('\n=== 2. AI 프로바이더 ===');

  await test('프로바이더', '10개 프로바이더 등록', async () => {
    const r = await api('/api/ai-providers');
    assert(r.data.providers.length === 9, `got ${r.data.providers.length}`);
  });

  await test('프로바이더', '프로바이더 역할/점수 정확성', async () => {
    const r = await api('/api/ai-providers');
    const cc = r.data.providers.find((p: any) => p.id === 'claude-code');
    assert(cc.role === 'Commander', `role: ${cc.role}`);
    assert(cc.score === 95, `score: ${cc.score}`);
    const nv = r.data.providers.find((p: any) => p.id === 'nvidia');
    assert(nv.role === 'Reasoner', `nvidia role: ${nv.role}`);
  });

  await test('프로바이더', 'enabled 필터', async () => {
    const r = await api('/api/ai-providers/enabled');
    assert(r.data.providers.length === 9, `enabled: ${r.data.providers.length}`);
  });

  await test('프로바이더', '실시간 상태 조회', async () => {
    const r = await api('/api/ai-providers/status');
    assert(typeof r.data.providers === 'object', 'no providers object');
  });

  // ═══ 3. 데몬 관리 ═══
  console.log('\n=== 3. 데몬 관리 ===');

  await test('데몬', 'GET /api/daemons → 9개', async () => {
    const r = await api('/api/daemons');
    assert(r.data.daemons.length === 9, `got ${r.data.daemons.length}`);
  });

  await test('데몬', '전체 start-all', async () => {
    await post('/api/daemons/start-all', {});
    await new Promise(r => setTimeout(r, 500));
    const r = await api('/api/daemons');
    const online = r.data.daemons.filter((d: any) => d.status === 'idle').length;
    assert(online === 9, `online: ${online}/9`);
  });

  await test('데몬', '개별 stop → offline', async () => {
    await post('/api/daemons/nvidia/stop', {});
    await new Promise(r => setTimeout(r, 500));
    const r = await api('/api/daemons');
    const nv = r.data.daemons.find((d: any) => d.id === 'nvidia');
    assert(nv.status === 'offline', `nvidia: ${nv.status}`);
  });

  await test('데몬', '개별 start → idle', async () => {
    await post('/api/daemons/nvidia/start', {});
    await new Promise(r => setTimeout(r, 500));
    const r = await api('/api/daemons');
    const nv = r.data.daemons.find((d: any) => d.id === 'nvidia');
    assert(nv.status === 'idle', `nvidia: ${nv.status}`);
  });

  await test('데몬', 'by-workspace', async () => {
    const r = await api('/api/daemons/by-workspace?workspaceId=default');
    assert(r.data.workspaceId === 'default', 'wrong workspace');
    assert(r.data.daemons.length === 9, `got ${r.data.daemons.length}`);
  });

  // ═══ 4. WebSocket 양방향 ═══
  console.log('\n=== 4. WebSocket 양방향 통신 ===');

  await test('WS', '연결 + connected 메시지', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));
    const conn = messages.find(m => m.type === 'connected');
    assert(!!conn, 'no connected message');
    assert(!!conn.clientId, 'no clientId');
    close();
  });

  await test('WS', 'ping → pong', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 200));
    ws.send(JSON.stringify({ type: 'ping' }));
    await new Promise(r => setTimeout(r, 500));
    const pong = messages.find(m => m.type === 'pong');
    assert(!!pong, 'no pong');
    close();
  });

  await test('WS', 'subscribe + 이벤트 수신', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 200));
    ws.send(JSON.stringify({ type: 'subscribe', taskId: 'test-sub' }));
    await new Promise(r => setTimeout(r, 300));
    const sub = messages.find(m => m.type === 'subscribed');
    assert(!!sub, 'no subscribed confirmation');
    close();
  });

  await test('WS', '실시간 이벤트 브로드캐스트 수신', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    // REST로 이벤트 발생시키기
    await post('/api/daemons/codex/stop', {});
    await new Promise(r => setTimeout(r, 500));
    await post('/api/daemons/codex/start', {});
    await new Promise(r => setTimeout(r, 500));

    const agentEvents = messages.filter(m => m.type?.startsWith('agent:'));
    assert(agentEvents.length >= 1, `agent events: ${agentEvents.length}`);
    close();
  });

  // ═══ 5. 작업 생성/조회 ═══
  console.log('\n=== 5. 작업 (Tasks) ===');

  await test('작업', 'POST /api/task → 202 + taskId', async () => {
    const r = await post('/api/task', { ai: 'openrouter', prompt: 'integration test' });
    assert(r.status === 202, `HTTP ${r.status}`);
    assert(!!r.data.taskId, 'no taskId');
    assert(r.data.status === 'assigned', `status: ${r.data.status}`);
  });

  await test('작업', 'GET /api/tasks → 작업 목록', async () => {
    const r = await api('/api/tasks?limit=5');
    assert(Array.isArray(r.data.tasks), 'not array');
    assert(r.data.tasks.length >= 1, 'empty');
  });

  await test('작업', 'GET /api/v2/tasks', async () => {
    const r = await api('/api/v2/tasks');
    assert(Array.isArray(r.data.tasks), 'not array');
  });

  await test('작업', 'GET /api/task-master/stats', async () => {
    const r = await api('/api/task-master/stats');
    assert(typeof r.data.total === 'number', 'no total');
    assert(typeof r.data.byStatus === 'object', 'no byStatus');
  });

  await test('작업', 'DELETE /api/tasks/:id → cancelled', async () => {
    const cr = await post('/api/task', { ai: 'openrouter', prompt: 'cancel test' });
    const r = await api(`/api/tasks/${cr.data.taskId}`, { method: 'DELETE' });
    assert(r.data.ok === true, 'not ok');
  });

  // ═══ 6. 채팅 ═══
  console.log('\n=== 6. 채팅 ===');

  await test('채팅', 'POST /api/chat/messages → 202', async () => {
    const r = await post('/api/chat/messages', { message: 'chat test', ai: 'openrouter' });
    assert(r.status === 202, `HTTP ${r.status}`);
  });

  await test('채팅', 'GET /api/chat/ais', async () => {
    const r = await api('/api/chat/ais');
    assert(r.data.ais.length === 10, `ais: ${r.data.ais.length}`);
  });

  await test('채팅', 'GET /api/chat/workspaces', async () => {
    const r = await api('/api/chat/workspaces');
    assert(Array.isArray(r.data.workspaces), 'not array');
  });

  // ═══ 7. 토론 ═══
  console.log('\n=== 7. 토론 (Discussion) ===');

  await test('토론', 'POST /api/discussion/create → session', async () => {
    const r = await post('/api/discussion/create', { mode: 'discussion', providers: ['openrouter', 'nvidia'] });
    assert(!!r.data.session, 'no session');
    assert(!!r.data.session.wsUrl, 'no wsUrl');
  });

  await test('토론', 'POST /api/realtime/discussion → started', async () => {
    const r = await post('/api/realtime/discussion', { prompt: 'test discussion', mode: 'discussion' });
    assert(r.status === 202, `HTTP ${r.status}`);
    assert(r.data.status === 'started', `status: ${r.data.status}`);
  });

  await test('토론', 'GET /api/discussions → 목록', async () => {
    const r = await api('/api/discussions');
    assert(Array.isArray(r.data.discussions), 'not array');
  });

  await test('토론', 'GET /api/realtime-sessions', async () => {
    const r = await api('/api/realtime-sessions');
    assert(Array.isArray(r.data.sessions), 'not array');
  });

  // ═══ 8. 협업 ═══
  console.log('\n=== 8. 협업 (Collaboration) ===');

  await test('협업', 'POST /api/collaboration/sessions', async () => {
    const r = await post('/api/collaboration/sessions', { title: 'test collab', participants: ['a', 'b'] });
    assert(!!r.data.session.id, 'no session id');
  });

  await test('협업', 'POST /api/collaboration/message', async () => {
    const r = await post('/api/collaboration/message', { from: 'codex', to: 'gemini', message: 'hello', type: 'direct' });
    assert(r.data.ok === true, 'not ok');
  });

  // ═══ 9. Rate Limits ═══
  console.log('\n=== 9. Rate Limits ===');

  await test('RL', 'GET /api/rate-limits', async () => {
    const r = await api('/api/rate-limits');
    assert(r.status === 200, `HTTP ${r.status}`);
  });

  await test('RL', 'GET /api/rate-limits/state → systemStatus', async () => {
    const r = await api('/api/rate-limits/state');
    assert(r.data.success === true, 'not success');
    assert(!!r.data.state.systemStatus, 'no systemStatus');
  });

  await test('RL', 'POST /api/rate-limits/state → 저장', async () => {
    const r = await post('/api/rate-limits/state', { provider: 'test-rl', isLimited: true, reason: 'test' });
    assert(r.data.ok === true, 'not ok');
  });

  // ═══ 10. 대시보드 호환 라우트 ═══
  console.log('\n=== 10. 대시보드 호환 API ===');

  const compatRoutes = [
    '/api/kanban/tasks', '/api/task-master/workspaces',
    '/api/plans', '/api/workspace', '/api/features/sync',
    '/api/learning', '/api/history', '/api/checkpoints',
    '/api/mesh/status', '/api/mesh/team', '/api/agent/sessions',
    '/api/agent-actions?limit=5', '/api/messages?limit=5', '/api/stats',
  ];

  for (const route of compatRoutes) {
    await test('호환', `GET ${route}`, async () => {
      const r = await api(route);
      assert(r.status === 200, `HTTP ${r.status}`);
    });
  }

  // ═══ 11. Kanban CRUD ═══
  console.log('\n=== 11. Kanban CRUD ===');

  await test('칸반', 'POST /api/kanban/tasks → 생성', async () => {
    const r = await post('/api/kanban/tasks', { title: 'kanban test', priority: 5 });
    assert(!!r.data.task, 'no task');
  });

  await test('칸반', 'PATCH /api/kanban/tasks/:id → 수정', async () => {
    const cr = await post('/api/kanban/tasks', { title: 'patch test' });
    const id = cr.data.task.id;
    const r = await api(`/api/kanban/tasks/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert(r.data.task.status === 'completed', `status: ${r.data.task.status}`);
  });

  // ═══ 12. WebSocket 실시간 이벤트 검증 ═══
  console.log('\n=== 12. WebSocket 실시간 이벤트 통합 ===');

  await test('WS+API', '작업 생성 → WS에서 task:created 수신', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    await post('/api/task', { ai: 'openrouter', prompt: 'ws event test' });
    await new Promise(r => setTimeout(r, 1500));

    const taskCreated = messages.find(m => m.type === 'task:created');
    assert(!!taskCreated, `no task:created in ${messages.length} messages (types: ${messages.map(m=>m.type).join(',')})`);
    close();
  });

  await test('WS+API', '데몬 stop → WS에서 agent:offline 수신', async () => {
    const { ws, messages, close } = await connectWS();
    await new Promise(r => setTimeout(r, 300));

    await post('/api/daemons/copilot/stop', {});
    await new Promise(r => setTimeout(r, 800));

    const offline = messages.find(m => m.type === 'agent:offline');
    assert(!!offline, 'no agent:offline event');
    // 복구
    await post('/api/daemons/copilot/start', {});
    close();
  });

  // ═══ 결과 ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  전체 결과: ${passed} passed, ${failed} failed`);
  console.log(`  통과율: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log('══════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\n  실패 목록:');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ✗ [${r.category}] ${r.name}: ${r.detail}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
