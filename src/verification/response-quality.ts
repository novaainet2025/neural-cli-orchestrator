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
  if (collapsed.length < 50) heuristics.push('EMPTY_OR_SHORT');
  if (opts?.requireProtocolPrefix && normalized.trim() && !PROTOCOL_PREFIX.test(normalized.trimStart())) {
    heuristics.push('FORMAT_MISMATCH');
  }

  return { pass: heuristics.length === 0, heuristics };
}
