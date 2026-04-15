import { z } from 'zod';

export const ActionSchema = z.object({
  tool: z.string(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  reasoning: z.string(),
});

export type ParsedIntent = {
  primaryAction: {
    tool: string;
    action: string;
    args: Record<string, unknown>;
    confidence: number;
    reasoning: string;
  };
  secondaryActions: Array<{
    tool: string;
    action: string;
    args: Record<string, unknown>;
    confidence: number;
    reasoning: string;
  }>;
  workspaceContext: string;
  rawQuery: string;
};

const TOOL_KEYWORDS: Record<string, string[]> = {
  readFile: ['read', 'show', 'display', 'view', 'open', 'look at', 'check'],
  writeFile: ['write', 'create', 'make', 'new file', 'generate'],
  editFile: ['edit', 'modify', 'change', 'update', 'fix', 'alter'],
  deleteFile: ['delete', 'remove', 'drop', 'erase'],
  listFiles: ['list', 'ls', 'show files', 'directory', 'files in'],
  runCommand: ['run', 'execute', 'command', 'cmd', 'bash', 'shell', 'terminal'],
  runTest: ['test', 'run test', 'run tests', 'spec'],
  searchCode: ['search', 'find', 'grep', 'look for', 'find in'],
  sendMessage: ['send', 'message', 'notify', 'tell'],
  broadcast: ['broadcast', 'announce', 'everyone'],
};

const AGENT_KEYWORDS: Record<string, string[]> = {
  codex: ['codex', 'implement', 'write code'],
  opencode: ['opencode', 'architect', 'design'],
  gemini: ['gemini', 'design', 'ui', 'ux'],
  aider: ['aider', 'edit', 'modify'],
  'cursor-agent': ['cursor', 'review', 'fix'],
  copilot: ['copilot', 'research', 'lookup'],
  openrouter: ['openrouter', 'reason', 'think'],
  mlx: ['mlx', 'validate', 'test'],
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPath(text: string): string | null {
  const pathMatch = text.match(/(?:in|to|from|at|path:)\s+([^\s]+)/i) || text.match(/\/[\w.\-/]+/);
  return pathMatch ? pathMatch[1] : null;
}

function extractFilename(text: string): string | null {
  const match = text.match(/(?:file|filename|name):\s*([^\s]+)/i);
  return match ? match[1] : null;
}

export function parseIntent(query: string): ParsedIntent {
  const norm = normalize(query);
  const lower = norm.split(' ');

  let bestTool = 'runCommand';
  let bestScore = 0;

  for (const [tool, keywords] of Object.entries(TOOL_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (norm.includes(kw)) score += 1;
      if (lower[0] === kw) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTool = tool;
    }
  }

  const confidence = Math.min(0.5 + bestScore * 0.15, 0.95);

  const path = extractPath(query);
  const filename = extractFilename(query);
  const args: Record<string, unknown> = {};

  if (path) args.path = path;
  if (filename) args.filename = filename;

  if (query.toLowerCase().includes('test')) {
    args.test = true;
  }

  const primaryAction = {
    tool: bestTool,
    action: 'execute',
    args,
    confidence,
    reasoning: `Matched "${bestTool}" from keywords in query`,
  };

  return {
    primaryAction,
    secondaryActions: [],
    workspaceContext: '',
    rawQuery: query,
  };
}

export const NaturalLanguageInput = z.object({
  query: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
});