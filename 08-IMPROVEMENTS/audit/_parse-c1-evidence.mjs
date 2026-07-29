import fs from 'fs';

const tasks = JSON.parse(fs.readFileSync('08-IMPROVEMENTS/audit/_tmp_team_tasks.json', 'utf8')).tasks || [];
const agents = JSON.parse(fs.readFileSync('08-IMPROVEMENTS/audit/_tmp_agents.json', 'utf8')).agents || [];
const trend = JSON.parse(fs.readFileSync('08-IMPROVEMENTS/audit/_tmp_trend.json', 'utf8')).task;
const now = Date.now();
const h48 = now - 48 * 3600e3;

function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}

console.log('TEAM_TASKS', tasks.length);
for (const t of tasks) {
  const ct = parseTs(t.created_at);
  const in48 = ct != null && ct >= h48;
  const resp = typeof t.response === 'string' ? t.response.length : 0;
  const meta = t.metadata_json == null ? 'NULL' : (String(t.metadata_json).trim() ? 'SET' : 'EMPTY');
  const spawned = t.spawned_by_cli ?? 'NULL';
  console.log([
    t.id,
    t.status,
    t.assigned_to,
    `resp=${resp}`,
    `orphan=${t.orphan_requeue_count}`,
    `meta=${meta}`,
    `spawned=${spawned}`,
    `err=${String(t.error || '').slice(0, 70)}`,
    `in48=${in48}`,
    t.created_at,
  ].join(' | '));
}

console.log('TREND', JSON.stringify({
  id: trend.id,
  team_id: trend.team_id,
  status: trend.status,
  resp: trend.response,
  result: trend.result_json,
  evidence: trend.evidence_json,
  assigned: trend.assigned_to,
  orphan: trend.orphan_requeue_count,
  meta: trend.metadata_json,
  spawned: trend.spawned_by_cli,
  created: trend.created_at,
  completed: trend.completed_at,
}));

for (const a of agents) {
  if (['agy', 'retired-provider', 'ollama', 'mlx', 'cursor-agent', 'opencode'].includes(a.id)) {
    console.log(
      'AGENT',
      a.id,
      `circuit=${a.health?.circuitState}`,
      `fail=${a.health?.consecutiveFailures}`,
      `gate=${a.gate?.status}`,
      `reason=${a.gate?.reason}`,
      `lastErr=${String(a.health?.lastError || '').slice(0, 80)}`,
    );
  }
}
