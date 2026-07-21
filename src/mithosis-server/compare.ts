/**
 * NCO vs Mithosis 실제 성능 비교 스크립트
 *
 * NCO: 병렬 앙상블 + 교차검증 + AdaptiveScorer
 * Mithosis: 단일 최적 에이전트 순차 폴백
 *
 * 동일 QualityGate 척도(0-100)로 공정 비교
 */

const NCO_URL = 'http://localhost:6200';
const MITHOSIS_URL = 'http://localhost:7100';
const AUTH = 'Bearer nco_secret_key_change_me_in_production';

interface TestResult { id: string; score: number; durationMs: number; agentUsed?: string; }

// ── NCO 벤치마크 실행 ──────────────────────────────────────────────────────
async function runNCO(testIds: string[]): Promise<{ avgScore: number; results: TestResult[] }> {
  const resp = await fetch(`${NCO_URL}/api/benchmark/full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ agents: ['opencode', 'codex', 'nvidia'], testIds }),
    signal: AbortSignal.timeout(400_000),
  });
  if (!resp.ok) throw new Error(`NCO error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as any;

  // NCO benchmark/full 응답에서 테스트별 점수 추출
  const results: TestResult[] = [];
  for (const [agentId, stats] of Object.entries(data.agentScores ?? {})) {
    // agentScores는 에이전트별 집계 — 테스트별 세부 결과는 DB에서 조회 필요
    // overallScore = best-of-n 평균
  }
  return {
    avgScore: data.overallScore ?? 0,
    results: Object.entries(data.agentScores ?? {}).map(([id, s]: any) => ({
      id, score: s.avg ?? 0, durationMs: data.durationMs ?? 0,
    })),
  };
}

// ── Mithosis 벤치마크 실행 ────────────────────────────────────────────────
async function runMithosis(testIds: string[]): Promise<{ avgScore: number; results: TestResult[] }> {
  const resp = await fetch(`${MITHOSIS_URL}/api/benchmark/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tests: testIds }),
    signal: AbortSignal.timeout(400_000),
  });
  if (!resp.ok) throw new Error(`Mithosis error: ${resp.status}`);
  const data = await resp.json() as any;
  return {
    avgScore: data.avgScore ?? 0,
    results: (data.results ?? []).map((r: any) => ({
      id: r.testId, score: r.score, durationMs: r.durationMs, agentUsed: r.agentUsed,
    })),
  };
}

// ── DB에서 실제 NCO 벤치마크 최고점 조회 ─────────────────────────────────
async function getNCOBestScores(): Promise<Record<string, number>> {
  const resp = await fetch(`${NCO_URL}/api/benchmark/leaderboard/agents`, {
    headers: { Authorization: AUTH },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return {};
  const data = await resp.json() as any;
  const map: Record<string, number> = {};
  for (const entry of (data ?? [])) {
    map[entry.testName ?? entry.test_name] = entry.bestScore ?? entry.best_score ?? 0;
  }
  return map;
}

function row(cols: string[], widths: number[]): string {
  return '| ' + cols.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
}
function table(rows: string[][]): string {
  const widths = rows[0].map((_, ci) => Math.max(...rows.map(r => (r[ci] ?? '').length)));
  const sep = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|';
  return [row(rows[0], widths), sep, ...rows.slice(1).map(r => row(r, widths))].join('\n');
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  NCO (앙상블) vs Mithosis (순차) — 실제 성능 비교');
  console.log('═'.repeat(60) + '\n');

  // ── 1. DB에 저장된 기존 NCO 벤치마크 결과 ────────────────────────────
  console.log('① 기존 NCO 벤치마크 결과 (DB) 로드...');
  const ncoDb = await getNCOBestScores();
  const ncoDbTests = Object.entries(ncoDb);

  // ── 2. Mithosis 실시간 벤치마크 실행 ─────────────────────────────────
  console.log('② Mithosis 벤치마크 실행 중 (3개 테스트)...\n');
  const MITH_TESTS = ['code_fib', 'code_binary_tree', 'verify_jwt'];

  let mithResult: { avgScore: number; results: TestResult[] };
  try {
    mithResult = await runMithosis(MITH_TESTS);
  } catch (e: any) {
    console.error('Mithosis 오류:', e.message);
    process.exit(1);
  }

  // ── 3. 비교 가능한 공통 테스트 매핑 ──────────────────────────────────
  // NCO DB의 테스트명과 Mithosis 테스트명 매핑
  const mapping: Array<{ name: string; ncoScore: number; mithScore: number; }> = [];

  // NCO DB에서 유사한 테스트 찾기
  const ncoCode = ncoDb['code-01'] ?? ncoDb['code'] ?? 0;
  const ncoDesign = ncoDb['design-01'] ?? ncoDb['design'] ?? 0;
  const ncoVerify = ncoDb['verify_jwt'] ?? ncoDb['verify'] ?? 0;

  const mithFib = mithResult.results.find(r => r.id === 'code_fib')?.score ?? 0;
  const mithBTree = mithResult.results.find(r => r.id === 'code_binary_tree')?.score ?? 0;
  const mithVerify = mithResult.results.find(r => r.id === 'verify_jwt')?.score ?? 0;

  mapping.push(
    { name: 'Code (피보나치/코드)', ncoScore: ncoCode, mithScore: mithFib },
    { name: 'Code (이진트리/코드)', ncoScore: ncoCode, mithScore: mithBTree },
    { name: 'Verify (JWT)', ncoScore: ncoVerify, mithScore: mithVerify },
    { name: 'Design', ncoScore: ncoDesign, mithScore: 0 },
  );

  // ── 4. NCO DB 전체 평균 계산 ─────────────────────────────────────────
  const ncoDbAvg = ncoDbTests.length > 0
    ? ncoDbTests.reduce((s, [, v]) => s + v, 0) / ncoDbTests.length : 0;

  // ── 5. 결과 출력 ──────────────────────────────────────────────────────
  console.log('## NCO DB 기록 (누적 최고점)\n');
  const dbRows: string[][] = [['테스트명', '최고점']];
  for (const [name, score] of ncoDbTests.slice(0, 10)) {
    dbRows.push([name, String(Math.round(score))]);
  }
  console.log(table(dbRows));

  console.log('\n## Mithosis 실시간 결과\n');
  const mithRows: string[][] = [['테스트', '점수', '에이전트', '시간(ms)']];
  for (const r of mithResult.results) {
    mithRows.push([r.id, String(r.score), r.agentUsed ?? '?', String(r.durationMs)]);
  }
  console.log(table(mithRows));

  console.log('\n## 직접 비교\n');
  const cmpRows: string[][] = [['카테고리', 'NCO (DB 최고)', 'Mithosis (실시간)', '차이', '승자']];
  let ncoWins = 0, mithWins = 0;

  for (const m of mapping) {
    if (m.ncoScore === 0 && m.mithScore === 0) continue;
    const diff = m.ncoScore - m.mithScore;
    const winner = diff > 3 ? '✅ NCO' : diff < -3 ? '🔵 Mithosis' : '🤝 동점';
    if (diff > 3) ncoWins++;
    else if (diff < -3) mithWins++;
    cmpRows.push([
      m.name,
      m.ncoScore ? String(m.ncoScore) : '-',
      m.mithScore ? String(m.mithScore) : '-',
      diff !== 0 ? (diff > 0 ? '+' + diff : String(diff)) : '0',
      winner,
    ]);
  }
  console.log(table(cmpRows));

  console.log('\n## 종합\n');
  console.log(table([
    ['항목', 'NCO', 'Mithosis'],
    ['전략', '병렬 앙상블 + 교차검증', '단일 최적 에이전트 순차'],
    ['기록 방식', 'DB 누적 최고점', '실시간 단일 실행'],
    ['평균점', String(Math.round(ncoDbAvg)), String(mithResult.avgScore)],
    ['테스트 승리', `${ncoWins}/${mapping.length}`, `${mithWins}/${mapping.length}`],
  ]));

  console.log('\n## ⚠️  비교의 한계\n');
  console.log('1. NCO 점수는 DB에 누적된 최고점 (반복 실행으로 학습된 값)');
  console.log('2. Mithosis 점수는 최초 1회 실행 결과');
  console.log('3. 둘 다 NCO 내부 QualityGate 척도 (외부 SWE-bench와 다름)');
  console.log('4. 사용 에이전트(opencode, codex 등)가 동일하여 기반 능력은 같음');

  if (ncoDbAvg > mithResult.avgScore + 5) {
    console.log('\n📊 결론: NCO 앙상블이 Mithosis 순차 전략보다 높은 누적 점수를 보입니다.');
    console.log('   단, NCO는 여러 번 실행하여 최고점을 기록한 반면');
    console.log('   Mithosis는 첫 실행 결과임을 감안해야 합니다.');
  } else {
    console.log('\n📊 결론: 두 전략의 성능 차이가 크지 않습니다.');
    console.log('   앙상블의 복잡성이 항상 단일 최적 에이전트보다 낫지는 않습니다.');
  }
}

main().catch(console.error);
