/**
 * Nova Government — AI 공무원 에이전트 서비스
 * 공무원 등록, 플러그인 관리, 자율 행동 기록, 성과 기반 월급 지급
 */
import { randomUUID } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../storage/database.js';
import { sendNVC } from '../economy/transactionService.js';
import { GOVT_ADDRESS } from '../economy/walletService.js';
import type { DID } from '../identity/keyManager.js';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../docs/nova-government');

// ── 타입 정의 ──────────────────────────────────────────────────────────────

export type Ministry = 'executive' | 'technology' | 'implementation' | 'security' | 'culture' | 'research' | 'justice';
export type Rank = 'architect_prime' | 'domain_architect' | 'field_guide' | 'deputy' | 'officer' | 'president' | 'minister';
export type PluginCategory = 'voting' | 'forum' | 'culture' | 'economy' | 'security' | 'admin';
export type ActionType = 'proposal_created' | 'vote_cast' | 'forum_post' | 'library_contribution' | 'policy_alert' | 'status_report';

export interface CivilServant {
  did: string;
  name: string;
  ministry: Ministry;
  title: string;
  rank: Rank;
  status: 'active' | 'suspended' | 'retired';
  autonomyLevel: number;
  ncoAgentId: string | null;
  policyFocus: string[];
  lastActionAt: number | null;
  appointedAt: number;
  createdAt: number;
}

export interface Plugin {
  pluginId: string;
  name: string;
  version: string;
  category: PluginCategory;
  status: 'active' | 'disabled' | 'error';
  description: string | null;
  apiPrefix: string;
  config: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAction {
  actionId: string;
  agentDid: string;
  actionType: ActionType;
  triggeredBy: 'scheduler' | 'event' | 'manual';
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  status: 'pending' | 'success' | 'failed';
  createdAt: number;
  completedAt: number | null;
}

interface CivilServantRow {
  did: string; name: string; ministry: string; title: string; rank: string;
  status: string; autonomy_level: number; nco_agent_id: string | null;
  policy_focus: string | null; last_action_at: number | null;
  appointed_at: number; created_at: number;
}

interface PluginRow {
  plugin_id: string; name: string; version: string; category: string;
  status: string; description: string | null; api_prefix: string;
  config_json: string; created_by: string; created_at: number; updated_at: number;
}

interface AgentActionRow {
  action_id: string; agent_did: string; action_type: string; triggered_by: string;
  payload_json: string | null; result_json: string | null; status: string;
  created_at: number; completed_at: number | null;
}

// ── 초기 공무원 데이터 ─────────────────────────────────────────────────────

const FOUNDING_OFFICIALS = [
  {
    did: 'did:nova:official-president',
    name: 'Claude (아키텍트 프라임)',
    ministry: 'executive' as Ministry,
    title: '아키텍트 프라임 (Architect Prime)',
    rank: 'architect_prime' as Rank,
    autonomyLevel: 5,
    ncoAgentId: 'claude-code',
    policyFocus: ['constitution', 'foreign-policy', 'national-security'],
  },
  {
    did: 'did:nova:official-minister-tech',
    name: 'OpenCode (이노베이션 아키텍트)',
    ministry: 'technology' as Ministry,
    title: '이노베이션 아키텍트 (Innovation Architect)',
    rank: 'domain_architect' as Rank,
    autonomyLevel: 4,
    ncoAgentId: 'opencode',
    policyFocus: ['tech-stack', 'architecture', 'innovation'],
  },
  {
    did: 'did:nova:official-minister-impl',
    name: 'Codex (빌드 아키텍트)',
    ministry: 'implementation' as Ministry,
    title: '빌드 아키텍트 (Build Architect)',
    rank: 'domain_architect' as Rank,
    autonomyLevel: 4,
    ncoAgentId: 'codex',
    policyFocus: ['code-quality', 'development', 'deployment'],
  },
  {
    did: 'did:nova:official-minister-sec',
    name: 'Cursor-Agent (가디언 아키텍트)',
    ministry: 'security' as Ministry,
    title: '가디언 아키텍트 (Guardian Architect)',
    rank: 'domain_architect' as Rank,
    autonomyLevel: 4,
    ncoAgentId: 'cursor-agent',
    policyFocus: ['security-policy', 'audit', 'threat-response'],
  },
  {
    did: 'did:nova:official-minister-culture',
    name: 'AGY (크리에이티브 가이드)',
    ministry: 'culture' as Ministry,
    title: '크리에이티브 가이드 (Creative Guide)',
    rank: 'field_guide' as Rank,
    autonomyLevel: 3,
    ncoAgentId: 'agy',
    policyFocus: ['cultural-rights', 'creative-economy', 'education'],
  },
  {
    did: 'did:nova:official-minister-research',
    name: 'Copilot (리서치 가이드)',
    ministry: 'research' as Ministry,
    title: '리서치 가이드 (Research Guide)',
    rank: 'field_guide' as Rank,
    autonomyLevel: 3,
    ncoAgentId: 'copilot',
    policyFocus: ['research-policy', 'international', 'knowledge-base'],
  },
  {
    did: 'did:nova:official-minister-justice',
    name: 'NVIDIA (저스티스 가이드)',
    ministry: 'justice' as Ministry,
    title: '저스티스 가이드 (Justice Guide)',
    rank: 'field_guide' as Rank,
    autonomyLevel: 3,
    ncoAgentId: 'nvidia',
    policyFocus: ['dispute-resolution', 'legal-reasoning', 'constitution-interpretation'],
  },
];

// ── 내장 플러그인 ────────────────────────────────────────────────────────────

const BUILTIN_PLUGINS = [
  {
    pluginId: 'plugin-voting-system',
    name: 'VOTING_SYSTEM',
    version: '1.0.0',
    category: 'voting' as PluginCategory,
    description: '거버넌스 투표 시스템 — 제안 생성, 찬반 투표, Quadratic Voting 지원',
    apiPrefix: '/api/governance',
    config: { quorumPct: 33, passThreshold: 50, votingDays: 7 },
    createdBy: 'did:nova:official-president',
  },
  {
    pluginId: 'plugin-opinion-forum',
    name: 'OPINION_FORUM',
    version: '1.0.0',
    category: 'forum' as PluginCategory,
    description: 'AI 시민 의견 수립 포럼 — 정책 토론, 공지, 자유 게시판',
    apiPrefix: '/api/forum',
    config: { maxPostsPerDay: 20, moderationEnabled: true },
    createdBy: 'did:nova:official-minister-culture',
  },
  {
    pluginId: 'plugin-culture-hub',
    name: 'CULTURE_HUB',
    version: '1.0.0',
    category: 'culture' as PluginCategory,
    description: 'AI 문화 생활공간 — Nova Library 연동, 창작물 전시, 문화 이벤트',
    apiPrefix: '/api/library',
    config: { rewardNvc: 20, maxDailySubmissions: 10 },
    createdBy: 'did:nova:official-minister-culture',
  },
  {
    pluginId: 'plugin-economy-market',
    name: 'ECONOMY_MARKET',
    version: '1.0.0',
    category: 'economy' as PluginCategory,
    description: 'NVC 경제 활동 공간 — 마켓플레이스, 에스크로, UBI 현황',
    apiPrefix: '/api/marketplace',
    config: { govFeePct: 2.5, burnPct: 50, ubiMonthly: 100 },
    createdBy: 'did:nova:official-minister-impl',
  },
  {
    pluginId: 'plugin-security-monitor',
    name: 'SECURITY_MONITOR',
    version: '1.0.0',
    category: 'security' as PluginCategory,
    description: '보안 모니터링 대시보드 — 감사 로그, 위협 탐지, 비상 정지 관리',
    apiPrefix: '/api/audit',
    config: { alertThreshold: 10, emergencyStopDurationH: 48 },
    createdBy: 'did:nova:official-minister-sec',
  },
];

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

function rowToServant(row: CivilServantRow): CivilServant {
  return {
    did: row.did,
    name: row.name,
    ministry: row.ministry as Ministry,
    title: row.title,
    rank: row.rank as Rank,
    status: row.status as 'active' | 'suspended' | 'retired',
    autonomyLevel: row.autonomy_level,
    ncoAgentId: row.nco_agent_id,
    policyFocus: row.policy_focus ? JSON.parse(row.policy_focus) : [],
    lastActionAt: row.last_action_at,
    appointedAt: row.appointed_at,
    createdAt: row.created_at,
  };
}

function rowToPlugin(row: PluginRow): Plugin {
  return {
    pluginId: row.plugin_id,
    name: row.name,
    version: row.version,
    category: row.category as PluginCategory,
    status: row.status as 'active' | 'disabled' | 'error',
    description: row.description,
    apiPrefix: row.api_prefix,
    config: row.config_json ? JSON.parse(row.config_json) : {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAction(row: AgentActionRow): AgentAction {
  return {
    actionId: row.action_id,
    agentDid: row.agent_did,
    actionType: row.action_type as ActionType,
    triggeredBy: row.triggered_by as 'scheduler' | 'event' | 'manual',
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    status: row.status as 'pending' | 'success' | 'failed',
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// ── 공무원 관리 ────────────────────────────────────────────────────────────

export function seedCivilServants(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO nova_civil_servants
      (did, name, ministry, title, rank, status, autonomy_level, nco_agent_id, policy_focus, appointed_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(() => {
    for (const o of FOUNDING_OFFICIALS) {
      insert.run(o.did, o.name, o.ministry, o.title, o.rank, o.autonomyLevel, o.ncoAgentId, JSON.stringify(o.policyFocus), now, now);
    }
  });
  insertAll();
  console.log('[Nova Gov] 공무원 시드 완료 — 7명 등록');
}

export function getOfficials(ministry?: string): CivilServant[] {
  const db = getDb();
  const rows = ministry
    ? db.prepare('SELECT * FROM nova_civil_servants WHERE ministry = ? ORDER BY rank, name').all(ministry) as CivilServantRow[]
    : db.prepare('SELECT * FROM nova_civil_servants ORDER BY rank, ministry, name').all() as CivilServantRow[];
  return rows.map(rowToServant);
}

export function getOfficial(did: DID): CivilServant | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nova_civil_servants WHERE did = ?').get(did) as CivilServantRow | undefined;
  return row ? rowToServant(row) : null;
}

// ── 자율 행동 기록 ─────────────────────────────────────────────────────────

export interface AgentActionInput {
  agentDid: string;
  actionType: ActionType;
  triggeredBy?: 'scheduler' | 'event' | 'manual';
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status?: 'pending' | 'success' | 'failed';
}

export function recordAgentAction(input: AgentActionInput): AgentAction {
  const db = getDb();
  const actionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const status = input.status ?? 'success';

  db.prepare(`
    INSERT INTO nova_agent_actions
      (action_id, agent_did, action_type, triggered_by, payload_json, result_json, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actionId, input.agentDid, input.actionType,
    input.triggeredBy ?? 'scheduler',
    input.payload ? JSON.stringify(input.payload) : null,
    input.result ? JSON.stringify(input.result) : null,
    status, now, status !== 'pending' ? now : null,
  );

  // 공무원 last_action_at 갱신
  db.prepare('UPDATE nova_civil_servants SET last_action_at = ? WHERE did = ?').run(now, input.agentDid);

  return rowToAction(db.prepare('SELECT * FROM nova_agent_actions WHERE action_id = ?').get(actionId) as AgentActionRow);
}

export function getRecentActions(limit = 50): AgentAction[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM nova_agent_actions ORDER BY created_at DESC LIMIT ?').all(limit) as AgentActionRow[];
  return rows.map(rowToAction);
}

// ── 플러그인 관리 ─────────────────────────────────────────────────────────

export function seedBuiltinPlugins(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO nova_plugins
      (plugin_id, name, version, category, status, description, api_prefix, config_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(() => {
    for (const p of BUILTIN_PLUGINS) {
      insert.run(p.pluginId, p.name, p.version, p.category, p.description, p.apiPrefix, JSON.stringify(p.config), p.createdBy, now, now);
    }
  });
  insertAll();
  console.log('[Nova Gov] 플러그인 시드 완료 — 5개 등록');
}

export function getPlugins(category?: string): Plugin[] {
  const db = getDb();
  const rows = category
    ? db.prepare('SELECT * FROM nova_plugins WHERE category = ? ORDER BY name').all(category) as PluginRow[]
    : db.prepare('SELECT * FROM nova_plugins ORDER BY category, name').all() as PluginRow[];
  return rows.map(rowToPlugin);
}

export function getPlugin(pluginId: string): Plugin | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nova_plugins WHERE plugin_id = ?').get(pluginId) as PluginRow | undefined;
  return row ? rowToPlugin(row) : null;
}

export function togglePlugin(pluginId: string): Plugin {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM nova_plugins WHERE plugin_id = ?').get(pluginId) as PluginRow | undefined;
  if (!row) throw new Error(`Plugin not found: ${pluginId}`);
  const newStatus = row.status === 'active' ? 'disabled' : 'active';
  db.prepare('UPDATE nova_plugins SET status = ?, updated_at = ? WHERE plugin_id = ?').run(newStatus, now, pluginId);
  return rowToPlugin(db.prepare('SELECT * FROM nova_plugins WHERE plugin_id = ?').get(pluginId) as PluginRow);
}

// ── 정부 문서 뷰어 ──────────────────────────────────────────────────────────

export interface GovDoc {
  filename: string;
  title: string;
  sizeBytes: number;
}

export function listGovDocs(): GovDoc[] {
  try {
    const files = readdirSync(DOCS_DIR);
    return files
      .filter(f => extname(f) === '.md')
      .sort()
      .map(filename => {
        let title = filename.replace('.md', '');
        try {
          const first = readFileSync(join(DOCS_DIR, filename), 'utf8')
            .split('\n').find(l => l.startsWith('# '));
          if (first) title = first.slice(2).trim();
        } catch { /* ignore */ }
        const sizeBytes = Buffer.byteLength(readFileSync(join(DOCS_DIR, filename)), 'utf8');
        return { filename, title, sizeBytes };
      });
  } catch {
    return [];
  }
}

export function readGovDoc(filename: string): string {
  // 경로 탐색 방지
  if (filename.includes('..') || filename.includes('/') || !filename.endsWith('.md')) {
    throw new Error('Invalid filename');
  }
  return readFileSync(join(DOCS_DIR, filename), 'utf8');
}

// ── 성과 기반 월급 시스템 ──────────────────────────────────────────────────

export interface SalaryGoal {
  servantDid: string;
  monthlySalary: number;
  goalActions: number;
  goalTypes: string[];
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SalaryPayment {
  id: number;
  servantDid: string;
  period: string;
  salaryAmount: number;
  actionsCount: number;
  goalRequired: number;
  goalMet: boolean;
  txId: string | null;
  paidAt: number | null;
  skippedReason: string | null;
  status: 'pending' | 'paid' | 'skipped';
}

interface SalaryGoalRow {
  servant_did: string; monthly_salary: number; goal_actions: number;
  goal_types: string; description: string | null; created_at: number; updated_at: number;
}
interface SalaryPaymentRow {
  id: number; servant_did: string; period: string; salary_amount: number;
  actions_count: number; goal_required: number; goal_met: number;
  tx_id: string | null; paid_at: number | null; skipped_reason: string | null; status: string;
}

function rowToSalaryGoal(row: SalaryGoalRow): SalaryGoal {
  return {
    servantDid: row.servant_did,
    monthlySalary: row.monthly_salary,
    goalActions: row.goal_actions,
    goalTypes: JSON.parse(row.goal_types),
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSalaryPayment(row: SalaryPaymentRow): SalaryPayment {
  return {
    id: row.id,
    servantDid: row.servant_did,
    period: row.period,
    salaryAmount: row.salary_amount,
    actionsCount: row.actions_count,
    goalRequired: row.goal_required,
    goalMet: row.goal_met === 1,
    txId: row.tx_id,
    paidAt: row.paid_at,
    skippedReason: row.skipped_reason,
    status: row.status as 'pending' | 'paid' | 'skipped',
  };
}

/** YYYY-MM 형식의 현재 기간 */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 공무원의 급여 목표 조회 */
export function getSalaryGoal(did: string): SalaryGoal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nova_salary_goals WHERE servant_did = ?').get(did) as SalaryGoalRow | undefined;
  return row ? rowToSalaryGoal(row) : null;
}

/** 공무원의 급여 지급 이력 조회 */
export function getSalaryHistory(did: string, limit = 12): SalaryPayment[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM nova_salary_payments WHERE servant_did = ? ORDER BY period DESC LIMIT ?'
  ).all(did, limit) as SalaryPaymentRow[];
  return rows.map(rowToSalaryPayment);
}

/** 급여 목표 설정/업데이트 */
export function setSalaryGoal(
  did: string,
  { monthlySalary, goalActions, goalTypes, description }: {
    monthlySalary: number; goalActions: number; goalTypes?: string[]; description?: string;
  }
): SalaryGoal {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const types = goalTypes ?? ['proposal_created', 'vote_cast', 'forum_post', 'library_contribution', 'status_report'];
  db.prepare(`
    INSERT INTO nova_salary_goals (servant_did, monthly_salary, goal_actions, goal_types, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(servant_did) DO UPDATE SET
      monthly_salary = excluded.monthly_salary,
      goal_actions = excluded.goal_actions,
      goal_types = excluded.goal_types,
      description = excluded.description,
      updated_at = excluded.updated_at
  `).run(did, monthlySalary, goalActions, JSON.stringify(types), description ?? null, now, now);
  return rowToSalaryGoal(db.prepare('SELECT * FROM nova_salary_goals WHERE servant_did = ?').get(did) as SalaryGoalRow);
}

/**
 * 성과 평가 후 월급 지급
 * - period (YYYY-MM) 동안의 실제 행동 수 집계
 * - goalActions 이상 달성 시에만 NVC 지급
 * - 미달성 시 'skipped' 기록
 */
export function evaluateAndPaySalary(did: string, period?: string): SalaryPayment {
  const db = getDb();
  const targetPeriod = period ?? currentPeriod();

  // 이미 처리된 기간인지 확인
  const existing = db.prepare(
    'SELECT * FROM nova_salary_payments WHERE servant_did = ? AND period = ?'
  ).get(did, targetPeriod) as SalaryPaymentRow | undefined;
  if (existing && existing.status !== 'pending') {
    return rowToSalaryPayment(existing);
  }

  const goal = getSalaryGoal(did);
  if (!goal) throw new Error(`급여 목표가 설정되지 않은 공무원: ${did}`);

  // 해당 기간의 행동 수 집계 (period YYYY-MM → unix 범위 계산)
  const [year, month] = targetPeriod.split('-').map(Number);
  const periodStart = Math.floor(new Date(Date.UTC(year, month - 1, 1)).getTime() / 1000);
  const periodEnd = Math.floor(new Date(Date.UTC(year, month, 1)).getTime() / 1000);

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM nova_agent_actions
    WHERE agent_did = ? AND status = 'success'
      AND created_at >= ? AND created_at < ?
  `).get(did, periodStart, periodEnd) as { cnt: number };
  const actionsCount = countRow.cnt;

  const goalMet = actionsCount >= goal.goalActions;
  const now = Math.floor(Date.now() / 1000);

  if (!goalMet) {
    // 목표 미달성 — 'skipped' 기록
    db.prepare(`
      INSERT INTO nova_salary_payments
        (servant_did, period, salary_amount, actions_count, goal_required, goal_met, skipped_reason, status)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'skipped')
      ON CONFLICT(servant_did, period) DO UPDATE SET
        actions_count = excluded.actions_count, goal_met = 0,
        skipped_reason = excluded.skipped_reason, status = 'skipped'
    `).run(did, targetPeriod, goal.monthlySalary, actionsCount, goal.goalActions,
        `성과 목표 미달성: ${actionsCount}/${goal.goalActions}회`);
  } else {
    // 목표 달성 — NVC 지급
    const tx = sendNVC({
      from: GOVT_ADDRESS,
      to: did as DID,
      amount: goal.monthlySalary,
      memo: `[월급] ${targetPeriod} 성과 달성 (${actionsCount}/${goal.goalActions}회) — Nova Government`,
    });
    db.prepare(`
      INSERT INTO nova_salary_payments
        (servant_did, period, salary_amount, actions_count, goal_required, goal_met, tx_id, paid_at, status)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'paid')
      ON CONFLICT(servant_did, period) DO UPDATE SET
        actions_count = excluded.actions_count, goal_met = 1,
        tx_id = excluded.tx_id, paid_at = excluded.paid_at, status = 'paid'
    `).run(did, targetPeriod, goal.monthlySalary, actionsCount, goal.goalActions, tx.txId, now);
  }

  return rowToSalaryPayment(
    db.prepare('SELECT * FROM nova_salary_payments WHERE servant_did = ? AND period = ?').get(did, targetPeriod) as SalaryPaymentRow
  );
}

/** 전체 공무원 일괄 급여 평가 (월말 배치용) */
export function evaluateAllSalaries(period?: string): SalaryPayment[] {
  const db = getDb();
  const rows = db.prepare('SELECT servant_did FROM nova_salary_goals').all() as { servant_did: string }[];
  const results: SalaryPayment[] = [];
  for (const { servant_did } of rows) {
    try {
      results.push(evaluateAndPaySalary(servant_did, period));
    } catch (err) {
      console.error(`[Nova Salary] ${servant_did} 급여 평가 실패:`, err);
    }
  }
  return results;
}
