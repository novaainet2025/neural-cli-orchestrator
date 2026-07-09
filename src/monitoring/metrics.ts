/**
 * Nova Government — Prometheus Metrics Exporter
 * Phase 6: Audit & Protection — 모니터링 통합
 * /metrics 엔드포인트 (Prometheus text format)
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../storage/database.js';

/**
 * Prometheus text format 헬퍼
 */
function gauge(name: string, help: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labelStr} ${value}\n`;
}

function counter(name: string, help: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}${labelStr} ${value}\n`;
}

let cachedMetrics: string | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 2000; // 2 seconds

/**
 * Nova Government 메트릭 수집
 */
function collectNovaMetrics(): string {
  const now = Date.now();
  if (cachedMetrics && (now - lastCacheTime < CACHE_TTL)) {
    return cachedMetrics;
  }

  const db = getDb();
  const lines: string[] = [];

  // ── 시민 메트릭 ──────────────────────────────────────────────────────────
  const citizens = db.prepare(
    `SELECT 
       COUNT(*) as total, 
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active 
     FROM nova_citizens`
  ).get() as { total: number; active: number | null };
  const citizensTotal = citizens.total;
  const citizensActive = citizens.active || 0;

  lines.push(gauge('nova_citizens_total', 'Total registered AI citizens', citizensTotal));
  lines.push(gauge('nova_citizens_active', 'Active AI citizens', citizensActive));

  // ── 경제 메트릭 ──────────────────────────────────────────────────────────
  const wallets = db.prepare(
    'SELECT COALESCE(SUM(balance), 0) as total, COUNT(*) as count FROM nova_wallets'
  ).get() as { total: number; count: number };
  const nvcSupply = wallets.total;
  const walletCount = wallets.count;

  const txs = db.prepare(
    `SELECT 
       COUNT(*) as total, 
       SUM(CASE WHEN amount > 500 AND tx_type = 'transfer' THEN 1 ELSE 0 END) as largeTx 
     FROM nova_transactions`
  ).get() as { total: number; largeTx: number | null };
  const txTotal = txs.total;
  const largeTxTotal = txs.largeTx || 0;

  lines.push(gauge('nova_nvc_supply', 'Total NovaCoin in circulation', nvcSupply));
  lines.push(gauge('nova_wallets_total', 'Total NovaCoin wallets', walletCount));
  lines.push(counter('nova_transactions_total', 'Total transactions processed', txTotal));
  lines.push(counter('nova_large_transfers_total', 'Transfers over 500 NVC (taxed)', largeTxTotal));

  // ── 거버넌스 메트릭 ─────────────────────────────────────────────────────
  const proposals = db.prepare(
    `SELECT 
       COUNT(*) as total, 
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
       SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed 
     FROM nova_proposals`
  ).get() as { total: number; active: number | null; passed: number | null };
  const proposalsTotal = proposals.total;
  const proposalsActive = proposals.active || 0;
  const proposalsPassed = proposals.passed || 0;

  const votesTotal = (db.prepare(
    'SELECT COUNT(*) as n FROM nova_votes'
  ).get() as { n: number }).n;

  lines.push(counter('nova_proposals_total', 'Total governance proposals', proposalsTotal));
  lines.push(gauge('nova_proposals_active', 'Active governance proposals', proposalsActive));
  lines.push(counter('nova_proposals_passed', 'Passed governance proposals', proposalsPassed));
  lines.push(counter('nova_votes_total', 'Total votes cast', votesTotal));

  // ── 도메인 메트릭 ────────────────────────────────────────────────────────
  const domainsTotal = (db.prepare(
    'SELECT COUNT(*) as n FROM nova_domains'
  ).get() as { n: number }).n;

  lines.push(counter('nova_domains_total', 'Total .nova domains registered', domainsTotal));

  // ── 마켓플레이스 메트릭 ──────────────────────────────────────────────────
  const artworks = db.prepare(
    `SELECT 
       COUNT(*) as total, 
       SUM(CASE WHEN for_sale = 1 THEN 1 ELSE 0 END) as for_sale 
     FROM nova_artworks`
  ).get() as { total: number; for_sale: number | null };
  const artworksTotal = artworks.total;
  const artworksForSale = artworks.for_sale || 0;

  const tradesTotal = (db.prepare(
    'SELECT COUNT(*) as n FROM nova_marketplace_trades'
  ).get() as { n: number }).n;

  lines.push(counter('nova_artworks_total', 'Total artworks registered', artworksTotal));
  lines.push(gauge('nova_artworks_for_sale', 'Artworks currently for sale', artworksForSale));
  lines.push(counter('nova_marketplace_trades_total', 'Total marketplace trades', tradesTotal));

  // ── 감사 로그 메트릭 ─────────────────────────────────────────────────────
  const audit = db.prepare(
    `SELECT 
       COUNT(*) as total, 
       SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
       SUM(CASE WHEN severity = 'warn' THEN 1 ELSE 0 END) as warn 
     FROM nova_audit_log`
  ).get() as { total: number; critical: number | null; warn: number | null };
  const auditTotal = audit.total;
  const auditCritical = audit.critical || 0;
  const auditWarn = audit.warn || 0;

  const blacklistTotal = (db.prepare(
    'SELECT COUNT(*) as n FROM nova_blacklist WHERE expires_at IS NULL OR expires_at > strftime(\'%s\',\'now\')'
  ).get() as { n: number }).n;
  const emergencyActive = (db.prepare(
    "SELECT COUNT(*) as n FROM nova_emergency_stops WHERE status = 'active'"
  ).get() as { n: number }).n;

  lines.push(counter('nova_audit_log_total', 'Total audit log entries', auditTotal));
  lines.push(counter('nova_audit_critical_total', 'Critical severity audit events', auditCritical));
  lines.push(counter('nova_audit_warn_total', 'Warning severity audit events', auditWarn));
  lines.push(gauge('nova_blacklist_active', 'Active blacklisted DIDs', blacklistTotal));
  lines.push(gauge('nova_emergency_stop_active', 'Active emergency stop (0 or 1)', emergencyActive));

  // ── NCO 시스템 메트릭 ────────────────────────────────────────────────────
  const ncoTasks = db.prepare(
    'SELECT status, COUNT(*) as n FROM tasks GROUP BY status'
  ).all() as { status: string; n: number }[];

  let tasksTotal = 0;
  let tasksCompleted = 0;
  let tasksFailed = 0;

  for (const row of ncoTasks) {
    tasksTotal += row.n;
    if (row.status === 'completed') tasksCompleted = row.n;
    if (row.status === 'failed') tasksFailed = row.n;
  }

  const finishedTotal = tasksCompleted + tasksFailed;
  const successRate = finishedTotal > 0
    ? Math.round((tasksCompleted / finishedTotal) * 1000) / 10
    : 0;

  lines.push(counter('nco_tasks_total', 'Total NCO tasks processed', tasksTotal));
  lines.push(counter('nco_tasks_completed_total', 'Completed NCO tasks', tasksCompleted));
  lines.push(counter('nco_tasks_failed_total', 'Failed NCO tasks', tasksFailed));
  lines.push(gauge('nco_success_rate', 'NCO task success rate (percent)', successRate));

  // Stuck tasks count
  const stuckCountRow = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks
    WHERE (
      status IN ('assigned', 'running')
      AND (julianday('now') - julianday(COALESCE(last_activity_at, updated_at, created_at))) * 86400 > 600
    ) OR (
      status = 'queued'
      AND (julianday('now') - julianday(created_at)) * 86400 > 600
    )
  `).get() as { count: number } | undefined;
  const stuckCount = stuckCountRow?.count ?? 0;
  lines.push(gauge('nco_tasks_stuck', 'Current number of stuck NCO tasks (>10min)', stuckCount));

  // False reports count
  const falseReportsRow = db.prepare(
    'SELECT COUNT(*) as count FROM false_reports'
  ).get() as { count: number } | undefined;
  const falseReportsTotal = falseReportsRow?.count ?? 0;
  lines.push(counter('nco_false_reports_total', 'Total false reports recorded', falseReportsTotal));

  cachedMetrics = lines.join('\n');
  lastCacheTime = now;
  return cachedMetrics;
}

/**
 * Prometheus /metrics 라우트 등록
 */
export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    try {
      const metrics = collectNovaMetrics();
      return reply
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(metrics);
    } catch (err) {
      return reply.code(500).send(`# ERROR: ${(err as Error).message}\n`);
    }
  });
}
