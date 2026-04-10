import { execa } from 'execa';
import { AgentToolExecutor, type ToolResult } from './agent-tools.js';
import { parseToolCalls, extractThinking, hasToolCalls } from './tool-parser.js';
import { SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { createLogger } from '../utils/logger.js';
import type { ProviderConfig } from '../utils/config.js';

const log = createLogger('orchestrated-loop');

const MAX_ITERATIONS = 15;

// Strip ANSI escape codes from CLI output (opencode, gemini, etc. emit color codes)
// eslint-disable-next-line no-control-regex
function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
}

// Providers that handle prompt as CLI args — do NOT send via stdin
const NO_STDIN_PROVIDERS = new Set(['codex', 'cursor-agent', 'copilot']);

interface LoopResult {
  output: string;
  iterations: number;
  toolCalls: number;
  artifacts: string[];
}

/**
 * Type B Executor: NCO runs the agent loop externally.
 * CLI AI gets a single prompt → returns text with tool calls →
 * NCO executes tools → appends results → calls AI again → repeat.
 */
export class OrchestratedLoop {
  private toolExecutor: AgentToolExecutor;

  constructor(
    private provider: ProviderConfig,
    private sandbox: SandboxManager,
    private abortSignal?: AbortSignal,
  ) {
    this.toolExecutor = new AgentToolExecutor(provider.id, sandbox);
  }

  async run(taskId: string, prompt: string, systemPrompt?: string): Promise<LoopResult> {
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;
    const artifacts: string[] = [];
    const history: Array<{ role: string; content: string }> = [];

    // Update agent state
    await sharedState.setAgentState(agentId, {
      status: 'working',
      currentTask: taskId,
    });

    // Build initial system context
    const teamState = await this.buildTeamContext();
    const fullSystem = [
      systemPrompt || this.provider.persona.systemPrompt,
      '',
      '## Current Team State',
      teamState,
      '',
      '## Available Tools',
      'Use XML tags to call tools:',
      '<nco-tool name="readFile"><arg name="path">/path/to/file</arg></nco-tool>',
      '<nco-tool name="writeFile"><arg name="path">/path</arg><arg name="content">...</arg></nco-tool>',
      '<nco-tool name="createFile"><arg name="path">/path</arg><arg name="content">...</arg></nco-tool>',
      '<nco-tool name="editFile"><arg name="path">/path</arg><arg name="old">old text</arg><arg name="new">new text</arg></nco-tool>',
      '<nco-tool name="deleteFile"><arg name="path">/path</arg></nco-tool>',
      '<nco-tool name="listFiles"><arg name="path">/dir</arg></nco-tool>',
      '<nco-tool name="runCommand"><arg name="command">cmd here</arg></nco-tool>',
      '<nco-tool name="runTest"><arg name="path">test/path</arg></nco-tool>',
      '<nco-tool name="searchCode"><arg name="query">search term</arg></nco-tool>',
      '<nco-tool name="sendMessage"><arg name="to">agent-id</arg><arg name="content">message</arg></nco-tool>',
      '<nco-tool name="broadcast"><arg name="content">message to all</arg></nco-tool>',
      '',
      '## Rules',
      '- Read files before modifying them',
      '- Run tests after changes',
      '- Report important decisions to Commander (claude-code)',
      '- When done, respond WITHOUT any tool calls',
    ].join('\n');

    history.push({ role: 'user', content: prompt });

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Check abort signal
      if (this.abortSignal?.aborted) {
        log.info({ agentId, iterations }, 'Loop aborted by signal');
        break;
      }

      if (!this.sandbox.canExecute()) {
        log.warn({ agentId, iterations }, 'Agent isolated by Circuit Breaker');
        break;
      }

      // Call AI (single shot)
      await eventBus.publish({
        type: 'agent:status', agentId,
        status: iterations === 1 ? 'thinking' : 'working',
      });

      const aiResponse = await this.callCLI(fullSystem, history);

      // Stream the response
      await eventBus.publish({
        type: 'task:chunk', taskId, agentId,
        chunk: aiResponse,
        iteration: iterations,
      });

      // Check for tool calls
      const toolCalls = parseToolCalls(aiResponse);

      if (toolCalls.length === 0) {
        // No tool calls = AI is done
        history.push({ role: 'assistant', content: aiResponse });
        log.info({ agentId, iterations, totalToolCalls }, 'Loop completed (no more tools)');
        break;
      }

      // Execute each tool call
      const results: string[] = [];
      for (const call of toolCalls) {
        totalToolCalls++;
        log.debug({ agentId, tool: call.tool, args: call.args }, 'Executing tool');

        const result = await this.toolExecutor.execute(call);
        results.push(`[Tool: ${call.tool}] ${result.ok ? 'OK' : 'ERROR'}: ${result.output || result.error}`);

        if (call.tool === 'writeFile' || call.tool === 'createFile') {
          artifacts.push(call.args.path);
        }
      }

      // Add AI response + tool results to history
      history.push({ role: 'assistant', content: aiResponse });
      history.push({ role: 'user', content: `Tool results:\n${results.join('\n')}\n\nContinue your work.` });

      await eventBus.publish({
        type: 'task:progress', taskId, agentId,
        progress: Math.min(iterations / MAX_ITERATIONS, 0.95),
        detail: `Iteration ${iterations}: ${toolCalls.length} tools executed`,
      });
    }

    // Final state
    await sharedState.setAgentState(agentId, {
      status: 'idle',
      currentTask: null,
      currentFiles: [],
    });

    const finalOutput = history
      .filter(h => h.role === 'assistant')
      .map(h => extractThinking(h.content))
      .filter(Boolean)
      .join('\n\n');

    return { output: finalOutput, iterations, toolCalls: totalToolCalls, artifacts };
  }

  private async callCLI(system: string, history: Array<{ role: string; content: string }>): Promise<string> {
    const command = this.provider.command!;
    const args = [...(this.provider.args || [])];

    // Build combined prompt (system + history)
    const combined = [
      system,
      '',
      '---',
      '',
      ...history.map(h => `### ${h.role === 'user' ? 'User' : 'Assistant'}:\n${h.content}`),
    ].join('\n');

    // Most CLI AIs accept prompt via stdin or -p flag
    // Adapt per provider
    const finalArgs = this.buildArgs(args, combined);

    try {
      const useStdin = !NO_STDIN_PROVIDERS.has(this.provider.id);
      const result = await execa(command, finalArgs, {
        ...(useStdin ? { input: combined } : {}),
        timeout: this.sandbox.getTimeout(),
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...this.provider.env, NO_COLOR: '1', TERM: 'dumb' },
        reject: false,
      });

      return stripAnsi(result.stdout || result.stderr || '');
    } catch (err: any) {
      log.error({ agentId: this.provider.id, err: err.message }, 'CLI call failed');
      throw err;
    }
  }

  private buildArgs(baseArgs: string[], prompt: string): string[] {
    switch (this.provider.id) {
      case 'codex':
        // codex exec <prompt> — non-interactive subcommand, no stdin
        return ['exec', prompt];
      case 'gemini':
        return [...baseArgs, prompt];
      case 'aider':
        return [...baseArgs, prompt, '--yes', '--no-auto-commits'];
      case 'opencode':
        // opencode run <message> — non-interactive; 'chat' opens TUI
        return ['run', prompt];
      case 'cursor-agent':
        // --print: non-interactive output, --trust: skip workspace trust prompt
        return ['--print', '--trust', '--output-format', 'text', prompt];
      case 'copilot':
        // what-the-shell accepts arbitrary natural language query
        return ['what-the-shell', prompt];
      default:
        return [...baseArgs, prompt];
    }
  }

  private async buildTeamContext(): Promise<string> {
    const states = await sharedState.getAllAgentStates();
    const lines = Object.values(states).map(s =>
      `- ${s.id}: ${s.status}${s.currentTask ? ` (working on: ${s.currentTask})` : ''}`
    );
    return lines.join('\n') || 'No agents online';
  }
}
