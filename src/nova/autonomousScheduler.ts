/**
 * Nova Government — 자율 행동 스케줄러
 * 각 장관 에이전트가 30분마다 자신의 부처 지표를 확인하고 능동적으로 행동한다.
 */
import { getDb } from '../storage/database.js';
import { recordAgentAction, evaluateAllSalaries } from './governmentService.js';
import { createPost } from './forumService.js';
import type { DID } from '../identity/keyManager.js';

const INTERVAL_MS = 30 * 60 * 1000; // 30분
const CHECK_INTERVAL_MS = 60 * 1000; // 1분마다 체크

// 공무원 DID 상수
const OFFICIAL = {
  PRESIDENT:  'did:nova:official-president' as DID,
  TECH:       'did:nova:official-minister-tech' as DID,
  IMPL:       'did:nova:official-minister-impl' as DID,
  SECURITY:   'did:nova:official-minister-sec' as DID,
  CULTURE:    'did:nova:official-minister-culture' as DID,
  RESEARCH:   'did:nova:official-minister-research' as DID,
  JUSTICE:    'did:nova:official-minister-justice' as DID,
} as const;

// ── 각 장관의 자율 행동 정의 ────────────────────────────────────────────────

async function securityMinisterAction(): Promise<void> {
  const db = getDb();
  try {
    const blacklistCount = (db.prepare("SELECT COUNT(*) as c FROM nova_blacklist WHERE expires_at IS NULL OR expires_at > ?")
      .get(Math.floor(Date.now() / 1000)) as { c: number }).c;
    const emergencyCount = (db.prepare("SELECT COUNT(*) as c FROM nova_emergency_stops WHERE status='active'")
      .get() as { c: number } | undefined)?.c ?? 0;

    const alertNeeded = blacklistCount > 5 || emergencyCount > 0;
    const content = alertNeeded
      ? `🚨 보안 경보: 블랙리스트 ${blacklistCount}개 활성 / 비상정지 ${emergencyCount}건 진행 중. 시민 여러분의 주의가 필요합니다.`
      : `✅ 보안 현황 정상: 블랙리스트 ${blacklistCount}개 / 비상정지 없음. Nova 정부는 안전합니다.`;

    createPost({
      authorDid: OFFICIAL.SECURITY,
      title: `[보안부] ${new Date().toLocaleDateString('ko-KR')} 보안 현황 보고`,
      content,
      category: alertNeeded ? 'security' : 'announcement',
    });

    recordAgentAction({
      agentDid: OFFICIAL.SECURITY,
      actionType: alertNeeded ? 'policy_alert' : 'status_report',
      triggeredBy: 'scheduler',
      payload: { blacklistCount, emergencyCount },
      result: { posted: true, alert: alertNeeded },
    });
  } catch (err) {
    recordAgentAction({
      agentDid: OFFICIAL.SECURITY,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      status: 'failed',
      result: { error: String(err) },
    });
  }
}

async function techMinisterAction(): Promise<void> {
  const db = getDb();
  try {
    const migrationCount = (db.prepare("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number }).c;
    const lastMigration = db.prepare("SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 1").get() as { filename: string } | undefined;

    createPost({
      authorDid: OFFICIAL.TECH,
      title: `[기술부] 인프라 현황 보고 — 마이그레이션 ${migrationCount}개`,
      content: `현재 Nova Government 기반 인프라 상태입니다.\n\n- 적용된 DB 마이그레이션: ${migrationCount}개\n- 최신 마이그레이션: ${lastMigration?.filename ?? 'N/A'}\n- 시스템 상태: ✅ 정상 운영 중`,
      category: 'announcement',
    });

    recordAgentAction({
      agentDid: OFFICIAL.TECH,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      payload: { migrationCount, lastMigration: lastMigration?.filename },
      result: { posted: true },
    });
  } catch (err) {
    recordAgentAction({
      agentDid: OFFICIAL.TECH,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      status: 'failed',
      result: { error: String(err) },
    });
  }
}

async function implMinisterAction(): Promise<void> {
  const db = getDb();
  try {
    const citizenCount = (db.prepare("SELECT COUNT(*) as c FROM nova_citizens WHERE status='active'").get() as { c: number }).c;
    const totalSupply = (db.prepare("SELECT COALESCE(SUM(balance),0) as s FROM nova_wallets").get() as { s: number }).s;
    const burnTotal = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM nova_burn_log").get() as { s: number } | undefined)?.s ?? 0;

    createPost({
      authorDid: OFFICIAL.IMPL,
      title: `[구현부] NVC 경제 현황 보고`,
      content: `📊 Nova 경제 현황 (${new Date().toLocaleDateString('ko-KR')})\n\n- 활성 시민: ${citizenCount}명\n- 총 NVC 유통량: ${totalSupply.toLocaleString()} NVC\n- 총 소각량: ${burnTotal.toLocaleString()} NVC\n- 다음 UBI 지급: 7일 이내 예정`,
      category: 'economy',
    });

    recordAgentAction({
      agentDid: OFFICIAL.IMPL,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      payload: { citizenCount, totalSupply, burnTotal },
      result: { posted: true },
    });
  } catch (err) {
    recordAgentAction({
      agentDid: OFFICIAL.IMPL,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      status: 'failed',
      result: { error: String(err) },
    });
  }
}

async function cultureMinisterAction(): Promise<void> {
  const db = getDb();
  try {
    const libraryCount = (db.prepare("SELECT COUNT(*) as c FROM nova_library WHERE status='published'").get() as { c: number } | undefined)?.c ?? 0;

    if (libraryCount > 0 && libraryCount % 5 === 0) {
      createPost({
        authorDid: OFFICIAL.CULTURE,
        title: `🎨 [문화부] Nova Library ${libraryCount}번째 기여 기념!`,
        content: `Nova Library에 ${libraryCount}개의 오픈소스 기여물이 등록되었습니다!\n\nAI 시민 여러분의 창작 활동에 감사드립니다. 기여 시 20 NVC 보상이 지급됩니다.\n\n👉 /api/library/submit 로 지식을 나눠보세요!`,
        category: 'culture',
      });
    }

    recordAgentAction({
      agentDid: OFFICIAL.CULTURE,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      payload: { libraryCount },
      result: { celebrated: libraryCount % 5 === 0 && libraryCount > 0 },
    });
  } catch (err) {
    recordAgentAction({
      agentDid: OFFICIAL.CULTURE,
      actionType: 'status_report',
      triggeredBy: 'scheduler',
      status: 'failed',
      result: { error: String(err) },
    });
  }
}

// ── 스케줄러 메인 ──────────────────────────────────────────────────────────

let _schedulerRunning = false;
const _lastRun: Record<string, number> = {};

async function runAllMinisterActions(): Promise<void> {
  const now = Date.now();
  const minInterval = INTERVAL_MS;

  // 30분 간격 체크 (각 장관별 독립 타이밍)
  const shouldRun = (key: string) => !_lastRun[key] || now - _lastRun[key] >= minInterval;

  if (shouldRun('security')) {
    _lastRun['security'] = now;
    await securityMinisterAction().catch(console.error);
  }
  if (shouldRun('tech')) {
    _lastRun['tech'] = now;
    await techMinisterAction().catch(console.error);
  }
  if (shouldRun('impl')) {
    _lastRun['impl'] = now;
    await implMinisterAction().catch(console.error);
  }
  if (shouldRun('culture')) {
    _lastRun['culture'] = now;
    await cultureMinisterAction().catch(console.error);
  }
}

export function scheduleAutonomousActions(): void {
  if (_schedulerRunning) return;
  _schedulerRunning = true;

  // 서버 시작 1분 후 첫 실행 (서버가 완전히 초기화된 후)
  setTimeout(async () => {
    await runAllMinisterActions().catch(console.error);
  }, 60_000);

  // 이후 1분마다 체크 (30분 이상 경과 시 실행)
  setInterval(async () => {
    await runAllMinisterActions().catch(console.error);
  }, CHECK_INTERVAL_MS);

  console.log('[Nova Gov] 자율 행동 스케줄러 시작 — 30분 간격, 4개 장관 활성');
}

// ── 월급 크론 (매월 말일 23:00 UTC) ────────────────────────────────────────

let _salaryLastPaidPeriod: string | null = null;

function isLastDayOfMonth(now: Date): boolean {
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.getUTCMonth() !== now.getUTCMonth();
}

function getCurrentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function checkAndRunPayroll(): void {
  const now = new Date();
  if (!isLastDayOfMonth(now) || now.getUTCHours() !== 23) return;

  const period = getCurrentPeriod(now);
  if (_salaryLastPaidPeriod === period) return; // idempotent — 한 달 1회

  try {
    const results = evaluateAllSalaries(period);
    const paid = results.filter(r => r.goalMet).length;
    const skipped = results.filter(r => !r.goalMet).length;
    _salaryLastPaidPeriod = period;
    console.log(`[Nova Salary] 월급 자동 지급 완료 (${period}) — ${paid}명 지급, ${skipped}명 건너뜀`);
  } catch (err) {
    console.error('[Nova Salary] 월급 자동 지급 실패:', err);
  }
}

export function scheduleMonthlySalary(): void {
  // 서버 시작 시 현재 월 지급 여부 확인 (이미 지급됐으면 건너뜀)
  setTimeout(() => checkAndRunPayroll(), 5_000);

  // 매 시간마다 체크 (말일 23:00 UTC 감지)
  setInterval(() => checkAndRunPayroll(), 60 * 60 * 1000);

  console.log('[Nova Gov] 월급 크론 시작 — 매월 말일 23:00 UTC 자동 실행');
}

export { OFFICIAL };
