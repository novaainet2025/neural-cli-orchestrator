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

  return calls;
}

// Check if text contains any tool calls
export function hasToolCalls(text: string): boolean {
  return NCO_TOOL_REGEX.test(text) ||
         JSON_TOOL_REGEX.test(text) ||
         BRACKET_REGEX.test(text);
}

// Extract non-tool text (the AI's "thinking" / reasoning)
export function extractThinking(text: string): string {
  return text
    .replace(new RegExp(NCO_TOOL_REGEX.source, 'g'), '')
    .replace(new RegExp(JSON_TOOL_REGEX.source, 'g'), '')
    .replace(new RegExp(BRACKET_REGEX.source, 'g'), '')
    .trim();
}
