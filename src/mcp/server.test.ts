import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, runMigrations } from '../storage/database.js';
import { handleTool, listToolsWithAcquisitions } from './server.js';

describe('mcp acquisition overlay', () => {
  beforeEach(() => {
    runMigrations();
    const db = getDb();
    db.prepare(`DELETE FROM dynamic_skills WHERE name LIKE 'acquired_test_tool_%'`).run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const db = getDb();
    db.prepare(`DELETE FROM dynamic_skills WHERE name LIKE 'acquired_test_tool_%'`).run();
  });

  it('includes active acquired skills in tools/list output', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO dynamic_skills
      (id, name, description, trigger_keywords, pipeline, quality_threshold, is_active, auto_generated)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `).run(
      'skill_mcp_overlay',
      'acquired_test_tool_overlay',
      'Overlay test tool',
      JSON.stringify(['overlay']),
      JSON.stringify([{ step: 1, agentId: 'codex', promptTemplate: '{{prompt}}', qualityThreshold: 55 }]),
      60,
    );

    const tools = listToolsWithAcquisitions();
    expect(tools.some(tool => tool.name === 'acquired_test_tool_overlay')).toBe(true);
  });

  it('falls back to acquired registry on tools/call miss', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO dynamic_skills
      (id, name, description, trigger_keywords, pipeline, quality_threshold, is_active, auto_generated)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `).run(
      'skill_mcp_fallback',
      'acquired_test_tool_fallback',
      'Fallback test tool',
      JSON.stringify(['fallback']),
      JSON.stringify([{ step: 1, agentId: 'codex', promptTemplate: '{{prompt}}', qualityThreshold: 55 }]),
      60,
    );

    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ taskId: 'task_dynamic_1' }), { status: 200 });
      }
      if (url.endsWith('/api/tasks/task_dynamic_1/status')) {
        return new Response(JSON.stringify({ status: 'completed', result: 'dynamic-complete' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleTool('acquired_test_tool_fallback', { prompt: 'run this' });

    expect(JSON.parse(result)).toMatchObject({
      tool: 'acquired_test_tool_fallback',
      output: 'dynamic-complete',
      steps: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
