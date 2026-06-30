import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';

/** Shared NCO tool protocol (XML) — Type B orchestrated loop and Type C API agents must stay aligned. */
export const NCO_TOOL_XML_INSTRUCTIONS = [
  '## Tools',
  'XML: <nco-tool name="tool"><arg name="a">val</arg></nco-tool>',
  'Tools: readFile, writeFile(path, content), editFile(path, old, new), runCommand(command), listFiles(path), searchCode(query), runTest(path)',
  '',
  '### Natural Language',
  '- "Read file src/index.ts"',
  '- "ls src", "grep search_term", "bash npm test", "git status"',
  '',
  '## Rules',
  '1. Read before editing. 2. Test after changes. 3. Be concise. 4. Respond with text ONLY when done.',
].join('\n');

export function buildOrchestrationSystemPrompt(
  baseSystem: string,
  teamStateLines: string,
): string {
  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return [
    baseSystem,
    '',
    `## Current DateTime: ${dateStr}`,
    '',
    '## Team: ' + (teamStateLines || 'None'),
    '',
    NCO_TOOL_XML_INSTRUCTIONS,
    NCO_RESPONSE_QUALITY_HINT,
  ].join('\n');
}

/** Compact version — omits team state for short/turbo runs. */
export function buildCompactSystemPrompt(baseSystem: string): string {
  return [baseSystem, '', NCO_TOOL_XML_INSTRUCTIONS, NCO_RESPONSE_QUALITY_HINT].join('\n');
}

/** Extra line for OpenAI-compatible APIs that register `tools` (MLX, OpenRouter): prefer native tool_calls over XML. */
export const NCO_API_NATIVE_TOOLS_HINT = [
  '# Guidelines',
  '- Use native function tools. <thinking> first. Plan steps.',
  '- Robust: investigate failure (listFiles). Verify: runTest/runCommand.',
  '- Edit: Use `editFile` with unique `old` text block.',
].join('\n');

/** Structured output quality rules — appended for all task responses to maximise QualityGate scores. */
export const NCO_RESPONSE_QUALITY_HINT = [
  '',
  '# Response Quality Standards',
  '- Structure: use ## markdown headers, ``` code blocks, and - bullet lists for every response.',
  '- Depth: provide complete implementations, edge-case analysis, and usage examples.',
  '- Confidence: state conclusions clearly — avoid "maybe", "might", "not sure".',
  '- Code tasks: always include a runnable code block, brief explanation, and complexity note.',
  '- Design/architecture: include headers, layered breakdown, and tradeoff list.',
  '- Reviews: enumerate specific issues with ## header per issue and - recommended fix.',
].join('\n');

export function buildApiAgentSystemPrompt(baseSystem: string, teamStateLines: string): string {
  return `${buildOrchestrationSystemPrompt(baseSystem, teamStateLines)}\n\n${NCO_API_NATIVE_TOOLS_HINT}${NCO_RESPONSE_QUALITY_HINT}`;
}

/**
 * OpenAI-compatible tool definitions (structured tool_use), matching AgentToolExecutor.dispatch.
 * Mirrors Claude-style function calling so MLX / OpenRouter can emit native tool_calls.
 */
export function getNcoOpenAiTools(): ChatCompletionTool[] {
  const str = { type: 'string' as const };
  return [
    {
      type: 'function',
      function: {
        name: 'readFile',
        description: 'Read a file from the workspace (sandboxed).',
        parameters: {
          type: 'object',
          properties: { path: { ...str, description: 'File path' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'writeFile',
        description: 'Write or overwrite a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { ...str, description: 'File path' },
            content: { ...str, description: 'Full file content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'createFile',
        description: 'Create a new file (fails if exists).',
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
        description: 'Replace a unique substring in a file. TIP: Ensure the "old" string is a unique, contiguous block of text from the file to avoid ambiguity.',
        parameters: {
          type: 'object',
          properties: {
            path: { ...str, description: 'File path' },
            old: { ...str, description: 'Exact unique text to find' },
            new: { ...str, description: 'Replacement text' },
          },
          required: ['path', 'old', 'new'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'runCommand',
        description: 'Run a shell command in the project sandbox. TIP: Prefer non-interactive commands. For multi-line commands, use && or ; to chain them.',
        parameters: {
          type: 'object',
          properties: { command: { ...str, description: 'The shell command to execute' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listFiles',
        description: 'List files in a directory.',
        parameters: {
          type: 'object',
          properties: { path: { ...str, description: 'Directory path' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'runCommand',
        description: 'Run a shell command in the project sandbox.',
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
        name: 'runTest',
        description: 'Run npm test with an optional file path filter.',
        parameters: {
          type: 'object',
          properties: { path: { ...str, description: 'Optional vitest file path' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'searchCode',
        description: 'Search source files for a query (grep).',
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
        description: 'Find files by name pattern (excludes node_modules).',
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
        description: 'Show git diff for the workspace.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gitStatus',
        description: 'Show short git status.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gitCommit',
        description: 'Stage all changes and commit with a message.',
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
        description: 'Send a message to another NCO agent.',
        parameters: {
          type: 'object',
          properties: {
            to: { ...str, description: 'Agent id' },
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
        description: 'Broadcast a message to all agents.',
        parameters: {
          type: 'object',
          properties: { content: { ...str } },
          required: ['content'],
        },
      },
    },
  ];
}
