import { describe, expect, it } from 'vitest';
import {
  applyPromptGate,
  buildDefaultVerifierWithFs,
  inferTaskType,
  isCodeWorkPrompt,
  validateProjectDirMetadataWithFs,
} from './task-intake.js';

describe('task-intake helpers', () => {
  it('enriches prompts below the prompt-gate threshold', () => {
    const result = applyPromptGate('[목표] 버그 수정', { projectDir: '/repo' });

    expect(result.promptGate).toEqual({
      score: 20,
      missing: ['컨텍스트', '제약', '출력형식', '검증기준'],
      enriched: true,
    });
    expect(result.prompt).toContain('--- 자동 보강 ---');
    expect(result.prompt).toContain('[컨텍스트] 프로젝트: /repo / 작업 유형: bugfix');
  });

  it('keeps prompts that already satisfy the gate', () => {
    const prompt = [
      '[컨텍스트] repo',
      '[목표] 구현',
      '[제약] 범위 유지',
      '[출력형식] diff',
      '[검증기준] npm run build',
    ].join('\n');

    const result = applyPromptGate(prompt, { projectDir: '/repo' });

    expect(result.prompt).toBe(prompt);
    expect(result.promptGate).toEqual({ score: 100 });
  });

  it('assigns the default verifier for code work with package.json', () => {
    const verifier = buildDefaultVerifierWithFs({
      prompt: 'src/server/gateway.ts 버그 수정',
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => true);

    expect(verifier).toEqual({
      type: 'run',
      command: 'npm run build',
      timeoutMs: 120_000,
    });
  });

  it('does not assign the default verifier when projectDir lacks package.json', () => {
    const verifier = buildDefaultVerifierWithFs({
      prompt: 'src/server/gateway.ts 버그 수정',
      metadata: { projectDir: '/repo' },
      verifier: undefined,
    }, () => false);

    expect(verifier).toBeUndefined();
  });

  it('requires metadata.projectDir at task creation time', () => {
    expect(validateProjectDirMetadataWithFs(undefined, () => true)).toBe('metadata.projectDir is required');
    expect(validateProjectDirMetadataWithFs({}, () => true)).toBe('metadata.projectDir is required');
  });

  it('rejects a non-existent metadata.projectDir', () => {
    expect(validateProjectDirMetadataWithFs({ projectDir: '/missing' }, () => false)).toBe(
      'metadata.projectDir does not exist: /missing',
    );
  });

  it('classifies code-work prompts and infers task types', () => {
    expect(isCodeWorkPrompt('gateway 버그 수정')).toBe(true);
    expect(isCodeWorkPrompt('회의록 요약')).toBe(false);
    expect(inferTaskType('리팩터 진행')).toBe('refactor');
    expect(inferTaskType('새 모듈 구현')).toBe('implementation');
  });
});
