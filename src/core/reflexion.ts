/**
 * NCO Reflexion — 자가 개선 루프 (Self-Improvement Layer)
 *
 * 이식 출처: danieleschmidt/reflexion-agent-boilerplate (MIT, 2026-06-30)
 * 논문: "Reflexion: Language Agents with Verbal Reinforcement Learning"
 *
 * 동작:
 *   1. 에이전트 응답 생성
 *   2. 자가 평가 (critique) — 무엇이 잘못됐나?
 *   3. 반성 기록 (reflection) — mem0에 영구 저장
 *   4. 개선 재시도 (retry) — 반성을 컨텍스트에 주입
 *   5. 최대 N회 반복 또는 합격 기준 충족까지
 */

import { createLogger } from '../utils/logger.js';
import { OLLAMA_KEEP_ALIVE } from '../utils/ollama.js';
import { mem0Add, mem0Search } from './mem0-bridge.js';

const log = createLogger('reflexion');

// 자가 평가용 LLM
const OLLAMA_CHAT_URL = 'http://localhost:11434/api/chat';
const MLX_CHAT_URL = 'http://127.0.0.1:8000/v1/chat/completions';

export interface ReflexionTurn {
  attempt: number;
  response: string;
  critique: string;
  score: number;        // 0-1 자가 평가 점수
  passed: boolean;
}

export interface ReflexionResult {
  finalResponse: string;
  turns: ReflexionTurn[];
  improved: boolean;
  totalAttempts: number;
  agentId: string;
}

// ── 로컬 LLM 호출 헬퍼 ────────────────────────────────────────────────────
async function callLlm(messages: Array<{ role: string; content: string }>): Promise<string> {
  // Try ollama first
  try {
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages,
        keep_alive: OLLAMA_KEEP_ALIVE,
        stream: false,
        options: { temperature: 0.3, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = await res.json() as { message?: { content?: string } };
      return data.message?.content?.trim() ?? '';
    }
  } catch { /* fallthrough */ }

  // Fallback to MLX
  try {
    const res = await fetch(MLX_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '/Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit',
        messages,
        max_tokens: 300, stream: false, temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    }
  } catch { /* fallthrough */ }

  return '';
}

// ── 자가 평가 (Critique) ───────────────────────────────────────────────────
async function critique(prompt: string, response: string): Promise<{ critique: string; score: number }> {
  const critiquePrompt = `You are a critical evaluator. Evaluate this AI response.

Task: ${prompt.slice(0, 300)}
Response: ${response.slice(0, 500)}

Identify: (1) What's missing or wrong? (2) What could be improved?
Then rate quality 0.0-1.0.

Format:
CRITIQUE: <specific issues>
SCORE: <0.0-1.0>`;

  const result = await callLlm([{ role: 'user', content: critiquePrompt }]);

  const critiqueMatch = result.match(/CRITIQUE:\s*(.+?)(?=SCORE:|$)/si);
  const scoreMatch = result.match(/SCORE:\s*(0\.\d+|1\.0|0|1)/i);

  const critiqueText = critiqueMatch?.[1]?.trim() ?? result.slice(0, 200);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;

  return { critique: critiqueText, score: isNaN(score) ? 0.5 : score };
}

// ── 개선 재시도 (Retry with Reflection) ──────────────────────────────────
async function refine(
  prompt: string,
  previousResponse: string,
  critiqueText: string,
  priorReflections: string[],
): Promise<string> {
  const reflectionContext = priorReflections.length > 0
    ? `\n\nPrevious reflections to learn from:\n${priorReflections.slice(-3).join('\n')}`
    : '';

  const refinePrompt = `You previously answered a question but received this critique.

Original task: ${prompt.slice(0, 300)}
Previous response: ${previousResponse.slice(0, 400)}
Critique: ${critiqueText}${reflectionContext}

Now provide an IMPROVED response that addresses the critique. Be specific and accurate.`;

  return callLlm([{ role: 'user', content: refinePrompt }]);
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ReflexionOptions {
  maxAttempts?: number;    // 최대 반복 횟수 (기본 3)
  passThreshold?: number;  // 합격 점수 (기본 0.8)
  saveMemory?: boolean;    // 반성 내용을 mem0에 저장 (기본 true)
  userId?: string;
}

/**
 * Reflexion 자가 개선 루프 실행
 *
 * @param agentId  실행 에이전트 ID (반성 기억 분리용)
 * @param prompt   태스크 프롬프트
 * @param executor 응답 생성 함수
 * @param opts     옵션
 */
export async function runReflexion(
  agentId: string,
  prompt: string,
  executor: (enrichedPrompt: string) => Promise<string>,
  opts: ReflexionOptions = {},
): Promise<ReflexionResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const passThreshold = opts.passThreshold ?? 0.8;
  const saveMemory = opts.saveMemory !== false;

  // 과거 반성 기억 조회 (같은 에이전트의 유사 태스크)
  let priorReflections: string[] = [];
  try {
    const memResult = await mem0Search({ agentId, query: prompt, limit: 3 });
    priorReflections = memResult.memories.map(m => m.content);
  } catch { /* mem0 unavailable */ }

  const turns: ReflexionTurn[] = [];
  let currentResponse = '';
  let improved = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info({ agentId, attempt, maxAttempts }, 'Reflexion attempt');

    // 1) 응답 생성 (첫 번째는 원본, 이후는 반성 포함)
    const enrichedPrompt = attempt === 1 && priorReflections.length === 0
      ? prompt
      : `${prompt}\n\n[Prior reflections for improvement]\n${priorReflections.slice(-2).join('\n')}`;

    try {
      currentResponse = await executor(enrichedPrompt);
    } catch (e: any) {
      log.warn({ agentId, attempt, err: e.message }, 'executor failed');
      break;
    }

    // 2) 자가 평가
    const { critique: critiqueText, score } = await critique(prompt, currentResponse);
    const passed = score >= passThreshold;

    turns.push({ attempt, response: currentResponse, critique: critiqueText, score, passed });

    // 3) 반성 기억 저장
    if (saveMemory && !passed) {
      const reflection = `Task: ${prompt.slice(0, 100)}\nIssues found: ${critiqueText.slice(0, 200)}\nScore: ${score}`;
      try {
        await mem0Add({ agentId, content: reflection, userId: opts.userId, metadata: { type: 'reflection', attempt, score } });
        priorReflections.push(reflection);
      } catch { /* non-critical */ }
    }

    if (passed) {
      improved = attempt > 1;
      log.info({ agentId, attempt, score }, 'Reflexion passed');
      break;
    }

    // 4) 개선 재시도 준비 (마지막 시도가 아닐 때)
    if (attempt < maxAttempts) {
      const refined = await refine(prompt, currentResponse, critiqueText, priorReflections);
      if (refined) currentResponse = refined;
    }
  }

  return {
    finalResponse: currentResponse,
    turns,
    improved,
    totalAttempts: turns.length,
    agentId,
  };
}

/**
 * 단순 자가 평가 (executor 없이 기존 응답 평가만)
 */
export async function evaluateWithReflexion(
  agentId: string,
  prompt: string,
  response: string,
  opts: Pick<ReflexionOptions, 'saveMemory' | 'userId'> = {},
): Promise<{ score: number; critique: string; saved: boolean }> {
  const { critique: critiqueText, score } = await critique(prompt, response);
  let saved = false;

  if ((opts.saveMemory !== false) && score < 0.8) {
    try {
      await mem0Add({
        agentId,
        content: `Evaluation: ${prompt.slice(0, 100)}\nCritique: ${critiqueText.slice(0, 200)}\nScore: ${score}`,
        userId: opts.userId,
        metadata: { type: 'evaluation', score },
      });
      saved = true;
    } catch { /* non-critical */ }
  }

  return { score, critique: critiqueText, saved };
}
