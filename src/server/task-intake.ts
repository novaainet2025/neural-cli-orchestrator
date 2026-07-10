import { existsSync } from 'fs';
import { resolve } from 'path';
import type { CreateTaskInputType } from '../utils/validation.js';
import { analyzePrompt, enrichPrompt } from './prompt-gate.js';

export type PromptGateInfo =
  | {
    score: number;
  }
  | {
    score: number;
    missing: string[];
    enriched: true;
  };

const CODE_WORK_PATTERN = /\b(implement|implementation|fix|bug|patch|refactor|refactoring|code|build)\b|구현|수정|버그|리팩터|리팩토링|코드/i;

export function isCodeWorkPrompt(prompt: string): boolean {
  return CODE_WORK_PATTERN.test(prompt);
}

export function inferTaskType(prompt: string): string | undefined {
  if (/(?:refactor|refactoring|리팩터|리팩토링)/i.test(prompt)) return 'refactor';
  if (/(?:bug|fix|patch|버그|수정)/i.test(prompt)) return 'bugfix';
  if (/(?:implement|implementation|구현)/i.test(prompt)) return 'implementation';
  return undefined;
}

export function applyPromptGate(prompt: string, metadata?: Record<string, unknown>): {
  prompt: string;
  promptGate: PromptGateInfo;
} {
  const analysis = analyzePrompt(prompt);
  if (analysis.score < 60) {
    return {
      prompt: enrichPrompt(prompt, {
        projectDir: typeof metadata?.projectDir === 'string' ? metadata.projectDir : undefined,
        taskType: inferTaskType(prompt),
      }),
      promptGate: {
        score: analysis.score,
        missing: analysis.missing,
        enriched: true,
      },
    };
  }

  return {
    prompt,
    promptGate: { score: analysis.score },
  };
}

export function buildDefaultVerifier(input: Pick<CreateTaskInputType, 'prompt' | 'metadata' | 'verifier'>): CreateTaskInputType['verifier'] | undefined {
  return buildDefaultVerifierWithFs(input, existsSync);
}

export function validateProjectDirMetadata(metadata?: Record<string, unknown>): string | undefined {
  return validateProjectDirMetadataWithFs(metadata, existsSync);
}

export function validateProjectDirMetadataWithFs(
  metadata: Record<string, unknown> | undefined,
  pathExists: (path: string) => boolean,
): string | undefined {
  const projectDir = typeof metadata?.projectDir === 'string' ? metadata.projectDir.trim() : '';
  if (!projectDir) return 'metadata.projectDir is required';
  if (!pathExists(projectDir)) return `metadata.projectDir does not exist: ${projectDir}`;
  return undefined;
}

export function buildDefaultVerifierWithFs(
  input: Pick<CreateTaskInputType, 'prompt' | 'metadata' | 'verifier'>,
  pathExists: (path: string) => boolean,
): CreateTaskInputType['verifier'] | undefined {
  if (input.verifier) return input.verifier;
  const projectDir = typeof input.metadata?.projectDir === 'string' ? input.metadata.projectDir : undefined;
  if (!projectDir || !isCodeWorkPrompt(input.prompt)) return undefined;
  if (!pathExists(resolve(projectDir, 'package.json'))) return undefined;

  return {
    type: 'run',
    command: 'npm run build',
    timeoutMs: 120_000,
  };
}
