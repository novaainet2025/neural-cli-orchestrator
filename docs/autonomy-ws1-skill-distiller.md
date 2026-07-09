# NCO Autonomy WS1: Skill Distiller Design Specification

This specification outlines the design for the **Skill Distiller** pipeline, which automatically distills verified task trajectories into reusable `SKILL.md` configurations, checks for duplication using knowledge base embeddings, and deploys them to local and fleet configurations.

---

## 1. 신규 및 수정 파일 (New & Modified Files)

- **신규 파일**: `src/core/skill-distiller.ts` (핵심 증류, 중복 검사 및 배포 로직 담당)
- **수정 파일**: `src/core/kanban-engine.ts` (태스크 완료 및 검증 성공 시점에 증류 파이프라인 트리거 통합)
- **기존 모듈 재사용**: `src/core/knowledge-base.ts` (임베딩 추출 및 유사도 판별), `src/core/task-evidence.ts` (태스크 검증 데이터 파싱 및 검증 확인)

---

## 2. TS 시그니처 (TypeScript Signatures)

```typescript
// src/core/skill-distiller.ts

import { KnowledgeEntry } from './knowledge-base.js';

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

export class SkillDistiller {
  /**
   * 태스크 실행 궤적(Trajectory)과 최종 결과물로부터 LLM을 사용하여 재사용 가능한 SKILL.md 내용을 증류함.
   */
  async distill(trajectory: TaskTrajectory): Promise<DistilledSkill>;

  /**
   * Knowledge Base의 임베딩 기반 유사도 검색을 통해 이미 존재하는 스킬이나 지식과의 중복 여부를 검사함.
   */
  async checkDuplication(
    skill: DistilledSkill,
    threshold?: number
  ): Promise<{ isDuplicate: boolean; similarity: number; match?: KnowledgeEntry }>;

  /**
   * 증류된 스킬을 로컬 및 fleet 설정 경로에 파일로 저장 및 등록 배포함.
   */
  async deploy(skill: DistilledSkill): Promise<{ localPath: string; fleetPath: string }>;

  /**
   * 전체 파이프라인(Trigger -> Distill -> Duplication Check -> Deploy)을 실행하는 메인 엔트리포인트.
   */
  async runPipeline(taskId: string, output: string, projectPath: string, trajectory: TaskTrajectory): Promise<void>;
}
```

---

## 3. 연결 지점 (Integration Points)

### 3.1 트리거 지점 (Trigger Location)
- **위치**: `src/core/kanban-engine.ts` -> `transitionTask` (또는 태스크 상태 업데이트 및 검증 완료를 관장하는 메인 함수)
- **트리거 조건**:
  1. 태스크의 최종 상태 전합성 (`TaskStatus === 'COMPLETED'`)
  2. 태스크 검증(Verifier) 통과: `extractTaskEvidenceJson(output)`을 통해 `warning`이 없고, Zod 검증을 마친 `evidenceJson`에 증거(`T1`/`T2` Tier 검증 상태)가 존재하여 Quality Gate 검증을 성공적으로 마친 상태.
- **연결 로직**:
  ```typescript
  import { skillDistiller } from './skill-distiller.js';
  import { extractTaskEvidenceJson } from './task-evidence.js';

  // 검증 통과 여부 및 태스크 완료 처리 시점
  const evidenceResult = extractTaskEvidenceJson(taskOutput);
  if (!evidenceResult.warning && evidenceResult.evidenceJson) {
    const trajectory = await gatherTaskTrajectory(taskId);
    // 백그라운드 태스크로 스킬 증류 파이프라인 비동기 실행 (본문 흐름 비차단)
    skillDistiller.runPipeline(taskId, taskOutput, projectPath, trajectory).catch(err => {
      log.error({ taskId, err }, 'Skill distillation pipeline failed');
    });
  }
  ```

### 3.2 중복 검사 연동 (Duplication Check Integration)
- **위치**: `src/core/skill-distiller.ts` -> `checkDuplication`
- **로직**: `knowledgeBase.findSimilarAsync(skill.markdownContent, 3)`을 통해 검색된 유사 지식 엔트리와의 유사도를 판정함.
- 유사도 점수가 `0.85` 이상일 경우, 중복 스킬 등록을 방지하거나 `knowledgeBase.upsertDistilledLesson`을 사용해 지식을 병합 처리함.

### 3.3 배포 경로 (Deployment Paths)
- **로컬 경로**: `~/.claude/skills/<name>/SKILL.md` (로컬 Claude 환경 즉시 반영)
- **Fleet 설정 경로**: `~/nova-fleet-config/skills/<name>/SKILL.md` (Fleet 내 다른 에이전트들과 동기화 및 형상 관리 공유)
- 배포 완료 후 `~/nova-fleet-config/install/fleet-sync.sh` 또는 관련 동기화 메커니즘이 기동되도록 연계 유도.

---

## 4. 리스크 및 완화 방안 (Risks & Mitigations)

| 리스크 (Risk) | 완화 방안 (Mitigation) |
| :--- | :--- |
| **무한 루프/자가 증류 리스크** | 증류기 자체의 수행 로그나 중복 스킬 빌드는 트리거 대상에서 명시적으로 제외(`taskType !== 'distill'`). |
| **품질 미달 스킬 배포** | `extractTaskEvidenceJson`으로 획득한 Tier 1/2 수준의 고신뢰도 검증 데이터가 확보된 궤적에 대해서만 트리거링 제한. |
| **동일 스킬명 충돌** | 슬러그화된 스킬명 뒤에 짧은 해시값을 부착하거나 중복 검사 단계에서 기존 파일명을 검출하여 버전 병합 처리. |
| **API 레이턴시 및 타임아웃** | 스킬 증류 및 임베딩 추출 로직은 메인 태스크 완료 흐름을 차단하지 않는 비동기 백그라운드 태스크 형태로 실행. |
