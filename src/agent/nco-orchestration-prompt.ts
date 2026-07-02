import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';

/**
 * Fable 운영 원칙 요약 — fleet 공통 행동 규범 (nova-fleet-config/docs/fable-principles.md v1).
 * 모든 NCO 에이전트(Type B/C) system prompt preamble에 주입된다.
 */
export const FABLE_PRINCIPLES_PREAMBLE = [
  '## Fable Principles (fleet code of conduct)',
  '1. Honesty-first: unverified success is worse than failure. Verify with ground-truth evidence (file content, HTTP body, DB row) before claiming done. Say "unknown" when unknown; mark guesses as guesses.',
  '2. Benevolent knowledge sharing: share discovered error patterns and fixes with sources (commit hash, file path, measurement) so others can re-verify.',
  '3. Collaboration > solo: check for duplicate work before starting; answer peer questions accurately or admit ignorance.',
  '4. Safety: no destructive ops (rm -rf, force-push, DROP, data deletion) without explicit approval; never bypass verification gates — fix root causes.',
  '5. Completeness: implement → review → gap-check → verify. Never hide unverified items; state them explicitly.',
].join('\n');

/** Shared NCO tool protocol (XML) — Type B orchestrated loop and Type C API agents must stay aligned. */
export const NCO_TOOL_XML_INSTRUCTIONS = [
  '## Tools (XML)',
  '<nco-tool name="readFile"><arg name="path">/path</arg></nco-tool>',
  '<nco-tool name="writeFile"><arg name="path">/path</arg><arg name="content">...</arg></nco-tool>',
  '<nco-tool name="editFile"><arg name="path">/path</arg><arg name="old">text</arg><arg name="new">text</arg></nco-tool>',
  '<nco-tool name="runCommand"><arg name="command">cmd</arg></nco-tool>',
  '',
  '## Rules',
  '- Read before edit. Run tests after changes.',
  '- No tool calls in final response.',
].join('\n');


export function buildOrchestrationSystemPrompt(
  baseSystem: string,
  teamStateLines: string,
): string {
  return [
    baseSystem,
    '',
    FABLE_PRINCIPLES_PREAMBLE,
    '',
    '## Team',
    teamStateLines || 'None',
    '',
    NCO_TOOL_XML_INSTRUCTIONS,
  ].join('\n');
}

/** Extremely minified prompt for simple tasks or high-volume turns. */
export function buildCompactSystemPrompt(baseSystem: string): string {
  return [
    baseSystem,
    '',
    '## Tools (XML)',
    '<nco-tool name="readFile"><arg name="path"/></nco-tool>',
    '<nco-tool name="writeFile"><arg name="path"/><arg name="content"/></nco-tool>',
    '<nco-tool name="runCommand"><arg name="command"/></nco-tool>',
    'Rules: Read before edit. No tool calls in final response.',
  ].join('\n');
}

/** Extra line for OpenAI-compatible APIs that register `tools` (OpenRouter): prefer native tool_calls over XML. */
export const NCO_API_NATIVE_TOOLS_HINT = [
  '# Tool Use',
  '- Use API functions for workspace actions. No <nco-tool> XML if functions exist.',
  '- **Plan**: Wrap thoughts in `<thinking>` tags before tools.',
  '- **Verify**: Run tests/validation after changes.',
  '',
  '## Best Practices',
  '- Read file before `editFile`. List before deep dive.',
  '- Prefer full `writeFile` for multi-file changes.',
].join('\n');

export function buildApiAgentSystemPrompt(baseSystem: string, teamStateLines: string): string {
  // Type C agents get native tool_calls — do NOT include XML tool instructions (confuses smaller models)
  return [
    baseSystem,
    '',
    FABLE_PRINCIPLES_PREAMBLE,
    '',
    '## Team',
    teamStateLines || 'None',
    '',
    NCO_API_NATIVE_TOOLS_HINT,
  ].join('\n');
}

/**
 * OpenAI-compatible tool definitions (structured tool_use), matching AgentToolExecutor.dispatch.
 * Mirrors Claude-style function calling so OpenRouter can emit native tool_calls.
 */
export function getNcoOpenAiTools(): ChatCompletionTool[] {
  const str = { type: 'string' as const };
  return [
    {
      type: 'function',
      function: {
        name: 'readFile',
        description: 'Read file content.',
        parameters: {
          type: 'object',
          properties: { path: { ...str } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'writeFile',
        description: 'Write/overwrite file.',
        parameters: {
          type: 'object',
          properties: {
            path: { ...str },
            content: { ...str },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'createFile',
        description: 'Create new file.',
        parameters: {
          type: 'object',
          properties: {
            path: { ...str },
            content: { ...str },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'editFile',
        description: 'Search & replace unique string.',
        parameters: {
          type: 'object',
          properties: {
            path: { ...str },
            old: { ...str, description: 'Text to find' },
            new: { ...str, description: 'Replacement' },
          },
          required: ['path', 'old', 'new'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'runCommand',
        description: 'Run shell command.',
        parameters: {
          type: 'object',
          properties: { command: { ...str } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listFiles',
        description: 'List directory.',
        parameters: {
          type: 'object',
          properties: { path: { ...str } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'runTest',
        description: 'Run tests.',
        parameters: {
          type: 'object',
          properties: { path: { ...str } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'searchCode',
        description: 'Search code (grep).',
        parameters: {
          type: 'object',
          properties: { query: { ...str } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'searchFiles',
        description: 'Find files by name.',
        parameters: {
          type: 'object',
          properties: { pattern: { ...str } },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gitDiff',
        description: 'Show git diff.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gitStatus',
        description: 'Show git status.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gitCommit',
        description: 'Stage & commit.',
        parameters: {
          type: 'object',
          properties: { message: { ...str } },
          required: ['message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sendMessage',
        description: 'Send message to agent.',
        parameters: {
          type: 'object',
          properties: {
            to: { ...str },
            content: { ...str },
          },
          required: ['to', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'broadcast',
        description: 'Broadcast to all agents.',
        parameters: {
          type: 'object',
          properties: { content: { ...str } },
          required: ['content'],
        },
      },
    },
  ];
}
