import { describe, expect, it } from 'vitest';
import { env } from '../utils/config.js';
import { resolveVerifierProjectDir } from './task-queue.js';

describe('resolveVerifierProjectDir', () => {
  it('runs a task verifier in the validated task project directory', () => {
    expect(resolveVerifierProjectDir({
      metadata: { projectDir: ' /private/tmp/triad-worktree ' },
    })).toBe('/private/tmp/triad-worktree');
  });

  it('falls back to the NCO project directory when no override exists', () => {
    expect(resolveVerifierProjectDir({ metadata: {} })).toBe(env.PROJECT_DIR);
  });
});
