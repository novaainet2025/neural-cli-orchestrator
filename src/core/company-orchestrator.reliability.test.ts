import { describe, it, expect } from 'vitest';
import {
  decideCompanyRunResume, resolveExecutorChain, selectCapabilityExecutor, reselectExecutor, type TeamRow,
} from './company-orchestrator.js';

const team = (p: Partial<TeamRow> & { slug: string; name: string }): TeamRow =>
  ({ id: `t_${p.slug}`, lead: null, charter: null, description: null, members: [], ...p });

describe('resolveExecutorChain', () => {
  it('가용 우선 + 등록 후보 후행', () => {
    const known = new Set(['opencode', 'nvidia', 'codex', 'ollama']);
    const avail = (id: string) => id !== 'opencode' && known.has(id);
    expect(resolveExecutorChain(team({ slug: 'a', name: 'A', lead: 'opencode', members: ['nvidia', 'codex'] }), known, 'ollama', avail))
      .toEqual(['nvidia', 'codex', 'ollama', 'opencode']);
  });
  it('chain[0] === resolveExecutor 반환(가용 lead)', () => {
    const known = new Set(['codex', 'ollama']);
    expect(resolveExecutorChain(team({ slug: 'a', name: 'A', lead: 'codex' }), known)[0]).toBe('codex');
  });
});

describe('selectCapabilityExecutor', () => {
  it('code 유형 → codex, 제거 provider 미반환', () => {
    expect(selectCapabilityExecutor('버그 수정·기능 구현', new Set(['ollama','nvidia','codex','opencode'])).executor).toBe('codex');
  });
  it('codex 미등록이면 역량순 가용 폴백', () => {
    const r = selectCapabilityExecutor('코드 구현 수정', new Set(['ollama','nvidia']));
    expect(['mlx','copilot','openrouter']).not.toContain(r.executor);
    expect(r.executor).toBe('ollama');
  });
  it('전원 서킷 open → 등록된 첫 후보', () => {
    expect(selectCapabilityExecutor('코드 구현', new Set(['codex','ollama']), 'ollama', () => false).executor).toBe('codex');
  });
});

describe('reselectExecutor', () => {
  const known = new Set(['opencode','codex','cursor-agent','ollama','agy','hermes','nvidia','claude-code']);
  it('lead 유효·가용 → 유지(note 없음)', () => {
    const r = reselectExecutor(team({ slug:'a', name:'A', lead:'codex' }), '코드 구현', known);
    expect(r.executor).toBe('codex'); expect(r.note).toBeUndefined();
  });
  it('제거 lead → 역량 재선정 + note', () => {
    const r = reselectExecutor(team({ slug:'a', name:'A', lead:'mlx-instruct' }), '아키텍처 설계', known);
    expect(r.executor).toBe('opencode'); expect(r.note).toMatch(/제거\/미등록/);
  });
});

describe('durable company resume budget', () => {
  it('does not consume a loop iteration merely because the process restarted mid-iteration', () => {
    expect(decideCompanyRunResume({
      incomplete: true,
      resumeCount: 1,
      completedIterations: 4,
      maxIterations: 5,
    })).toBe('continue');
  });

  it('terminates on completed loop budget or repeated restart recovery budget', () => {
    expect(decideCompanyRunResume({
      incomplete: true,
      resumeCount: 1,
      completedIterations: 5,
      maxIterations: 5,
    })).toBe('iteration_budget_exhausted');
    expect(decideCompanyRunResume({
      incomplete: true,
      resumeCount: 4,
      completedIterations: 1,
      maxIterations: 5,
      maxResumes: 3,
    })).toBe('recovery_budget_exhausted');
  });
});
