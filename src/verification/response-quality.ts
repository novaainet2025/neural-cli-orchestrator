const INTERNAL_THOUGHT_TAGS = [
  'thinking',
  'analysis',
  'thought',
  'reasoning',
  'internal-thought',
  'internal_thought',
  'scratchpad',
];

const PROTOCOL_PREFIX = /^(?:done|status|question|error):/i;
const TOOL_ECHO_LINE = /^\s*\[tool:[^\]\n]+\]\s*$/i;
// 프로바이더 wrapper가 붙이는 실패 마커로 *시작*하는 응답 — 실질 출력 없이 completed로
// 빠지는 케이스 (실측: "[codex: no final response — process failed] — Reading additional input from stdin...")
// 정상 응답 뒤에 마커가 꼬리로 붙는 경우는 통과해야 하므로 시작 위치만 검사한다.
const ERROR_MARKER_START = /^\s*\[[\w-]+:\s*no final response\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isThinkingOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const tags = INTERNAL_THOUGHT_TAGS.map(escapeRegex).join('|');
  const pattern = new RegExp(`^(?:\\s*<(?:${tags})\\b[^>]*>[\\s\\S]*?<\\/(?:${tags})>\\s*)+$`, 'i');
  return pattern.test(trimmed);
}

function isToolEcho(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const firstNonBlank = lines.find(line => line.trim().length > 0);
  if (!firstNonBlank || !TOOL_ECHO_LINE.test(firstNonBlank)) return false;

  const substantive = lines
    .filter(line => !TOOL_ECHO_LINE.test(line))
    .join('\n')
    .trim();

  return substantive.length === 0;
}

export function checkResponseQuality(
  text: string,
  opts?: { requireProtocolPrefix?: boolean },
): { pass: boolean; heuristics: string[] } {
  const heuristics: string[] = [];
  const normalized = text ?? '';
  const collapsed = normalized.replace(/\s+/g, '');

  if (isThinkingOnly(normalized)) heuristics.push('THINKING_ONLY');
  if (isToolEcho(normalized)) heuristics.push('TOOL_ECHO');
  // EMPTY_OR_SHORT는 빈 응답 또는 문자·숫자가 전혀 없는 기호/공백 잔해만 reject.
  // 단순 길이(<50) 기준은 정당한 단답("OK", "done: 통과")까지 reject해 retry cap을
  // 전소시키는 현장 결함이 확인되어 제거 (실측 2026-07-03, claude-3 보고).
  if (collapsed.length < 50 && !/[\p{L}\p{N}]/u.test(collapsed)) {
    heuristics.push('EMPTY_OR_SHORT');
  }
  if (ERROR_MARKER_START.test(normalized)) heuristics.push('ERROR_MARKER');
  if (opts?.requireProtocolPrefix && normalized.trim() && !PROTOCOL_PREFIX.test(normalized.trimStart())) {
    heuristics.push('FORMAT_MISMATCH');
  }

  return { pass: heuristics.length === 0, heuristics };
}
