/**
 * NCO Hallucination Guard — LLM 응답 환각 검증 레이어
 *
 * bastion-anchor (Apache-2.0) 이식 — 2026-06-30
 * GitHub: zafrem/bastion-anchor
 *
 * 설계:
 *   1. 주장 추출 (claim extraction) — 응답에서 수치/사실 주장 파싱
 *   2. 소스 비교 (grounding check) — context vs 응답 키워드 커버리지
 *   3. 자가 검증 (self-review) — 로컬 LLM(ollama)으로 응답 사실성 재확인
 *   4. 신뢰도 점수 (0-1) 및 경고 목록 반환
 *
 * 통합: cross-validator.ts의 winner 결과에 후처리로 적용 가능
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('hallucination-guard');

// 자가 검증에 사용할 로컬 LLM (ollama)
const OLLAMA_CHAT_URL = 'http://localhost:11434/api/chat';
// MLX 서버 (고성능 자가 검증용, 옵션)
const MLX_CHAT_URL = 'http://127.0.0.1:8000/v1/chat/completions';

// 환각 위험 패턴 (정규식)
const HALLUCINATION_RISK_PATTERNS = [
  /\b(always|never|every|all|none|definitely|certainly|guaranteed)\b/gi,
  /\b(according to|research shows|studies show|experts say)\b/gi,
  /\b(\d{4}년|\d{4}년도)\s*(연구|논문|보고서)/gi,
  /\b(100%|0%)\s*(확실|보장|확인)/gi,
];

export interface HallucinationReport {
  groundingScore: number;       // 0-1: context 기반 사실성
  selfReviewScore: number | null;  // 0-1: LLM 자가 검증 점수 (null=skipped)
  overallScore: number;         // 최종 신뢰도
  warnings: string[];           // 경고 목록
  claims: string[];             // 추출된 주장 목록
  riskFlags: string[];          // 고위험 패턴
  recommendation: 'accept' | 'review' | 'reject';
}

// ── 주장 추출 ──────────────────────────────────────────────────────────────
function extractClaims(text: string): string[] {
  const sentences = text.split(/[.!?。\n]+/).map(s => s.trim()).filter(s => s.length > 20);
  return sentences.filter(s =>
    // 수치 포함 문장 or 단정적 표현
    /\d+/.test(s) || /\b(is|are|was|were|will|can|should|must|이다|입니다|합니다)\b/i.test(s)
  ).slice(0, 10);
}

// ── 컨텍스트 기반 그라운딩 점수 ──────────────────────────────────────────
function computeGrounding(response: string, context?: string): number {
  if (!context || context.trim().length < 10) return 0.7; // 컨텍스트 없으면 중립

  const responseWords = new Set(
    response.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  );
  const contextWords = new Set(
    context.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  );

  // 응답의 핵심 단어 중 몇 %가 컨텍스트에서 왔는가
  let overlap = 0;
  responseWords.forEach(w => { if (contextWords.has(w)) overlap++; });
  const coverage = responseWords.size > 0 ? overlap / responseWords.size : 0;

  return Math.min(1, 0.4 + coverage * 0.6); // 40% base + coverage보정
}

// ── 위험 패턴 감지 ────────────────────────────────────────────────────────
function detectRiskFlags(text: string): string[] {
  const flags: string[] = [];
  for (const pattern of HALLUCINATION_RISK_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      flags.push(...matches.slice(0, 3).map(m => `과장/단정 표현: "${m.trim()}"`));
    }
  }
  return [...new Set(flags)].slice(0, 5);
}

// ── 로컬 LLM 자가 검증 (ollama) ───────────────────────────────────────────
async function selfReview(response: string, prompt: string): Promise<number | null> {
  const reviewPrompt = `You are a fact-checker. Rate the following AI response for factual accuracy and hallucination risk.

Original question: ${prompt.slice(0, 200)}

AI response to evaluate: ${response.slice(0, 500)}

Rate from 0.0 to 1.0 where:
- 1.0 = highly accurate, well-grounded
- 0.5 = uncertain, some risk
- 0.0 = likely hallucinated or unsupported

Respond with ONLY a number like: 0.8`;

  // Try ollama first (local, fast)
  try {
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b', // 가볍고 빠른 검증용
        messages: [{ role: 'user', content: reviewPrompt }],
        stream: false,
        options: { temperature: 0, num_predict: 10 },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as { message?: { content?: string } };
      const content = data.message?.content ?? '';
      const match = content.match(/\b(0\.\d+|1\.0|0|1)\b/);
      if (match) {
        const score = parseFloat(match[1]);
        if (!isNaN(score) && score >= 0 && score <= 1) return score;
      }
    }
  } catch { /* fallthrough */ }

  // Try MLX (higher quality, slower)
  try {
    const res = await fetch(MLX_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '/Users/nova-ai/project/LM-models/mlx/gemma-4-26b-a4b-it-4bit',
        messages: [{ role: 'user', content: reviewPrompt }],
        max_tokens: 5, stream: false, temperature: 0,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      const match = content.match(/\b(0\.\d+|1\.0|0|1)\b/);
      if (match) {
        const score = parseFloat(match[1]);
        if (!isNaN(score) && score >= 0 && score <= 1) return score;
      }
    }
  } catch { /* fallthrough */ }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface GuardOptions {
  context?: string;          // 소스 문서 / RAG 청크
  runSelfReview?: boolean;   // LLM 자가 검증 실행 여부 (기본 false, 느림)
  prompt?: string;           // 원래 질문 (자가 검증용)
}

/**
 * LLM 응답의 환각 가능성을 평가한다.
 * NCO cross-validator winner 결과에 후처리로 적용 가능.
 */
export async function checkHallucination(
  response: string,
  opts: GuardOptions = {},
): Promise<HallucinationReport> {
  const claims = extractClaims(response);
  const groundingScore = computeGrounding(response, opts.context);
  const riskFlags = detectRiskFlags(response);

  let selfReviewScore: number | null = null;
  if (opts.runSelfReview && opts.prompt) {
    try {
      selfReviewScore = await selfReview(response, opts.prompt);
    } catch (e) {
      log.warn({ err: e }, 'self-review failed, skipped');
    }
  }

  const warnings: string[] = [];
  if (groundingScore < 0.5) warnings.push(`저조한 컨텍스트 기반 점수 (${(groundingScore * 100).toFixed(0)}%)`);
  if (riskFlags.length > 2) warnings.push(`고위험 표현 ${riskFlags.length}개 감지`);
  if (selfReviewScore !== null && selfReviewScore < 0.5) warnings.push(`자가 검증 낮음 (${(selfReviewScore * 100).toFixed(0)}%)`);

  // 종합 점수
  const scores = [groundingScore];
  if (selfReviewScore !== null) scores.push(selfReviewScore);
  const riskPenalty = riskFlags.length * 0.05;
  const overallScore = Math.max(0, Math.min(1,
    scores.reduce((a, b) => a + b, 0) / scores.length - riskPenalty
  ));

  const recommendation: HallucinationReport['recommendation'] =
    overallScore >= 0.7 ? 'accept' :
    overallScore >= 0.4 ? 'review' : 'reject';

  log.debug({ groundingScore, selfReviewScore, overallScore, warnings: warnings.length }, 'hallucination check done');

  return { groundingScore, selfReviewScore, overallScore, warnings, claims, riskFlags, recommendation };
}

/**
 * 빠른 환각 점수 (자가 검증 없이, 동기적)
 * cross-validator 내 실시간 필터링용
 */
export function quickHallucinationScore(response: string, context?: string): number {
  const grounding = computeGrounding(response, context);
  const riskFlags = detectRiskFlags(response);
  return Math.max(0, grounding - riskFlags.length * 0.05);
}
