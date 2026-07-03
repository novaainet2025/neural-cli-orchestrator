import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, runMigrations, closeDb } from '../src/storage/database.js';
import { skillDistiller, gatherTaskTrajectory } from '../src/core/skill-distiller.js';
import { knowledgeBase } from '../src/core/knowledge-base.js';
import { env } from '../src/utils/config.js';
import { unlinkSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';

describe('Skill Distiller', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-skill-distiller.db');
  let originalFetch: typeof global.fetch;
  let originalDbPath: string;

  beforeAll(() => {
    // Mock global.fetch to prevent timeouts on offline embedding service APIs
    originalFetch = global.fetch;
    global.fetch = async () => {
      return new Response(null, { status: 500 });
    };

    // Close and reset cached database connection to use test-specific DB
    closeDb();
    originalDbPath = env.DATABASE_PATH;
    process.env.DATABASE_PATH = testDbPath;

    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Initialize DB and run migrations
    getDb();
    runMigrations();

    // Clean up staging directory if exists
    const stagingDir = resolve(env.ROOT, 'staging');
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
    closeDb();
    process.env.DATABASE_PATH = originalDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    const stagingDir = resolve(env.ROOT, 'staging');
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  it('should gather task trajectory from database', async () => {
    const db = getDb();
    const taskId = 'task_test_distill_123';
    
    // Seed a task
    db.prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, response)
      VALUES (?, 'task', 'Implement a bubble sort in Python', 'codex', 'completed', 'def bubble_sort(arr): ...')
    `).run(taskId);

    // Seed an artifact
    db.prepare(`
      INSERT INTO artifacts (id, agent_id, task_id, artifact_type, path, content)
      VALUES ('art_1', 'codex', ?, 'code', 'bubble_sort.py', 'def bubble_sort(arr): ...')
    `).run(taskId);

    const trajectory = await gatherTaskTrajectory(taskId);
    
    expect(trajectory.taskId).toBe(taskId);
    expect(trajectory.taskType).toBe('general');
    expect(trajectory.goal).toContain('bubble sort');
    expect(trajectory.steps.length).toBe(1);
    expect(trajectory.steps[0].agentId).toBe('codex');
    expect(trajectory.steps[0].fileEdits).toBeDefined();
    expect(trajectory.steps[0].fileEdits![0].path).toBe('bubble_sort.py');
  });

  it('should distill skill and deploy to staging', async () => {
    const trajectory = {
      taskId: 'task_test_distill_123',
      taskType: 'general',
      projectPath: './',
      goal: 'Implement a bubble sort in Python',
      steps: [
        {
          agentId: 'codex',
          prompt: 'Implement a bubble sort in Python',
          output: 'def bubble_sort(arr): ...',
          fileEdits: [{ path: 'bubble_sort.py', changeSummary: 'Created bubble_sort.py' }]
        }
      ],
      finalOutput: 'def bubble_sort(arr): ...'
    };

    const skill = await skillDistiller.distill(trajectory);
    expect(skill.id).toContain('tasktestdistill123');
    expect(skill.name).toBe('Skill from task task_test_distill_123');
    expect(skill.markdownContent).toContain('bubble sort');

    const paths = await skillDistiller.deploy(skill);
    expect(existsSync(paths.localPath)).toBe(true);
    expect(existsSync(paths.fleetPath)).toBe(true);
  });

  it('should check for duplication in knowledge base', async () => {
    const skill = {
      id: 'skill-bubble-sort-py',
      name: 'Bubble Sort in Python',
      description: 'How to write bubble sort in Python',
      triggerKeywords: ['bubble', 'sort', 'python'],
      markdownContent: 'Use bubble_sort to sort arrays in python.'
    };

    // Before inserting the lesson, it should not be a duplicate
    const dupCheck1 = await skillDistiller.checkDuplication(skill, 0.85);
    expect(dupCheck1.isDuplicate).toBe(false);

    // Save skill to knowledge base
    await knowledgeBase.saveWithEmbedding({
      projectPath: './',
      category: 'convention',
      content: skill.markdownContent,
      confidence: 0.9
    });

    // Now it should be a duplicate
    const dupCheck2 = await skillDistiller.checkDuplication(skill, 0.85);
    expect(dupCheck2.isDuplicate).toBe(true);
    expect(dupCheck2.similarity).toBeGreaterThanOrEqual(0.85);
    expect(dupCheck2.match?.content).toBe(skill.markdownContent);
  });
});
