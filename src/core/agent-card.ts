import { providerRegistry } from './provider-registry.js';
import { getDb } from '../storage/database.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { sharedState } from './shared-state.js';

export interface AgentCard {
  name: string;
  role: string;
  capabilities: string[];
  status: 'idle' | 'working' | 'error';
  endpoint: string;
  successRate: number;
  gate: string;
  signature?: string;
}

export async function buildAgentCards(providers?: any[]): Promise<AgentCard[]> {
  let targetProviders = providers;
  if (!targetProviders) {
    targetProviders = providerRegistry.list();
    if (!targetProviders || targetProviders.length === 0) {
      try {
        const { loadEnabledProviders } = await import('../utils/config.js');
        targetProviders = loadEnabledProviders();
      } catch (e) {
        targetProviders = [];
      }
    }
  }

  const taskStats = new Map<string, { total: number; completed: number }>();
  const activeAgents = new Set<string>();

  try {
    const db = getDb();
    const statsRows = db.prepare(
      `SELECT assigned_to,
              COUNT(*) as total,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
       FROM tasks WHERE assigned_to IS NOT NULL GROUP BY assigned_to`
    ).all() as any[];
    for (const r of statsRows) {
      if (r.assigned_to) {
        taskStats.set(r.assigned_to, { total: r.total || 0, completed: r.completed || 0 });
      }
    }

    const activeRows = db.prepare(
      `SELECT DISTINCT assigned_to FROM tasks WHERE status IN ('assigned', 'running', 'streaming') AND assigned_to IS NOT NULL`
    ).all() as any[];
    for (const r of activeRows) {
      if (r.assigned_to) {
        activeAgents.add(r.assigned_to);
      }
    }
  } catch (e) {
    // Database query failed (e.g. table doesn't exist during testing), fallback safely
  }

  const cards: AgentCard[] = [];
  for (const provider of targetProviders) {
    const id = provider.id;
    const availability = circuitBreakerRegistry.getAvailability(id);
    const stats = taskStats.get(id);
    const total = stats?.total || 0;
    const completed = stats?.completed || 0;
    const successRate = total > 0 ? Number((completed / total).toFixed(4)) : 1.0;

    let status: 'idle' | 'working' | 'error' = 'idle';
    try {
      const state = await sharedState.getAgentState(id);
      if (state && (state.status === 'working' || state.status === 'thinking' || state.status === 'coding' || state.status === 'reviewing' || state.status === 'discussing')) {
        status = 'working';
      } else if (activeAgents.has(id)) {
        status = 'working';
      }
    } catch (e) {
      if (activeAgents.has(id)) {
        status = 'working';
      }
    }

    // Circuit status gating takes precedence for 'error' state
    if (availability.status !== 'available' && availability.status !== 'probe') {
      status = 'error';
    }

    cards.push({
      name: provider.name || id,
      role: provider.role || 'Unknown',
      capabilities: provider.capabilities || [],
      status,
      endpoint: provider.endpoint || '',
      successRate,
      gate: availability.status,
    });
  }

  return cards;
}