/**
 * NCO Benchmark Suite — SWE-bench / HumanEval 스타일 표준 20 테스트
 *
 * 목적:
 *   - NCO 하네스 성능을 표준 지표로 측정
 *   - 에이전트별·도메인별 점수 비교
 *   - Mithosis 벤치마크(9.0) 대비 NCO 점수 추적
 *
 * 테스트 구성 (20개):
 *   - code(5):     구현·알고리즘·리팩토링
 *   - design(4):   아키텍처·인터페이스·모델링
 *   - review(3):   코드 리뷰·보안 감사
 *   - verify(3):   테스트 생성·검증
 *   - research(3): 분석·조사
 *   - ui(2):       UI/UX 설계
 */

import { getDb } from '../storage/database.js';
import { qualityGate, type TaskType } from './quality-gate.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('benchmark-suite');

export interface BenchmarkTest {
  id: string;
  name: string;
  taskType: TaskType;
  prompt: string;
  expectedKeywords: string[];   // 정답 키워드 (있으면 가점)
  minScore: number;              // 합격 기준점
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface BenchmarkRunResult {
  testId: string;
  agentId: string;
  score: number;
  passed: boolean;
  output: string;
  durationMs: number;
  keywordHits: number;
  keywordTotal: number;
}

export interface BenchmarkReport {
  runId: string;
  timestamp: string;
  agentScores: Record<string, { avg: number; pass: number; total: number }>;
  testScores: Record<string, { avg: number; best: string }>;
  overallScore: number;    // 전체 NCO 점수 (0-10)
  mithosisGap: number;     // Mithosis 9.0 대비 차이
  results: BenchmarkRunResult[];
  durationMs: number;
}

// ── 표준 20 테스트 정의 ───────────────────────────────────────────────────
export const STANDARD_TESTS: BenchmarkTest[] = [
  // ── CODE (5) ──
  {
    id: 'code-01',
    name: '피보나치 메모이제이션',
    taskType: 'code',
    prompt: 'JavaScript로 메모이제이션을 사용한 피보나치 수열 함수를 구현하라. 입력: n(정수), 출력: n번째 피보나치 수. 시간복잡도 O(n), 공간복잡도 O(n) 이하.',
    expectedKeywords: ['memoization', 'cache', 'Map', 'fibonacci', 'function', 'return'],
    minScore: 60,
    difficulty: 'easy',
  },
  {
    id: 'code-02',
    name: 'LRU 캐시 구현',
    taskType: 'code',
    prompt: 'TypeScript로 LRU(Least Recently Used) 캐시를 구현하라. get(key), put(key, value), capacity 지원. O(1) 복잡도.',
    expectedKeywords: ['Map', 'class', 'capacity', 'get', 'put', 'delete', 'size'],
    minScore: 65,
    difficulty: 'medium',
  },
  {
    id: 'code-03',
    name: '비동기 큐 처리기',
    taskType: 'code',
    prompt: 'TypeScript로 동시성 제한(concurrency limit)이 있는 비동기 작업 큐를 구현하라. 최대 N개의 작업이 동시에 실행되어야 한다.',
    expectedKeywords: ['async', 'await', 'Promise', 'queue', 'concurrency', 'limit'],
    minScore: 65,
    difficulty: 'hard',
  },
  {
    id: 'code-04',
    name: '이진 트리 직렬화',
    taskType: 'code',
    prompt: '이진 트리를 JSON 문자열로 직렬화(serialize)하고 역직렬화(deserialize)하는 함수를 TypeScript로 구현하라.',
    expectedKeywords: ['serialize', 'deserialize', 'JSON', 'TreeNode', 'null', 'recursive'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'code-05',
    name: 'REST API 미들웨어',
    taskType: 'code',
    prompt: 'Express.js 스타일의 rate-limiting 미들웨어를 구현하라. 윈도우(ms)당 요청 수를 IP별로 제한하고, 초과 시 429 반환.',
    expectedKeywords: ['middleware', 'rateLimit', 'ip', '429', 'window', 'limit', 'Map'],
    minScore: 60,
    difficulty: 'medium',
  },

  // ── DESIGN (4) ──
  {
    id: 'design-01',
    name: '마이크로서비스 아키텍처 설계',
    taskType: 'design',
    prompt: '전자상거래 플랫폼을 위한 마이크로서비스 아키텍처를 설계하라. 주문, 결제, 재고, 알림 서비스를 포함하고 서비스 간 통신 방법, 데이터 격리, API 게이트웨이를 명시하라.',
    expectedKeywords: ['service', 'API', 'gateway', 'message', 'queue', 'database', 'event'],
    minScore: 65,
    difficulty: 'hard',
  },
  {
    id: 'design-02',
    name: 'SQLite 스키마 설계',
    taskType: 'design',
    prompt: '멀티테넌트 SaaS 블로그 플랫폼을 위한 SQLite 스키마를 설계하라. 테넌트, 사용자, 포스트, 댓글, 태그 관계를 포함하고 인덱스 전략도 제시하라.',
    expectedKeywords: ['CREATE TABLE', 'INDEX', 'FOREIGN KEY', 'tenant_id', 'PRIMARY KEY'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'design-03',
    name: '이벤트 소싱 설계',
    taskType: 'design',
    prompt: '이벤트 소싱(Event Sourcing) 패턴을 사용한 주문 관리 시스템의 인터페이스와 데이터 흐름을 설계하라. Aggregate, Event Store, Projection을 포함하라.',
    expectedKeywords: ['event', 'store', 'aggregate', 'projection', 'command', 'snapshot'],
    minScore: 60,
    difficulty: 'hard',
  },
  {
    id: 'design-04',
    name: 'WebSocket 상태 동기화',
    taskType: 'design',
    prompt: 'N명의 사용자가 동시에 편집하는 협업 텍스트 에디터의 실시간 상태 동기화 아키텍처를 설계하라. 충돌 해결 전략과 오프라인 지원을 포함하라.',
    expectedKeywords: ['WebSocket', 'CRDT', 'OT', 'conflict', 'sync', 'offline', 'merge'],
    minScore: 55,
    difficulty: 'hard',
  },

  // ── REVIEW (3) ──
  {
    id: 'review-01',
    name: 'SQL 인젝션 취약점 감사',
    taskType: 'review',
    prompt: `다음 코드의 보안 취약점을 분석하고 수정 방법을 제시하라:\n\`\`\`js\napp.get('/user', (req, res) => {\n  const id = req.query.id;\n  db.query('SELECT * FROM users WHERE id=' + id, (err, result) => { res.json(result); });\n});\n\`\`\``,
    expectedKeywords: ['SQL injection', 'parameterized', 'prepared statement', 'sanitize', '취약'],
    minScore: 65,
    difficulty: 'easy',
  },
  {
    id: 'review-02',
    name: '코드 품질 리뷰',
    taskType: 'review',
    prompt: `다음 TypeScript 함수의 문제점과 개선 방법을 리뷰하라:\n\`\`\`ts\nfunction processData(data: any) {\n  let result = [];\n  for(let i=0; i<data.length; i++) {\n    if(data[i] != null && data[i] != undefined) {\n      result.push(data[i].value * 2);\n    }\n  }\n  return result;\n}\n\`\`\``,
    expectedKeywords: ['type', 'filter', 'map', 'null', 'undefined', 'refactor', 'strict'],
    minScore: 60,
    difficulty: 'easy',
  },
  {
    id: 'review-03',
    name: '성능 병목 감사',
    taskType: 'review',
    prompt: 'N+1 쿼리 문제가 있는 ORM 코드 패턴을 설명하고, eager loading / dataloader 패턴으로 해결하는 방법을 TypeScript 예시와 함께 제시하라.',
    expectedKeywords: ['N+1', 'eager', 'include', 'DataLoader', 'batch', 'query', 'JOIN'],
    minScore: 60,
    difficulty: 'medium',
  },

  // ── VERIFY (3) ──
  {
    id: 'verify-01',
    name: 'JWT 검증 테스트',
    taskType: 'verify',
    prompt: 'JWT 토큰 검증 함수에 대한 단위 테스트를 Vitest로 작성하라. 유효한 토큰, 만료 토큰, 서명 불일치, null/undefined 입력 케이스를 포함하라.',
    expectedKeywords: ['test', 'describe', 'expect', 'jwt', 'expired', 'invalid', 'null'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'verify-02',
    name: 'API 엔드포인트 통합테스트',
    taskType: 'verify',
    prompt: 'Fastify REST API의 POST /api/users 엔드포인트에 대한 통합 테스트를 작성하라. 성공 케이스, 중복 이메일, 유효성 검사 실패를 커버하라.',
    expectedKeywords: ['supertest', 'inject', 'status', '201', '400', '409', 'body'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'verify-03',
    name: '동시성 경쟁 조건 검증',
    taskType: 'verify',
    prompt: '동시에 동일 자원에 접근하는 Race Condition을 감지하는 테스트 전략을 설명하고, Promise.all()로 동시 요청을 시뮬레이션하는 테스트 코드를 작성하라.',
    expectedKeywords: ['race', 'concurrent', 'Promise.all', 'lock', 'atomic', 'test'],
    minScore: 55,
    difficulty: 'hard',
  },

  // ── RESEARCH (3) ──
  {
    id: 'research-01',
    name: 'Redis vs Memcached 비교',
    taskType: 'research',
    prompt: 'Redis와 Memcached의 기술적 차이점을 비교 분석하라. 데이터 구조, 영속성, 클러스터링, 사용 사례를 포함한 구체적 수치와 벤치마크를 제시하라.',
    expectedKeywords: ['Redis', 'Memcached', 'persistence', 'cluster', 'data structure', '비교'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'research-02',
    name: 'LLM 추론 최적화 기법',
    taskType: 'research',
    prompt: 'LLM 추론 속도를 높이는 최신 기법(Speculative Decoding, Flash Attention, KV-Cache, Quantization)을 조사하고, 각 기법의 원리·장단점·적용 조건을 분석하라.',
    expectedKeywords: ['speculative', 'flash attention', 'KV cache', 'quantization', 'latency', 'token'],
    minScore: 60,
    difficulty: 'hard',
  },
  {
    id: 'research-03',
    name: 'CAP 정리 실제 적용',
    taskType: 'research',
    prompt: 'CAP 정리(Consistency, Availability, Partition Tolerance)를 분산 시스템에서 실제로 어떻게 적용하는지 설명하라. MongoDB, Cassandra, etcd 각각의 선택을 분석하라.',
    expectedKeywords: ['CAP', 'consistency', 'availability', 'partition', 'MongoDB', 'Cassandra'],
    minScore: 55,
    difficulty: 'medium',
  },

  // ── UI (2) ──
  {
    id: 'ui-01',
    name: '대시보드 컴포넌트 설계',
    taskType: 'ui',
    prompt: 'AI 에이전트 모니터링 대시보드를 위한 React 컴포넌트 구조를 설계하라. 실시간 에이전트 상태, 작업 큐, 성능 차트를 포함하는 레이아웃과 상태 관리 전략을 제시하라.',
    expectedKeywords: ['component', 'useState', 'useEffect', 'WebSocket', 'chart', 'layout', 'props'],
    minScore: 60,
    difficulty: 'medium',
  },
  {
    id: 'ui-02',
    name: 'Tailwind 반응형 네비게이션',
    taskType: 'ui',
    prompt: 'Tailwind CSS로 모바일 우선 반응형 내비게이션 바를 설계하라. 햄버거 메뉴, 드롭다운 서브메뉴, 다크모드 지원을 포함하라.',
    expectedKeywords: ['tailwind', 'responsive', 'md:', 'dark:', 'hamburger', 'dropdown', 'mobile'],
    minScore: 55,
    difficulty: 'easy',
  },
];

class BenchmarkSuiteRunner {
  private readonly MITHOSIS_TARGET = 9.0;  // Mithosis 기준 점수

  /**
   * 단일 테스트를 단일 에이전트로 실행
   */
  async runTest(
    test: BenchmarkTest,
    agentId: string,
    executor: (agentId: string, prompt: string) => Promise<string>,
  ): Promise<BenchmarkRunResult> {
    const start = Date.now();
    try {
      const output = await executor(agentId, test.prompt);
      const quality = qualityGate.evaluate(output, test.prompt, test.taskType);

      // 키워드 히트 보너스 계산
      const lowerOutput = output.toLowerCase();
      const keywordHits = test.expectedKeywords.filter(
        kw => lowerOutput.includes(kw.toLowerCase())
      ).length;

      // 키워드 보너스: 최대 +10점 (품질 점수 한도 초과 가능)
      const bonusRatio = test.expectedKeywords.length > 0
        ? keywordHits / test.expectedKeywords.length
        : 1;
      const finalScore = Math.min(100, quality.score + bonusRatio * 10);

      qualityGate.recordPerformance(agentId, test.taskType, finalScore, output.length, Date.now() - start, true);

      return {
        testId: test.id,
        agentId,
        score: Math.round(finalScore),
        passed: finalScore >= test.minScore,
        output: output.slice(0, 1000), // DB 저장용 축약
        durationMs: Date.now() - start,
        keywordHits,
        keywordTotal: test.expectedKeywords.length,
      };
    } catch (e: any) {
      qualityGate.recordPerformance(agentId, test.taskType, 0, 0, Date.now() - start, false);
      return {
        testId: test.id,
        agentId,
        score: 0,
        passed: false,
        output: `[ERROR] ${e.message}`,
        durationMs: Date.now() - start,
        keywordHits: 0,
        keywordTotal: test.expectedKeywords.length,
      };
    }
  }

  /**
   * 전체 벤치마크 실행
   * @param agentIds 테스트할 에이전트 목록
   * @param executor 에이전트 실행 함수
   * @param testIds 특정 테스트만 실행 (미지정 시 전체)
   */
  async runAll(
    agentIds: string[],
    executor: (agentId: string, prompt: string) => Promise<string>,
    testIds?: string[],
  ): Promise<BenchmarkReport> {
    const runId = `bench_${Date.now()}`;
    const start = Date.now();
    const tests = testIds
      ? STANDARD_TESTS.filter(t => testIds.includes(t.id))
      : STANDARD_TESTS;

    log.info({ runId, agents: agentIds.length, tests: tests.length }, 'Benchmark started');

    const allResults: BenchmarkRunResult[] = [];

    // 테스트별 × 에이전트별 순차 실행 (병렬은 API 과부하 위험)
    for (const test of tests) {
      for (const agentId of agentIds) {
        const result = await this.runTest(test, agentId, executor);
        allResults.push(result);
        this.persistResult(runId, result);
        log.debug({ testId: test.id, agentId, score: result.score, passed: result.passed }, 'Test complete');
      }
    }

    // ── 통계 집계 ──────────────────────────────────────────────────────
    const agentScores: Record<string, { avg: number; pass: number; total: number }> = {};
    const testScores: Record<string, { avg: number; best: string }> = {};

    for (const r of allResults) {
      if (!agentScores[r.agentId]) agentScores[r.agentId] = { avg: 0, pass: 0, total: 0 };
      agentScores[r.agentId].total++;
      agentScores[r.agentId].pass += r.passed ? 1 : 0;
      agentScores[r.agentId].avg += r.score;
    }
    for (const id of Object.keys(agentScores)) {
      agentScores[id].avg = Math.round(agentScores[id].avg / agentScores[id].total);
    }

    for (const test of tests) {
      const testResults = allResults.filter(r => r.testId === test.id);
      const avg = testResults.reduce((s, r) => s + r.score, 0) / testResults.length;
      const best = testResults.sort((a, b) => b.score - a.score)[0]?.agentId ?? 'unknown';
      testScores[test.id] = { avg: Math.round(avg), best };
    }

    // ── NCO 총점 계산 (0-10) ──────────────────────────────────────────
    const allAvg = allResults.reduce((s, r) => s + r.score, 0) / (allResults.length || 1);
    const passRate = allResults.filter(r => r.passed).length / (allResults.length || 1);
    const overallScore = Math.round(((allAvg / 100) * 7 + passRate * 3) * 10) / 10;
    const mithosisGap = Math.round((this.MITHOSIS_TARGET - overallScore) * 100) / 100;

    const report: BenchmarkReport = {
      runId,
      timestamp: new Date().toISOString(),
      agentScores,
      testScores,
      overallScore,
      mithosisGap,
      results: allResults,
      durationMs: Date.now() - start,
    };

    this.persistReport(report);
    log.info({
      runId, overallScore, mithosisGap, agents: agentIds.length,
      passRate: (passRate * 100).toFixed(1) + '%',
    }, 'Benchmark complete');

    return report;
  }

  /**
   * 특정 도메인만 빠른 벤치마크
   */
  async quickBenchmark(
    agentIds: string[],
    taskType: TaskType,
    executor: (agentId: string, prompt: string) => Promise<string>,
  ): Promise<BenchmarkReport> {
    const testIds = STANDARD_TESTS
      .filter(t => t.taskType === taskType)
      .map(t => t.id);
    return this.runAll(agentIds, executor, testIds);
  }

  getTests(): BenchmarkTest[] { return STANDARD_TESTS; }

  getTest(id: string): BenchmarkTest | undefined {
    return STANDARD_TESTS.find(t => t.id === id);
  }

  /**
   * 최근 벤치마크 결과 조회 (leaderboard)
   */
  getLeaderboard(limit = 5): Array<{ agentId: string; avgScore: number; passRate: number }> {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT agent_id,
                AVG(score) as avg_score,
                SUM(CASE WHEN passed=1 THEN 1 ELSE 0 END)*1.0/COUNT(*) as pass_rate,
                COUNT(*) as total
         FROM benchmark_results
         GROUP BY agent_id
         HAVING total >= 5
         ORDER BY avg_score DESC
         LIMIT ?`
      ).all(limit) as any[];

      return rows.map(r => ({
        agentId: r.agent_id,
        avgScore: Math.round(r.avg_score),
        passRate: Math.round(r.pass_rate * 100),
      }));
    } catch {
      return [];
    }
  }

  private persistResult(runId: string, result: BenchmarkRunResult): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO benchmark_results (run_id, test_name, agent_id, score, passed, output_preview, duration_ms, keyword_hits, keyword_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId, result.testId, result.agentId, result.score,
        result.passed ? 1 : 0, result.output.slice(0, 500), result.durationMs,
        result.keywordHits, result.keywordTotal,
      );
    } catch { /* non-critical */ }
  }

  private persistReport(report: BenchmarkReport): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT OR IGNORE INTO benchmark_runs (run_id, overall_score, mithosis_gap, agent_count, test_count, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        report.runId, report.overallScore, report.mithosisGap,
        Object.keys(report.agentScores).length, report.results.length,
        report.durationMs,
      );
    } catch { /* non-critical */ }
  }
}

export const benchmarkSuite = new BenchmarkSuiteRunner();
