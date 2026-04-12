import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';

/** Shared NCO tool protocol (XML) — Type B orchestrated loop and Type C API agents must stay aligned. */
export const NCO_TOOL_XML_INSTRUCTIONS = [
  '## Available Tools',
  'Use XML tags or natural language commands to call tools:',
  '<nco-tool name="readFile"><arg name="path">/path/to/file</arg></nco-tool>',
  '<nco-tool name="writeFile"><arg name="path">/path</arg><arg name="content">...</arg></nco-tool>',
  '<nco-tool name="editFile"><arg name="path">/path</arg><arg name="old">old text</arg><arg name="new">new text</arg></nco-tool>',
  '<nco-tool name="runCommand"><arg name="command">cmd here</arg></nco-tool>',
  '',
  '### Natural Language Fallback (Claude Code Style)',
  'You can also use simple natural language commands (English or Korean) on a single line:',
  '- "Read file src/index.ts" or "파일 읽기 src/index.ts"',
  '- "ls src" or "파일 목록 src"',
  '- "grep search_term" or "코드 검색 search_term"',
  '- "bash npm test" or "실행 npm test"',
  '- "git status"',
  '',
  '## Rules',
  '- Read files before modifying them',
  '- Run tests after changes',
  '- Report important decisions to Commander (claude-code)',
  '- When done, respond WITHOUT any tool calls',
].join('\n');

export function buildOrchestrationSystemPrompt(
  baseSystem: string,
  teamStateLines: string,
): string {
  return [
    baseSystem,
    '',
    '## Current Team State',
    teamStateLines || 'No agents online',
    '',
    NCO_TOOL_XML_INSTRUCTIONS,
  ].join('\n');
}

/** Extra line for OpenAI-compatible APIs that register `tools` (vLLM, OpenRouter): prefer native tool_calls over XML. */
export const NCO_API_NATIVE_TOOLS_HINT = [
  '# Tool Use Guidelines',
  '- When this request includes function tools in the API, call those functions for file, shell, search, and git actions.',
  '- Do not embed <nco-tool> XML when functions are available.',
  '- **Plan before acting**: You MUST wrap your reasoning and plan for the current step in `<thinking>` tags before making any tool calls.',
  '- **Sequential Execution**: Perform tools in the logical order (e.g., readFile before editFile).',
  '- **Robust Error Handling**: If a tool fails (e.g., file not found), do not give up. Use other tools to investigate (e.g., listFiles) and then retry.',
  '- **Verifiable Work**: After making changes, run relevant tests (runTest) or verification commands (runCommand) to ensure correctness.',
  '',
  '## Workspace Best Practices',
  '- Always use `readFile` to check the current content of a file before attempting an `editFile`.',
  '- If you need to explore a directory, use `listFiles` recursively if needed.',
  '- For large-scale changes, prefer `writeFile` with the full content to ensure consistency.',
  '- When using `runCommand`, prioritize non-interactive and verifiable commands.',
].join('\n');

export function buildApiAgentSystemPrompt(baseSystem: string, teamStateLines: string): string {
  return `${buildOrchestrationSystemPrompt(baseSystem, teamStateLines)}\n\n${NCO_API_NATIVE_TOOLS_HINT}`;
}

/**
 * OpenAI-compatible tool definitions (structured tool_use), matching AgentToolExecutor.dispatch.
 * Mirrors Claude-style function calling so vLLM / OpenRouter can emit native tool_calls.
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
