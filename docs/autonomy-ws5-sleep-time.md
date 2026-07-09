# NCO Autonomy Workstream 5 (WS5) — Sleep-time Self-improvement Cron Design

This document describes the design for the sleep-time self-improvement cron engine under Workstream 5. The engine runs during idle periods to review recent execution outputs, files, and logs, distill lessons, and integrate them into the central knowledge base (`gbrain`).

---

## 1. New & Modified Files

* **`src/core/sleep-consolidator.ts` (Modified)**:
  * Elevate the existing SCM-inspired `SleepConsolidator` class.
  * Add the self-improvement consolidation pipeline: fetch recent tasks, read improvement note markdown files, query logs, format raw materials, distill via LLM, and write to `knowledge_base`.
* **`src/core/cron-scheduler.ts` (Modified)**:
  * Add support for `'internal'` task execution in `CronJobDef` and `executeJob()`.
  * Register the sleep consolidation task as a default internal cron job on boot.
* **`src/core/knowledge-base.ts` (Modified)**:
  * Ensure query, saving, and deduplication logic matches consolidated lessons.

---

## 2. TypeScript Signatures & Interfaces

### Modified: `src/core/sleep-consolidator.ts`

```typescript
export interface SelfImprovementReport {
  tasksReviewed: number;
  notesReviewed: number;
  logsReviewed: number;
  lessonsDistilled: number;
  lessonsSaved: number;
  durationMs: number;
}

export interface RawInputData {
  tasks: Array<{
    id: string;
    prompt: string;
    response: string;
    completedAt: string;
    workspaceId: string;
  }>;
  notes: Array<{
    filename: string;
    content: string;
    mtime: string;
  }>;
  logs: Array<{
    id: string;
    timestamp: string;
    level: string;
    message: string;
    contextJson?: string;
  }>;
}

export interface DistilledLesson {
  category: 'bug_pattern' | 'architecture' | 'convention' | 'decision';
  content: string;
  projectPath: string;
  sourceTaskId?: string;
  confidence: number;
}

// Added/Modified methods inside class SleepConsolidator:
class SleepConsolidator {
  private runningSelfImprovement = false;

  /**
   * Main entry point for sleep-time self-improvement distillation.
   * Retrieves data since the last successful run, distills lessons, and updates knowledge base.
   */
  async consolidateSelfImprovements(): Promise<SelfImprovementReport>;

  private async fetchRecentTasks(since: string): Promise<RawInputData['tasks']>;
  private async fetchRecentFileSystemNotes(since: string): Promise<RawInputData['notes']>;
  private async fetchRecentLogs(since: string): Promise<RawInputData['logs']>;
  private async distillLessonsWithLLM(inputs: RawInputData): Promise<DistilledLesson[]>;
  private async mergeAndSaveLessons(lessons: DistilledLesson[]): Promise<number>;
}
```

### Modified: `src/core/cron-scheduler.ts`

```typescript
export interface CronJobDef {
  id?: string;
  description?: string;
  schedule: string;
  // Extended taskType to support direct TS/JS internal calls:
  taskType?: 'nco_task' | 'shell' | 'webhook' | 'internal';
  payload?: Record<string, unknown>; // For internal taskType, e.g. { action: "sleep-consolidation" }
  timezone?: string;
  maxRetries?: number;
  backoffMs?: number;
  enabled?: boolean;
}
```

---

## 3. Cron Schedule & Execution Policy

* **Schedule Policy**: `0 3 * * *` (Every day at 3:00 AM local time / configured timezone).
* **Execution Trigger Conditions**:
  * Active task check: `SELECT COUNT(*) FROM tasks WHERE status IN ('running', 'streaming', 'reviewing')` must return `0`. If any task is active, reschedule/delay by 1 hour.
  * Mutex check: Neither memory consolidation (`isRunning`) nor self-improvement consolidation (`runningSelfImprovement`) must be active.
* **Retry Policy**:
  * Max retries: `3`.
  * Backoff: `60,000` ms (1 minute).

---

## 4. Connection & Integration Points

1. **Task Registry (`nco.db` - `tasks`)**:
   * Reads completed tasks: `status = 'completed'` with `completed_at` greater than the last execution run.
2. **Local Filesystem (`~/.claude/improvements/`)**:
   * Scans markdown files (`*.md`) where file modification time (`mtime`) is newer than the last execution run.
3. **Log Registry (`nco.db` - `logs` / `mesh_messages`)**:
   * Queries error/warning logs and mesh transaction history where `timestamp` is newer than the last execution run.
4. **LLM Distillation Gateway (`OpenRouter` / `Ollama`)**:
   * Packages raw text into structured markdown inputs.
   * Prompts the LLM (using `openai/gpt-4o-mini` or `nomic-embed-text` fallback) to return structured JSON containing lessons.
5. **Knowledge Base (`gbrain` - `knowledge_base`)**:
   * Feeds the distilled outputs directly into `knowledgeBase.saveWithEmbedding()` or updates existing entries using semantic lookup.

---

## 5. Risks & Mitigation Strategies

| Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **LLM Hallucinations** | High | Apply structured system prompting with strict schemas. Reject lessons where confidence score is `< 0.7`. |
| **Token Bloat / Cost** | Medium | Truncate task outputs and logs to the first/last 2000 characters. Scrub long stack traces and repeated stdout. |
| **Knowledge Duplication**| Medium | Before saving, perform a semantic similarity check (`findSimilarAsync`). If similarity exceeds `0.85`, merge descriptions and increment confidence rather than inserting a new row. |
| **Sensitive Data Leakage**| High | Pre-process inputs with regex sanitizers to strip environment variables, auth tokens, API keys, passwords, and private IPs. |
| **Concurrency / System Lock**| Low | Mark consolidation processes as low-priority async tasks. Run SQLite database operations within short transactions to avoid database lockups. |

---

## 6. Verification Plan & Evidence Tiers
*(This design is currently **unverified** as implementation is scheduled for the next phase)*

* **Evidence Tier 1 (Ground Truth)**:
  * Check that `gbrain` (`knowledge_base` table) contains entries with `source_task_id` indicating they were created by the consolidation cron.
  * Verify that cron jobs log entries in the `logs` table with `category = 'sleep-consolidator'` showing successful distillation.
* **Evidence Tier 2 (Process Execution)**:
  * Run the consolidation command manually using a CLI flag (e.g. `nco-cli --consolidate-self`) and inspect the terminal output report.
* **Evidence Tier 3 (Status Strings)**:
  * Check the `cron_jobs` table row where `id = 'sleep-self-improvement'` and verify `last_status = 'success'`.
