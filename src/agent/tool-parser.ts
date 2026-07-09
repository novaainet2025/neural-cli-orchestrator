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

// [2026-07-09] Qwen3-Coder 계열 네이티브 포맷 — 모델이 훈련된 형식 그대로 파싱.
// 억제 프롬프트로 막아도 새어나와 "consecutive tool errors" 실패의 주원인이었음(mlx 72%).
// <function=runCommand><parameter=command>ls</parameter></function>
const QWEN_FN_REGEX = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAM_REGEX = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;
// Qwen/Hermes 계열 <tool_call>{"name":"...","arguments":{...}}</tool_call>
const TOOL_CALL_JSON_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

// 모델별 도구명 변형 → agent-tools.ts 정식 이름 정규화 (미지 이름 → 실행 에러 → streak 실패 방지)
const TOOL_ALIASES: Record<string, string> = {
  run_command: 'runCommand', bash: 'runCommand', shell: 'runCommand', exec: 'runCommand',
  execute: 'runCommand', execute_command: 'runCommand', execute_bash: 'runCommand', terminal: 'runCommand',
  read_file: 'readFile', cat: 'readFile', open_file: 'readFile', view_file: 'readFile',
  write_file: 'writeFile', save_file: 'writeFile',
  create_file: 'createFile',
  edit_file: 'editFile', str_replace: 'editFile',
  delete_file: 'deleteFile', remove_file: 'deleteFile',
  list_files: 'listFiles', list_dir: 'listFiles', list_directory: 'listFiles', ls: 'listFiles',
  search_code: 'searchCode', grep: 'searchCode', code_search: 'searchCode', search: 'searchCode',
  search_files: 'searchFiles', find_files: 'searchFiles', glob: 'searchFiles',
  git_status: 'gitStatus', git_diff: 'gitDiff', git_commit: 'gitCommit',
  run_test: 'runTest', run_tests: 'runTest', test: 'runTest',
  send_message: 'sendMessage',
};
const ARG_ALIASES: Record<string, string> = {
  cmd: 'command', file_path: 'path', filepath: 'path', file: 'path', filename: 'path',
  dir: 'path', directory: 'path', text: 'content', old_str: 'old', new_str: 'new',
  old_string: 'old', new_string: 'new',
  // 주의: pattern→query 전역 별칭 금지 — searchFiles는 args.pattern을 직접 읽는다 (codex 리뷰 2026-07-09)
};

export function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] || TOOL_ALIASES[name.toLowerCase()] || name;
}

function normalizeArgs(args: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[ARG_ALIASES[k] || k] = v;
  }
  return out;
}

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

  // 1.5. Qwen3-Coder 네이티브: <function=NAME><parameter=KEY>VALUE</parameter></function>
  const qwenRegex = new RegExp(QWEN_FN_REGEX.source, 'g');
  while ((match = qwenRegex.exec(text)) !== null) {
    const tool = normalizeToolName(match[1]);
    const body = match[2];
    const args: Record<string, string> = {};
    const paramRegex = new RegExp(QWEN_PARAM_REGEX.source, 'g');
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }
    calls.push({ tool, args: normalizeArgs(args) });
  }
  if (calls.length > 0) return calls;

  // 1.6. <tool_call>{"name":"...","arguments":{...}}</tool_call> (Qwen/Hermes chat template)
  const tcRegex = new RegExp(TOOL_CALL_JSON_REGEX.source, 'g');
  while ((match = tcRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const name = parsed.name || parsed.tool;
      if (name && typeof name === 'string') {
        const rawArgs = parsed.arguments || parsed.args || {};
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawArgs)) {
          args[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        calls.push({ tool: normalizeToolName(name), args: normalizeArgs(args) });
      }
    } catch {
      log.debug({ raw: match[1] }, 'tool_call JSON parse failed');
    }
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
  if (
    new RegExp(NCO_TOOL_REGEX.source).test(text)
    || new RegExp(QWEN_FN_REGEX.source).test(text)
    || new RegExp(TOOL_CALL_JSON_REGEX.source).test(text)
    || new RegExp(JSON_TOOL_REGEX.source).test(text)
    || new RegExp(BRACKET_REGEX.source).test(text)
  ) return true;
  
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
    // qwen3 등 thinking 모델의 사고 블록은 최종 출력에서 제거 (내용만 남기면 사족이 답을 오염)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(new RegExp(NCO_TOOL_REGEX.source, 'g'), '')
    .replace(new RegExp(QWEN_FN_REGEX.source, 'g'), '')
    .replace(new RegExp(TOOL_CALL_JSON_REGEX.source, 'g'), '')
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
