import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('observability');

export interface AgentLeaderboardEntry {
  agentId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  successRate: number;
  avgDurationMs: number;
}

class Observability {
  /**
   * Agent leaderboard — success rate, task count, avg duration.
   */
  getLeaderboard(): AgentLeaderboardEntry[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        assigned_to as agent_id,
        COUNT(*) as total_tasks,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
        AVG(CASE WHEN completed_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(created_at)) * 86400000
          ELSE NULL END) as avg_duration_ms
      FROM tasks
      WHERE assigned_to IS NOT NULL
      GROUP BY assigned_to
      ORDER BY completed_tasks DESC
    `).all() as any[];

    return rows.map(r => ({
      agentId: r.agent_id,
      totalTasks: r.total_tasks,
      completedTasks: r.completed_tasks || 0,
      failedTasks: r.failed_tasks || 0,
      successRate: r.total_tasks > 0 ? (r.completed_tasks || 0) / r.total_tasks : 0,
      avgDurationMs: Math.round(r.avg_duration_ms || 0),
    }));
  }

  /**
   * Get recent history for a specific agent.
   */
  getAgentHistory(agentId: string, limit = 20): { tasks: any[]; actions: any[] } {
    const db = getDb();
    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE assigned_to = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, limit);

    const actions = db.prepare(
      'SELECT * FROM agent_actions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, limit);

    return { tasks, actions };
  }

  /**
   * System-wide metrics.
   */
  getMetrics(): Record<string, any> {
    const db = getDb();

    const taskStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
      FROM tasks
    `).get() as any;

    const discussionStats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM discussions
    `).get() as any;

    const agentCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM agents WHERE enabled = 1"
    ).get() as any;

    const recentErrors = db.prepare(`
      SELECT agent_id, COUNT(*) as cnt
      FROM agent_actions WHERE action_type = 'error'
      AND created_at > datetime('now', '-1 hour')
      GROUP BY agent_id
    `).all();

    return {
      tasks: taskStats,
      discussions: discussionStats,
      agents: { enabled: agentCount?.cnt || 0 },
      recentErrors,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
  }
}

export const observability = new Observability();
