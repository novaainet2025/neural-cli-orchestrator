#!/usr/bin/env python3
"""One-off: add tryParseFencedBashToolCall + buildAnthropicContentBlocks else branch."""
from pathlib import Path

path = Path("/home/nova/projects/.claude/bin/anthropic-vllm-proxy.mjs")
text = path.read_text(encoding="utf-8")

old_strip = r"""/** Gemma tool_call 태그를 제거한 순수 텍스트 반환 */
function stripGemmaToolCallTags(text) {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<\|tool_call\>[\s\S]*?<tool_call\|>/g, "")
    .trim();
}

/**
 * 일부 vLLM+Chat 모델이 tool_calls 필드 대신 본문에 OpenAI-style JSON을 출력한다."""

new_fn = r"""/** Gemma tool_call 태그를 제거한 순수 텍스트 반환 */
function stripGemmaToolCallTags(text) {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<\|tool_call\>[\s\S]*?<tool_call\|>/g, "")
    .trim();
}

/**
 * Gemma/Qwen이 fenced bash 블록으로 명령을 출력할 때 Bash tool_use로 변환
 * 예: ```bash\ncurl -s http://...\n```
 */
function tryParseFencedBashToolCall(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const fenceRe = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  const results = [];
  let m;
  while ((m = fenceRe.exec(rawText)) !== null) {
    const command = m[1].trim();
    if (command) results.push({ name: "Bash", input: { command } });
  }
  return results.length ? results : null;
}

/**
 * 일부 vLLM+Chat 모델이 tool_calls 필드 대신 본문에 OpenAI-style JSON을 출력한다."""

if old_strip not in text:
    raise SystemExit("anchor1 not found")

text = text.replace(old_strip, new_fn, 1)

old_else = r"""  } else {
    const loose = tryParseLooseToolCallJson(text);
    const gemma = loose ? null : tryParseGemmaToolCall(text);
    const parsed = loose || gemma;
    if (parsed?.length) {
      const cleanText = gemma ? stripGemmaToolCallTags(text) : "";
      if (cleanText) blocks.push({ type: "text", text: cleanText });"""

new_else = r"""  } else {
    const loose = tryParseLooseToolCallJson(text);
    const gemma = loose ? null : tryParseGemmaToolCall(text);
    const fenced = (loose || gemma) ? null : tryParseFencedBashToolCall(text);
    const parsed = loose || gemma || fenced;
    if (parsed?.length) {
      const cleanText = gemma ? stripGemmaToolCallTags(text) : fenced ? text.replace(/```(?:bash|sh|shell)[\s\S]*?```/g, "").trim() : "";
      if (cleanText) blocks.push({ type: "text", text: cleanText });"""

if old_else not in text:
    raise SystemExit("anchor2 not found")

text = text.replace(old_else, new_else, 1)
path.write_text(text, encoding="utf-8")
print("patched OK")
