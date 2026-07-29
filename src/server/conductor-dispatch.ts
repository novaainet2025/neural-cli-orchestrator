import type {
  DiscussionMode,
  DiscussionOptions,
} from '../core/discussion-engine.js';

export interface ConductorDiscussionInput {
  topic: string;
  mode: DiscussionMode;
  providers: string[];
  maxRounds: number;
  sessionId: string;
  taskId: string;
  teamId?: string;
  companyRunId?: string;
  workflowRunId: string;
}

export const buildConductorDiscussionOptions = (
  input: ConductorDiscussionInput,
  metadata: Record<string, unknown>,
): DiscussionOptions => {
  const projectDir = typeof metadata.projectDir === 'string'
    ? metadata.projectDir.trim()
    : '';
  return {
    ...input,
    ...(projectDir ? { projectDir } : {}),
  };
};
