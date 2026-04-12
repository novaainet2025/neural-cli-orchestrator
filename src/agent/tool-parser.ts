import { createLogger } from '../utils/logger.js';

const log = createLogger('tool-parser');

export interface ToolCall {
  tool: string;
  args: Record<string, string>;
}

// ─── NCO Tool Protocol ───────────────────────────────
// Primary: <nco-tool name="readFile"><arg name="path">/src/index.ts</arg></nco-tool>
// Fallback 1: ```json {"tool":"readFile","args":{"path":"/src/index.ts"}} ```
// Fallback 2: [TOOL: readFile(path="/src/index.ts")]

const NCO_TOOL_REGEX = /<nco-tool\s+name="([^"]+)">([\s\S]*?)<\/nco-tool>/g;
const ARG_REGEX = /<arg\s+name="([^"]+)">([\s\S]*?)<\/arg>/g;
const JSON_TOOL_REGEX = /```json\s*\n?\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*\n?\s*```/g;
const BRACKET_REGEX = /\[TOOL:\s*(\w+)\(([^)]*)\)\]/g;

// 4. Fallback: Natural language commands (Claude Code style — English & Korean)
const NL_PATTERNS = [
  { regex: /^\s*(?:read(?:\s+file)?|cat|파일\s+읽기|내용\s+확인)\s+([^\s\n]+)\s*$/im, tool: 'readFile', args: ['path'] },
  { regex: /^\s*(?:ls|list(?:\s+files)?|dir|파일\s+목록|경로\s+읽기)\s+([^\s\n]+)?\s*$/im, tool: 'listFiles', args: ['path'] },
  { 
    regex: /^\s*(?:grep|search|find|코드\s+검색|찾기)\s+(?:["']([^"'\n]+)["']|([^\s\n]+))(?:\s+([^\s\n]+))?\s*$/im, 
    tool: 'searchCode', 
    args: ['query', 'query', 'path'] 
  },
  { regex: /^\s*(?:bash|run|exec|runCommand|명령\s+실행|실행)\s+(.+)\s*$/im, tool: 'runCommand', args: ['command'] },
  { regex: /^\s*(?:test|runTest|테스트\s+실행|검증)\s+([^\s\n]+)?\s*$/im, tool: 'runTest', args: ['path'] },
  { regex: /^\s*git\s+status\s*$/im, tool: 'gitStatus', args: [] },
  { regex: /^\s*git\s+diff\s*$/im, tool: 'gitDiff', args: [] },
  { regex: /^\s*(?:delete|remove|rm|파일\s+삭제|제거)\s+([^\s\n]+)\s*$/im, tool: 'deleteFile', args: ['path'] },
];

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // 1. Primary: NCO Tool Protocol XML
  let match: RegExpExecArray | null;
  const xmlRegex = new RegExp(NCO_TOOL_REGEX.source, 'g');
  while ((match = xmlRegex.exec(text)) !== null) {
    const tool = match[1];
    const body = match[2];
    const args: Record<string, string> = {};

    const argRegex = new RegExp(ARG_REGEX.source, 'g');
    let argMatch: RegExpExecArray | null;
    while ((argMatch = argRegex.exec(body)) !== null) {
      args[argMatch[1]] = argMatch[2].trim();
    }

    calls.push({ tool, args });
  }

  if (calls.length > 0) return calls;

  // 2. Fallback: JSON code block
  const jsonRegex = new RegExp(JSON_TOOL_REGEX.source, 'g');
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          tool: parsed.tool,
          args: parsed.args || {},
        });
      }
    } catch {
      log.debug({ raw: match[1] }, 'JSON tool parse failed');
    }
  }

  if (calls.length > 0) return calls;

  // 3. Fallback: Bracket notation [TOOL: name(args)]
  const bracketRegex = new RegExp(BRACKET_REGEX.source, 'g');
  while ((match = bracketRegex.exec(text)) !== null) {
    const tool = match[1];
    const argsStr = match[2];
    const args: Record<string, string> = {};

    for (const pair of argsStr.split(',')) {
      const [key, ...valueParts] = pair.split('=');
      if (key && valueParts.length > 0) {
        args[key.trim()] = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }

    calls.push({ tool, args });
  }

  if (calls.length > 0) return calls;

  // 4. Fallback: Natural language commands (Claude Code style)
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const p of NL_PATTERNS) {
      const nlMatch = trimmed.match(p.regex);
      if (nlMatch) {
        const args: Record<string, string> = {};
        p.args.forEach((argName, idx) => {
          if (nlMatch[idx + 1]) {
            args[argName] = nlMatch[idx + 1].replace(/^["']|["']$/g, '');
          }
        });
        calls.push({ tool: p.tool, args });
      }
    }
  }

  return calls;
}

// Check if text contains any tool calls
export function hasToolCalls(text: string): boolean {
  if (NCO_TOOL_REGEX.test(text) || JSON_TOOL_REGEX.test(text) || BRACKET_REGEX.test(text)) return true;
  
  // Also check NL patterns
  const lines = text.split('\n');
  for (const line of lines) {
    for (const p of NL_PATTERNS) {
      if (p.regex.test(line.trim())) return true;
    }
  }
  return false;
}

// Extract non-tool text (the AI's "thinking" / reasoning)
export function extractThinking(text: string): string {
  let output = text
    .replace(new RegExp(NCO_TOOL_REGEX.source, 'g'), '')
    .replace(new RegExp(JSON_TOOL_REGEX.source, 'g'), '')
    .replace(new RegExp(BRACKET_REGEX.source, 'g'), '');
    
  // Also strip NL pattern lines
  const lines = output.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    for (const p of NL_PATTERNS) {
      if (p.regex.test(trimmed)) return false;
    }
    return true;
  });

  return filtered.join('\n')
    .replace(/<thinking>([\s\S]*?)<\/thinking>/g, '$1')
    .replace(/<thought>([\s\S]*?)<\/thought>/g, '$1')
    .trim();
}
