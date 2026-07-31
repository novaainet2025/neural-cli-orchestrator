import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleTool, listToolsWithAcquisitions } from './server.js';

describe('mcp acquisition overlay', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads acquired skills over the NCO API for tools/list', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/mcp/dynamic-tools');
      return new Response(JSON.stringify({
        tools: [{ name: 'acquired_test_tool_overlay', description: 'Overlay test tool' }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tools = await listToolsWithAcquisitions();
    expect(tools.some(tool => tool.name === 'acquired_test_tool_overlay')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delegates dynamic tools/call execution to the NCO API', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/mcp/dynamic-tools/execute') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          tool: 'acquired_test_tool_fallback',
          output: 'dynamic-complete',
          quality: 80,
          steps: 1,
        }), { status: 200 });
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps static tools available when NCO is offline', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new Error('offline');
    }));

    const tools = await listToolsWithAcquisitions();
    expect(tools.some(tool => tool.name === 'nco_health')).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('acquired_'))).toBe(false);
  });

  it('keeps the stdio MCP process free of direct SQLite-backed imports', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("storage/database");
    expect(source).not.toContain("core/acquisition-registry");
    expect(source).not.toContain("core/dynamic-skill-engine");
  });
});
