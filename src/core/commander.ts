import { agentManager } from '../agent/agent-manager.js';
import { planManager } from './plan-manager.js';
import { kanbanEngine } from './kanban-engine.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { LAYER_TIER_AGENTS, tierOf } from './tier-policy.js';

const log = createLogger('commander');

/**
 * Commander 4-Layer Hierarchy — Brain/Worker 2계층 정책 적용 (tier-policy.ts 단일 소스)
 *
 * Management Layer (두뇌/유료): 계획·최종 종합 (claude-code, opencode)
 * Information Layer (두뇌+무료): 리서치 (copilot → openrouter/nvidia)
 * Execution Layer (워커/무료 로컬): 대량 구현 (mlx, ollama, hermes, aider → codex escalation)
 * Quality Layer (두뇌/유료): 리뷰·검증 (cursor-agent → ollama/nvidia QA)
 */

// 계층별 에이전트는 tier-policy.ts(LAYER_TIER_AGENTS)가 단일 소스.
// Brain(유료)=management/quality, Worker(무료 로컬)=execution.
const LAYERS = {
  management: {
    name: 'Management',
    agents: LAYER_TIER_AGENTS.management,
    role: 'Strategic planning, architecture decisions, final synthesis',
    canDelegateTo: ['information', 'execution', 'quality'],
  },
  information: {
    name: 'Information',
    agents: LAYER_TIER_AGENTS.information,
    role: 'Research, data gathering, analysis',
    canDelegateTo: ['execution'],
  },
  execution: {
    name: 'Execution',
    agents: LAYER_TIER_AGENTS.execution,
    role: 'Code implementation, design, engineering',
    canDelegateTo: [],
  },
  quality: {
    name: 'Quality',
    agents: LAYER_TIER_AGENTS.quality,
    role: 'Code review, validation, testing',
    canDelegateTo: ['execution'], // Can send back to execution for fixes
  },
} as const;

type LayerName = keyof typeof LAYERS;

interface CommanderResult {
  commandId: string;
  prompt: string;
  planId?: string;
  layers: LayerResult[];
  finalOutput: string;
  status: 'completed' | 'failed';
}

interface LayerResult {
  layer: string;
  agentId: string;
  output: string;
  success: boolean;
  durationMs: number;
}

class Commander {
  /**
   * Execute a command using 4-Layer hierarchy.
   *
   * Flow:
   * 1. Management analyzes and creates sub-task plan
   * 2. Information gathers context (if needed)
   * 3. Execution implements
   * 4. Quality reviews
   * 5. Management synthesizes final output
   */
  async executeCommand(prompt: string): Promise<CommanderResult> {
    const commandId = `cmd_${Date.now()}`;
    const layerResults: LayerResult[] = [];

    await eventBus.publish({
      type: 'commander:started', commandId, prompt,
    });

    log.info({ commandId }, 'Commander 4-Layer execution started');

    try {
      // ─── Layer 1: Management — Analyze & Plan ──────
      const managementAgent = this.pickAvailableAgent('management');
      const analysisPrompt = [
        'You are the Commander in a 4-Layer AI team.',
        'Analyze this task and create a brief execution plan.',
        'List 2-5 concrete steps that the Execution layer should perform.',
        'Format each step as a single line.',
        '',
        `Task: ${prompt}`,
      ].join('\n');

      const analysis = await this.executeOnLayer('management', managementAgent, analysisPrompt);
      layerResults.push(analysis);

      if (!analysis.success) {
        return this.failResult(commandId, prompt, layerResults, 'Management analysis failed');
      }

      // ─── Layer 2: Information — Research (optional) ──
      const needsResearch = /research|분석|조사|investigate|찾아|search/i.test(prompt);
      if (needsResearch) {
        const infoAgent = this.pickAvailableAgent('information');
        const infoPrompt = `Research and provide context for: ${prompt}\n\nBrief summary only.`;
        const info = await this.executeOnLayer('information', infoAgent, infoPrompt);
        layerResults.push(info);
      }

      // ─── Layer 3: Execution — Implement ────────────
      const execAgent = this.pickAvailableAgent('execution');
      const execPrompt = [
        `Implement the following based on the Commander's plan:`,
        '',
        analysis.output,
        '',
        `Original request: ${prompt}`,
      ].join('\n');

      const execution = await this.executeOnLayer('execution', execAgent, execPrompt);
      layerResults.push(execution);

      // ─── Layer 4: Quality — Review ─────────────────
      const qualityAgent = this.pickAvailableAgent('quality');
      const reviewPrompt = [
        'Review the following execution result for correctness and quality.',
        'Point out any issues briefly.',
        '',
        `Task: ${prompt}`,
        '',
        `Execution output:`,
        execution.output.slice(0, 3000),
      ].join('\n');

      const review = await this.executeOnLayer('quality', qualityAgent, reviewPrompt);
      layerResults.push(review);

      // ─── Layer 1 Again: Management — Synthesize ────
      const synthPrompt = [
        'Synthesize the final result from your team execution.',
        '',
        `Original task: ${prompt}`,
        `Execution result: ${execution.output.slice(0, 2000)}`,
        `Quality review: ${review.output.slice(0, 1000)}`,
        '',
        'Provide the final consolidated output.',
      ].join('\n');

      const synthesis = await this.executeOnLayer('management', managementAgent, synthPrompt);
      layerResults.push(synthesis);

      await eventBus.publish({
        type: 'commander:completed', commandId,
        layers: layerResults.length,
      });

      return {
        commandId,
        prompt,
        layers: layerResults,
        finalOutput: synthesis.output || execution.output,
        status: 'completed',
      };

    } catch (err: any) {
      return this.failResult(commandId, prompt, layerResults, err.message);
    }
  }

  /**
   * Execute a prompt on a specific layer's agent.
   */
  private async executeOnLayer(
    layer: LayerName,
    agentId: string,
    prompt: string,
  ): Promise<LayerResult> {
    const startTime = Date.now();

    await eventBus.publish({
      type: 'commander:layer_started',
      layer: LAYERS[layer].name,
      agentId,
    });

    try {
      const result = await agentManager.executeTask(agentId, prompt, {});

      return {
        layer: LAYERS[layer].name,
        agentId,
        output: result.output,
        success: result.success,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        layer: LAYERS[layer].name,
        agentId,
        output: '',
        success: false,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Pick an available agent from a layer. Falls back to first agent in list.
   */
  private pickAvailableAgent(layer: LayerName): string {
    const layerAgents = LAYERS[layer].agents;
    const enabledIds = new Set(agentManager.listEnabledIds());

    for (const agentId of layerAgents) {
      if (enabledIds.has(agentId)) {
        log.info({ layer, agentId, tier: tierOf(agentId) },
          `layer ${layer} → ${agentId} (${tierOf(agentId)})`);
        return agentId;
      }
    }

    // Fallback: any enabled agent (모든 우선 에이전트 불가 시)
    const fallback = agentManager.listEnabledIds()[0] || layerAgents[0];
    log.warn({ layer, fallback, tier: tierOf(fallback) },
      `layer ${layer}: 우선 에이전트 모두 불가 → fallback ${fallback}`);
    return fallback;
  }

  private failResult(
    commandId: string, prompt: string, layers: LayerResult[], error: string,
  ): CommanderResult {
    log.error({ commandId, error }, 'Commander execution failed');
    return {
      commandId, prompt, layers,
      finalOutput: `Commander failed: ${error}`,
      status: 'failed',
    };
  }

  /**
   * Get layer configuration for display.
   */
  getLayers() {
    return Object.entries(LAYERS).map(([key, value]) => ({
      id: key,
      name: value.name,
      agents: value.agents,
      role: value.role,
      canDelegateTo: value.canDelegateTo,
    }));
  }
}

export const commander = new Commander();
