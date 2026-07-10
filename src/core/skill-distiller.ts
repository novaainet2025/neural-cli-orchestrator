import { promises as fs } from 'fs';
import { resolve, dirname } from 'path';
import { getDb } from '../storage/database.js';
import { knowledgeBase } from './knowledge-base.js';
import type { KnowledgeEntry } from './knowledge-base.js';
import { createLogger } from '../utils/logger.js';
import { OLLAMA_KEEP_ALIVE } from '../utils/ollama.js';

const log = createLogger('skill-distiller');

export interface TaskTrajectoryStep {
  agentId: string;
  commandLine?: string;
  fileEdits?: Array<{ path: string; changeSummary: string }>;
  prompt: string;
  output: string;
}

export interface TaskTrajectory {
  taskId: string;
  taskType: string;
  projectPath: string;
  goal: string;
  steps: TaskTrajectoryStep[];
  finalOutput: string;
}

export interface DistilledSkill {
  id: string;
  name: string;
  description: string;
  triggerKeywords: string[];
  markdownContent: string; // SKILL.md 포맷의 내용
}

function tokenWordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(w => w.length > 0);
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) {
    if (b.has(w)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchEmbedding(text: string): Promise<number[] | null> {
  const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embed';
  const LEGACY_EMBED_URL = 'http://localhost:6270/embed';
  const EMBED_MODEL = 'nomic-embed-text';

  // 1) Try ollama
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text, keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings?.[0])) return data.embeddings![0];
    }
  } catch { /* fallthrough */ }

  // 2) Legacy
  try {
    const res = await fetch(LEGACY_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { embedding?: number[] };
      if (Array.isArray(data.embedding)) return data.embedding;
    }
  } catch { /* fallthrough */ }

  return null;
}

export class SkillDistiller {
  /**
   * 태스크 실행 궤적(Trajectory)과 최종 결과물로부터 LLM을 사용하여 재사용 가능한 SKILL.md 내용을 증류함.
   */
  async distill(trajectory: TaskTrajectory): Promise<DistilledSkill> {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log.info('No LLM API key found, using fallback distiller');
      return this.fallbackDistill(trajectory);
    }

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey,
        baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
      });

      const prompt = `
Task ID: ${trajectory.taskId}
Task Type: ${trajectory.taskType}
Goal (Initial Prompt): ${trajectory.goal}
Steps taken:
${trajectory.steps.map((s, i) => `Step ${i + 1} (${s.agentId}):
Prompt: ${s.prompt}
Output: ${s.output.slice(0, 1000)}
${s.fileEdits ? `File edits: ${JSON.stringify(s.fileEdits)}` : ''}`).join('\n\n')}

Final Output:
${trajectory.finalOutput}
`;

      const response = await client.chat.completions.create({
        model: process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o-mini' : 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              'You are a Senior Systems Architect.',
              'Distill the provided task trajectory into a reusable skill instruction file `SKILL.md`.',
              'You MUST respond with a JSON object only. Do NOT wrap the JSON in markdown code blocks or quotes.',
              'Response JSON structure:',
              '{',
              '  "id": "slugified-skill-id",',
              '  "name": "Human Readable Skill Name",',
              '  "description": "Brief description of the skill",',
              '  "triggerKeywords": ["keyword1", "keyword2"],',
              '  "markdownContent": "The full markdown content for the SKILL.md. It must start with YAML frontmatter containing name and description, and then clear headers explaining the skill instructions, goal, steps, and reference output."',
              '}'
            ].join('\n')
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const raw = response.choices[0]?.message?.content?.trim();
      if (!raw) {
        throw new Error('Empty LLM response');
      }

      // Strip markdown block wrapping if LLM ignored instructions
      let cleaned = raw;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      }

      const parsed = JSON.parse(cleaned) as DistilledSkill;
      if (!parsed.id || !parsed.name || !parsed.markdownContent) {
        throw new Error('Invalid JSON structure returned by LLM');
      }

      return parsed;
    } catch (err: any) {
      log.error({ err: err.message }, 'LLM distillation failed, using fallback');
      return this.fallbackDistill(trajectory);
    }
  }

  private fallbackDistill(trajectory: TaskTrajectory): DistilledSkill {
    const cleanId = trajectory.taskId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    const id = `skill-${cleanId}`;
    const name = `Skill from task ${trajectory.taskId}`;
    const description = `Automatically distilled skill from goal: ${trajectory.goal.slice(0, 100)}`;
    const triggerKeywords = trajectory.goal
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    const markdownContent = `---
name: ${name}
description: ${description}
---

# ${name}

## Goal
${trajectory.goal}

## Distilled Instructions
Based on the execution of task ${trajectory.taskId}:
1. Re-execute steps if needed using similar command patterns.

## Reference Output
\`\`\`
${trajectory.finalOutput}
\`\`\`
`;

    return {
      id,
      name,
      description,
      triggerKeywords,
      markdownContent
    };
  }

  /**
   * Knowledge Base의 임베딩 기반 유사도 검색을 통해 이미 존재하는 스킬이나 지식과의 중복 여부를 검사함.
   */
  async checkDuplication(
    skill: DistilledSkill,
    threshold = 0.85
  ): Promise<{ isDuplicate: boolean; similarity: number; match?: KnowledgeEntry }> {
    const candidates = await knowledgeBase.findSimilarAsync(skill.markdownContent, 3);
    if (candidates.length === 0) {
      return { isDuplicate: false, similarity: 0 };
    }

    let bestSimilarity = 0;
    let bestMatch: KnowledgeEntry | undefined = undefined;

    const queryEmbedding = await fetchEmbedding(skill.markdownContent);

    for (const candidate of candidates) {
      let sim = 0;
      if (queryEmbedding) {
        const db = getDb();
        const row = db.prepare('SELECT embedding_json FROM knowledge_base WHERE id = ?').get(candidate.id) as any;
        const stored = row?.embedding_json ? JSON.parse(row.embedding_json) : null;
        if (stored && stored.length === queryEmbedding.length) {
          sim = cosineSimilarity(queryEmbedding, stored);
        } else {
          sim = jaccardSimilarity(tokenWordSet(skill.markdownContent), tokenWordSet(candidate.content));
        }
      } else {
        sim = jaccardSimilarity(tokenWordSet(skill.markdownContent), tokenWordSet(candidate.content));
      }

      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = candidate;
      }
    }

    return {
      isDuplicate: bestSimilarity >= threshold,
      similarity: bestSimilarity,
      match: bestMatch
    };
  }

  /**
   * 증류된 스킬을 로컬 및 fleet 설정 경로에 파일로 저장 및 등록 배포함.
   */
  async deploy(skill: DistilledSkill): Promise<{ localPath: string; fleetPath: string }> {
    const projectPath = process.env.PROJECT_DIR || './';
    const name = skill.id || 'unnamed-skill';

    // Staging paths to respect "자동 배포는 승인 게이트 뒤 — 파일은 staging 디렉터리에 생성"
    const localPath = resolve(projectPath, 'staging', 'local', 'skills', name, 'SKILL.md');
    const fleetPath = resolve(projectPath, 'staging', 'fleet', 'skills', name, 'SKILL.md');

    await fs.mkdir(dirname(localPath), { recursive: true });
    await fs.mkdir(dirname(fleetPath), { recursive: true });

    await fs.writeFile(localPath, skill.markdownContent, 'utf-8');
    await fs.writeFile(fleetPath, skill.markdownContent, 'utf-8');

    log.info({ localPath, fleetPath }, 'Skill deployed to staging directories');

    return { localPath, fleetPath };
  }

  /**
   * 전체 파이프라인(Trigger -> Distill -> Duplication Check -> Deploy)을 실행하는 메인 엔트리포인트.
   */
  async runPipeline(taskId: string, output: string, projectPath: string, trajectory: TaskTrajectory): Promise<void> {
    log.info({ taskId }, 'Starting skill distillation pipeline');

    const skill = await this.distill(trajectory);
    const dupCheck = await this.checkDuplication(skill);

    if (dupCheck.isDuplicate) {
      log.info({ taskId, similarity: dupCheck.similarity }, 'Skill is duplicate, skipping deployment. Upserting distilled lesson.');
      const kbEntry: KnowledgeEntry = {
        projectPath,
        category: 'convention',
        content: skill.markdownContent,
        sourceTaskId: taskId,
        confidence: Math.max(0.8, dupCheck.similarity)
      };
      await knowledgeBase.upsertDistilledLesson(kbEntry, 0.85);
    } else {
      const paths = await this.deploy(skill);
      log.info({ taskId, ...paths }, 'Skill distilled and deployed');

      // Also save to dynamic_skills database
      const db = getDb();
      const pipeline = [{
        step: 1,
        agentId: trajectory.steps[0]?.agentId || 'codex',
        promptTemplate: skill.markdownContent,
        qualityThreshold: 60
      }];
      db.prepare(`
        INSERT OR REPLACE INTO dynamic_skills (id, name, description, trigger_keywords, pipeline, quality_threshold, is_active, auto_generated)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1)
      `).run(
        skill.id,
        skill.name,
        skill.description,
        JSON.stringify(skill.triggerKeywords),
        JSON.stringify(pipeline),
        60
      );

      // Also save to knowledge_base
      const kbEntry: KnowledgeEntry = {
        projectPath,
        category: 'convention',
        content: skill.markdownContent,
        sourceTaskId: taskId,
        confidence: 0.85
      };
      await knowledgeBase.saveWithEmbedding(kbEntry);
    }
  }
}

export const skillDistiller = new SkillDistiller();

export async function gatherTaskTrajectory(taskId: string): Promise<TaskTrajectory> {
  const db = getDb();
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!taskRow) {
    throw new Error(`Task not found: ${taskId}`);
  }

  let taskType = 'general';
  if (taskRow.metadata_json) {
    try {
      const meta = JSON.parse(taskRow.metadata_json);
      if (meta && typeof meta.taskType === 'string') {
        taskType = meta.taskType;
      } else if (meta && typeof meta.task_type === 'string') {
        taskType = meta.task_type;
      }
    } catch {}
  }
  if (taskRow.prompt && /distill|증류/i.test(taskRow.prompt)) {
    taskType = 'distill';
  }

  const artifacts = db.prepare('SELECT path FROM artifacts WHERE task_id = ?').all(taskId) as any[];
  const fileEdits = artifacts.map(a => ({
    path: a.path,
    changeSummary: `Created or modified file ${a.path}`
  }));

  const steps: TaskTrajectoryStep[] = [
    {
      agentId: taskRow.assigned_to || 'unknown',
      prompt: taskRow.prompt,
      output: taskRow.response || '',
      fileEdits: fileEdits.length > 0 ? fileEdits : undefined
    }
  ];

  return {
    taskId,
    taskType,
    projectPath: process.env.PROJECT_DIR || './',
    goal: taskRow.prompt,
    steps,
    finalOutput: taskRow.response || ''
  };
}
