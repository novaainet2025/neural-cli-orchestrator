import { describe, expect, it } from 'vitest';
import { buildConductorDiscussionOptions } from './conductor-dispatch.js';

const input = {
  topic: 'nova-cli 장단점 알려줘',
  mode: 'discussion' as const,
  providers: ['codex', 'agy'],
  maxRounds: 3,
  sessionId: 'discussion-1',
  taskId: 'task-1',
  workflowRunId: 'workflow-1',
};

describe('buildConductorDiscussionOptions', () => {
  it('propagates the caller projectDir into the multi-agent discussion path', () => {
    expect(
      buildConductorDiscussionOptions(input, {
        projectDir: ' /Users/nova-ai/project/nova-cli ',
        workflowStage: 'discussion',
      }),
    ).toEqual({
      ...input,
      projectDir: '/Users/nova-ai/project/nova-cli',
    });
  });

  it('preserves the existing engine fallback when legacy callers omit projectDir', () => {
    expect(buildConductorDiscussionOptions(input, {})).toEqual(input);
  });
});
