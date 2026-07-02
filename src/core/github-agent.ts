/**
 * NCO GitHub Agent — 레포 검색 및 이식 가능성 평가
 *
 * GitHub REST API를 사용해 AI/LLM 관련 레포를 검색하고
 * NCO 이식 가능성(라이선스, API 호환성, 활성도)을 자동 평가한다.
 *
 * 타깃 목표:
 *   - 환각 제거 (hallucination elimination)
 *   - 자가 개선 (self-improvement / reflection)
 *   - 기억력 향상 및 공유 (memory enhancement & sharing)
 *   - 비판적 사고 (critical thinking / multi-agent debate)
 */

import { createLogger } from '../utils/logger.js';
import { knowledgeBase } from './knowledge-base.js';

const log = createLogger('github-agent');

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional — increases rate limit from 60→5000/hr

interface GitHubRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  license: { spdx_id: string } | null;
  updated_at: string;
  topics: string[];
  open_issues_count: number;
  forks_count: number;
}

export interface RepoCandidate {
  name: string;
  url: string;
  description: string;
  stars: number;
  language: string;
  license: string;
  lastUpdated: string;
  topics: string[];
  transplantScore: number;         // 0-100: NCO 이식 가능성 점수
  transplantReason: string;        // 평가 이유
  targetGoal: string;              // 관련 목표 (hallucination/memory/self-improvement/collaboration)
}

export interface GitHubSearchResult {
  query: string;
  goal: string;
  repos: RepoCandidate[];
  searchedAt: string;
}

const ACCEPT_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'LGPL-2.1']);
const PREFER_LANGUAGES = new Set(['TypeScript', 'JavaScript', 'Python']);

/** GitHub REST API 호출 */
async function ghFetch(path: string): Promise<any> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'NCO-GitHub-Agent/1.0',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(`${GITHUB_API}${path}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

/** 레포 이식 가능성 점수 계산 (0-100) */
function scoreTransplantability(repo: GitHubRepo, goal: string): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // 라이선스 (30점)
  const license = repo.license?.spdx_id ?? 'NOASSERTION';
  if (ACCEPT_LICENSES.has(license)) {
    score += 30;
    reasons.push(`✓ ${license} 라이선스`);
  } else if (license === 'NOASSERTION' || !repo.license) {
    score += 10;
    reasons.push('⚠ 라이선스 미명시');
  } else {
    reasons.push(`✗ ${license} 라이선스 (제한적)`);
  }

  // 언어 (20점)
  if (PREFER_LANGUAGES.has(repo.language ?? '')) {
    score += 20;
    reasons.push(`✓ ${repo.language} (NCO 호환)`);
  } else if (!repo.language) {
    score += 5; // likely multi-language or docs-only
    reasons.push('⚠ 언어 미분류');
  } else {
    score += 10;
    reasons.push(`~ ${repo.language} (래퍼 필요)`);
  }

  // 활성도: 최근 6개월 업데이트 (20점)
  const monthsAgo = (Date.now() - new Date(repo.updated_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsAgo < 1) { score += 20; reasons.push('✓ 최근 1개월 내 업데이트'); }
  else if (monthsAgo < 6) { score += 15; reasons.push(`✓ ${Math.floor(monthsAgo)}개월 전 업데이트`); }
  else if (monthsAgo < 12) { score += 8; reasons.push(`~ ${Math.floor(monthsAgo)}개월 전 업데이트`); }
  else { reasons.push(`✗ ${Math.floor(monthsAgo)}개월 전 업데이트 (유지보수 불확실)`); }

  // 인기도 (15점): stars
  if (repo.stargazers_count > 10000) { score += 15; reasons.push(`✓ ⭐${(repo.stargazers_count/1000).toFixed(1)}K`); }
  else if (repo.stargazers_count > 1000) { score += 12; reasons.push(`✓ ⭐${(repo.stargazers_count/1000).toFixed(1)}K`); }
  else if (repo.stargazers_count > 100) { score += 8; reasons.push(`~ ⭐${repo.stargazers_count}`); }
  else { score += 3; reasons.push(`~ ⭐${repo.stargazers_count}`); }

  // API 호환성 키워드 (15점)
  const desc = (repo.description ?? '').toLowerCase();
  const topics = repo.topics.join(' ').toLowerCase();
  const combined = desc + ' ' + topics;

  const apiKeywords = ['api', 'sdk', 'library', 'framework', 'npm', 'pip', 'openai-compatible', 'rest', 'fastapi', 'express'];
  const goalKeywords: Record<string, string[]> = {
    hallucination: ['hallucination', 'fact', 'grounding', 'rag', 'verify', 'detection'],
    memory: ['memory', 'mem0', 'letta', 'memgpt', 'retrieval', 'knowledge', 'persistence'],
    'self-improvement': ['reflection', 'self', 'improve', 'learn', 'reflexion', 'critique'],
    collaboration: ['multi-agent', 'collab', 'swarm', 'debate', 'consensus', 'orchestrat'],
  };

  const apiMatch = apiKeywords.filter(k => combined.includes(k)).length;
  const goalMatch = (goalKeywords[goal] ?? []).filter(k => combined.includes(k)).length;

  score += Math.min(10, apiMatch * 2);
  score += Math.min(5, goalMatch * 2);
  if (apiMatch > 0) reasons.push(`✓ API/SDK 키워드 (${apiMatch}개)`);

  return { score: Math.min(100, score), reason: reasons.join(', ') };
}

/** 단일 목표로 GitHub 검색 */
async function searchForGoal(
  goal: 'hallucination' | 'memory' | 'self-improvement' | 'collaboration',
  limit = 5,
): Promise<RepoCandidate[]> {
  const queries: Record<string, string> = {
    hallucination: 'LLM hallucination detection RAG grounding verification language:python language:typescript',
    memory: 'AI agent memory long-term mem0 language:python language:typescript',
    'self-improvement': 'LLM self-improvement reflection Reflexion language:python language:typescript',
    collaboration: 'multi-agent debate consensus AI collaboration language:python language:typescript',
  };

  const q = encodeURIComponent(queries[goal]);
  log.info({ goal, q: queries[goal] }, 'Searching GitHub');

  const data = await ghFetch(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit * 2}`);
  const repos: GitHubRepo[] = data.items ?? [];

  return repos
    .map(repo => {
      const { score, reason } = scoreTransplantability(repo, goal);
      return {
        name: repo.full_name,
        url: repo.html_url,
        description: repo.description ?? '',
        stars: repo.stargazers_count,
        language: repo.language ?? 'N/A',
        license: repo.license?.spdx_id ?? 'Unknown',
        lastUpdated: repo.updated_at,
        topics: repo.topics,
        transplantScore: score,
        transplantReason: reason,
        targetGoal: goal,
      } satisfies RepoCandidate;
    })
    .sort((a, b) => b.transplantScore - a.transplantScore)
    .slice(0, limit);
}

/** 전체 목표 탐색 (4가지 목표 병렬 검색) */
export async function runGitHubAgent(options: {
  goals?: Array<'hallucination' | 'memory' | 'self-improvement' | 'collaboration'>;
  limitPerGoal?: number;
} = {}): Promise<GitHubSearchResult[]> {
  const goals = options.goals ?? ['hallucination', 'memory', 'self-improvement', 'collaboration'];
  const limit = options.limitPerGoal ?? 5;

  log.info({ goals, limit }, 'GitHub agent started');

  const results = await Promise.allSettled(
    goals.map(async goal => {
      const repos = await searchForGoal(goal as any, limit);
      const result: GitHubSearchResult = {
        query: goal,
        goal,
        repos,
        searchedAt: new Date().toISOString(),
      };

      // knowledge-base에 상위 레포 저장
      for (const repo of repos.slice(0, 3)) {
        if (repo.transplantScore >= 50) {
          knowledgeBase.save({
            projectPath: '/nco-fleet',
            category: 'architecture',
            content: `[GitHub 레포] ${repo.name} (⭐${repo.stars})\n목표: ${goal}\n설명: ${repo.description}\n이식점수: ${repo.transplantScore}/100\n이유: ${repo.transplantReason}\nURL: ${repo.url}`,
            sourceTaskId: `github-agent-${goal}`,
            confidence: repo.transplantScore / 100,
          });
        }
      }

      return result;
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<GitHubSearchResult> => r.status === 'fulfilled')
    .map(r => r.value);
}

/** 빠른 단일 목표 검색 */
export async function searchGitHub(goal: string, limit = 5): Promise<RepoCandidate[]> {
  return searchForGoal(goal as any, limit);
}
