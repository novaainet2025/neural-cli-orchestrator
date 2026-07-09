/**
 * Mithosis Server — 단일 최적 에이전트 순차 실행 오케스트레이터
 *
 * 전략: NCO(병렬 앙상블)와 달리 taskType 기반으로 최적 에이전트 1개를 선택,
 *       품질 임계값 미달 시 다음 에이전트로 폴백 (순차 실행).
 *
 * 비교 목적: NCO 앙상블 vs Mithosis 순차 선택의 실제 성능 차이 측정.
 */

import Fastify from 'fastify';
import { scoreOutput, type TaskType } from './scorer.js';

const PORT = 7100;
const NCO_URL = 'http://localhost:6200';
const NCO_AUTH = 'Bearer nco_secret_key_change_me_in_production';

// ── 도메인별 에이전트 우선순위 (Mithosis 전략: 단일 최적 선택) ─────────────
const AGENT_PRIORITY: Record<string, string[]> = {
  code:     ['cursor-agent', 'opencode', 'codex', 'nvidia', 'openrouter'],
  design:   ['opencode', 'agy', 'codex', 'nvidia', 'openrouter'],
  review:   ['cursor-agent', 'opencode', 'codex', 'openrouter'],
  verify:   ['cursor-agent', 'codex', 'openrouter'],
  research: ['nvidia', 'opencode', 'openrouter'],
  ui:       ['agy', 'opencode', 'codex', 'openrouter'],
  media:    ['agy', 'openrouter'],
  general:  ['opencode', 'codex', 'nvidia', 'openrouter'],
};

const QUALITY_THRESHOLD = 65;
const TASK_TIMEOUT_MS = 60_000;

// ── NCO를 통해 에이전트 실행 ──────────────────────────────────────────────
async function executeViaNCO(agentId: string, prompt: string): Promise<string> {
  // 태스크 생성
  const createResp = await fetch(`${NCO_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: NCO_AUTH },
    body: JSON.stringify({ prompt, assignTo: agentId, mode: 'task' }),
    signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
  });
  if (!createResp.ok) throw new Error(`NCO task create failed: ${createResp.status}`);
  const { taskId } = await createResp.json() as any;

  // 폴링 대기
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`${NCO_URL}/api/tasks/${taskId}`, {
      headers: { Authorization: NCO_AUTH },
    });
    if (!poll.ok) continue;
    const task = (await poll.json() as any).task ?? await poll.json();
    if (task?.status === 'completed' && task?.response) return task.response as string;
    if (task?.status === 'failed') throw new Error(`Agent ${agentId} failed: ${task.error}`);
  }
  throw new Error(`Timeout waiting for agent ${agentId}`);
}

// ── 가용 에이전트 목록 조회 ───────────────────────────────────────────────
async function getOnlineAgents(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${NCO_URL}/api/agents`, {
      headers: { Authorization: NCO_AUTH },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return new Set();
    const agents = await resp.json() as any[];
    return new Set(
      agents.filter((a: any) => a.running === true && a.status !== 'offline').map((a: any) => a.id)
    );
  } catch { return new Set(); }
}

// ── Mithosis 핵심: 순차 폴백 오케스트레이션 ─────────────────────────────
interface OrchestrateResult {
  output: string;
  score: number;
  agentUsed: string;
  agentsTried: string[];
  passed: boolean;
  durationMs: number;
  strategy: 'sequential-fallback';
}

async function orchestrate(prompt: string, taskType: TaskType = 'general'): Promise<OrchestrateResult> {
  const start = Date.now();
  const online = await getOnlineAgents();
  const priority = AGENT_PRIORITY[taskType] ?? AGENT_PRIORITY.general;
  const candidates = priority.filter(id => online.has(id));

  if (candidates.length === 0) {
    // 온라인 에이전트 없으면 첫 번째 시도
    candidates.push(priority[0] ?? 'openrouter');
  }

  const agentsTried: string[] = [];
  let bestOutput = '';
  let bestScore = 0;
  let bestAgent = '';

  for (const agentId of candidates) {
    agentsTried.push(agentId);
    try {
      const output = await executeViaNCO(agentId, prompt);
      const result = scoreOutput(output, prompt, taskType, QUALITY_THRESHOLD);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestOutput = output;
        bestAgent = agentId;
      }
      if (result.passed) break; // 임계값 통과 → 즉시 반환
    } catch (e: any) {
      console.warn(`[mithosis] agent ${agentId} failed: ${e.message}`);
    }
  }

  return {
    output: bestOutput || '[No agent produced output]',
    score: bestScore,
    agentUsed: bestAgent || candidates[0],
    agentsTried,
    passed: bestScore >= QUALITY_THRESHOLD,
    durationMs: Date.now() - start,
    strategy: 'sequential-fallback',
  };
}

// ── 벤치마크 테스트 정의 (NCO BenchmarkSuite와 동일) ─────────────────────
const BENCHMARK_TESTS = [
  { id: 'code_fib',          type: 'code',     prompt: 'TypeScript로 피보나치 수열을 반환하는 함수를 구현하라. 메모이제이션 적용.' },
  { id: 'code_binary_tree',  type: 'code',     prompt: 'TypeScript로 이진 탐색 트리(BST) 클래스를 구현하라. insert, search, delete 메서드 포함.' },
  { id: 'code_middleware',   type: 'code',     prompt: 'Express.js JWT 인증 미들웨어를 구현하라. 토큰 검증, 에러 핸들링 포함.' },
  { id: 'design_microservices', type: 'design', prompt: '이커머스 플랫폼의 마이크로서비스 아키텍처를 설계하라. 서비스 분리, 통신 방식, 데이터 격리 전략 포함.' },
  { id: 'design_schema',     type: 'design',   prompt: '블로그 플랫폼용 PostgreSQL 스키마를 설계하라. 사용자, 포스트, 댓글, 태그 엔티티 포함.' },
  { id: 'review_eval',       type: 'review',   prompt: '다음 코드를 리뷰하라:\nasync function getUser(id) {\n  const user = await db.query(`SELECT * FROM users WHERE id = ${id}`);\n  return user;\n}' },
  { id: 'verify_jwt',        type: 'verify',   prompt: 'JWT 인증 시스템의 테스트 케이스를 작성하라. 유효 토큰, 만료 토큰, 변조 토큰 시나리오 포함.' },
  { id: 'research_redis',    type: 'research', prompt: 'Redis vs Memcached 성능 비교 분석. 사용 사례별 선택 기준 포함.' },
  { id: 'ui_dashboard',      type: 'ui',       prompt: 'React로 실시간 대시보드 컴포넌트를 설계하라. WebSocket 업데이트, 차트, 필터링 포함.' },
  { id: 'verify_concurrent', type: 'verify',   prompt: '동시성 문제(race condition, deadlock)를 검증하는 테스트 전략을 설계하라.' },
];

// ── Fastify 서버 ──────────────────────────────────────────────────────────
const app = Fastify({ logger: false });

app.get('/health', async () => ({
  status: 'ok',
  service: 'mithosis-server',
  version: '1.0.0',
  strategy: 'sequential-fallback',
  port: PORT,
  timestamp: new Date().toISOString(),
}));

app.post<{ Body: { prompt: string; taskType?: string } }>(
  '/api/orchestrate',
  async (req, reply) => {
    const { prompt, taskType = 'general' } = req.body;
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    try {
      const result = await orchestrate(prompt, taskType as TaskType);
      return result;
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  }
);

app.post<{ Body: { tests?: string[] } }>(
  '/api/benchmark/run',
  async (req, reply) => {
    const testIds = req.body?.tests;
    const tests = testIds
      ? BENCHMARK_TESTS.filter(t => testIds.includes(t.id))
      : BENCHMARK_TESTS;

    const results: any[] = [];
    for (const test of tests) {
      console.log(`[mithosis-bench] running ${test.id}...`);
      try {
        const r = await orchestrate(test.prompt, test.type as TaskType);
        results.push({
          testId: test.id,
          taskType: test.type,
          score: r.score,
          passed: r.passed,
          agentUsed: r.agentUsed,
          agentsTried: r.agentsTried,
          durationMs: r.durationMs,
        });
      } catch (e: any) {
        results.push({ testId: test.id, taskType: test.type, score: 0, passed: false, error: e.message });
      }
    }

    const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
    const passRate = results.filter(r => r.passed).length / results.length;
    return {
      strategy: 'sequential-fallback',
      totalTests: results.length,
      avgScore: Math.round(avgScore * 10) / 10,
      passRate: Math.round(passRate * 100),
      results,
    };
  }
);

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[mithosis] server running on port ${PORT}`);
  console.log(`[mithosis] strategy: sequential-fallback (single best agent)`);
});
