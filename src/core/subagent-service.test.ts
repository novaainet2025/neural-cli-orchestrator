import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../storage/database.js';
import { listSubagentRuns, parseCodexSessionEvents } from './subagent-service.js';

const insertedRunIds: string[] = [];

afterEach(() => {
  const db = getDb();
  for (const id of insertedRunIds.splice(0)) {
    db.prepare('DELETE FROM subagent_runs WHERE id=?').run(id);
  }
});

describe('parseCodexSessionEvents', () => {
  it('tracks a real Codex persisted spawn and completion sequence', () => {
    const lines = [
      {
        timestamp: '2026-07-28T11:11:26.117Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'read_package_name' }),
          call_id: 'spawn-1',
        },
      },
      {
        timestamp: '2026-07-28T11:11:26.275Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'spawn-1',
          output: JSON.stringify({ task_name: '/root/read_package_name' }),
        },
      },
      {
        timestamp: '2026-07-28T11:11:32.120Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'list_agents',
          arguments: '{}',
          call_id: 'list-1',
        },
      },
      {
        timestamp: '2026-07-28T11:11:32.147Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'list-1',
          output: JSON.stringify({
            agents: [
              { agent_name: '/root', agent_status: 'running' },
              { agent_name: '/root/read_package_name', agent_status: { completed: 'nco-dashboard' } },
            ],
          }),
        },
      },
    ].map(line => JSON.stringify(line)).join('\n');

    expect(parseCodexSessionEvents(lines)).toEqual([
      expect.objectContaining({
        externalAgentId: '/root/read_package_name',
        name: 'read_package_name',
        status: 'completed',
      }),
    ]);
  });

  it('keeps nested parent identity and interrupted status', () => {
    const lines = [
      {
        timestamp: '2026-07-28T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'list_agents',
          arguments: '{}',
          call_id: 'list-1',
        },
      },
      {
        timestamp: '2026-07-28T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'list-1',
          output: JSON.stringify({
            agents: [{ agent_name: '/root/a/b', agent_status: 'running' }],
          }),
        },
      },
      {
        timestamp: '2026-07-28T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'interrupt_agent',
          arguments: JSON.stringify({ target: '/root/a/b' }),
          call_id: 'interrupt-1',
        },
      },
    ].map(line => JSON.stringify(line)).join('\n');

    expect(parseCodexSessionEvents(lines)).toEqual([
      expect.objectContaining({
        externalAgentId: '/root/a/b',
        parentExternalAgentId: '/root/a',
        status: 'cancelled',
      }),
    ]);
  });
});

describe('listSubagentRuns', () => {
  it('projects a stale native run as cancelled without writing during the read', () => {
    const db = getDb();
    const id = `subagent_test_stale_${Date.now()}`;
    insertedRunIds.push(id);
    db.prepare(`
      INSERT INTO subagent_runs (
        id, parent_task_id, parent_provider, status, started_at, updated_at, source
      ) VALUES (?, ?, 'codex', 'working', datetime('now', '-11 minutes'),
                datetime('now', '-11 minutes'), 'native')
    `).run(id, `missing_parent_${id}`);

    const result = listSubagentRuns({
      activeOnly: false,
      parentTaskId: `missing_parent_${id}`,
      limit: 1,
    });

    expect(result).toEqual([
      expect.objectContaining({ id, status: 'cancelled' }),
    ]);
    expect(db.prepare('SELECT status FROM subagent_runs WHERE id=?').get(id)).toEqual({
      status: 'working',
    });
  });
});
