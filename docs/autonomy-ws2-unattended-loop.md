# [WS2] 무인 완주 3규칙 설계 (Unattended Completion Loop)

본 문서는 NCO 자율성 축 WS2(무인 완주)의 핵심 메커니즘인 '무인 완주 3규칙'에 대한 단독 설계 사양서입니다. 기존 상태기계 및 시스템 Retry 구조와의 충돌을 원천 차단하면서, 실패 피드백 기반의 자율 최적화 루프를 구현합니다.

---

## 1. 핵심 설계 원칙 (무인 완주 3규칙)

1. **규칙 ①: 검증기(Verifier) 게이트 통과 = 칸반 전진 조건**
   - 칸반 태스크가 `done` 컬럼으로 전진하기 위한 필수 조건으로 Verifier 검증 통과를 설정합니다.
   - 단순히 에이전트 실행 API의 성공 여부(`success: true`)가 아니라, 실행 후 생성된 `tasks.verifier_result_json` 내부의 `passed: true` 값을 판정 기준으로 삼습니다.
   - Verifier 설정이 없는 일반 태스크의 경우에만 기존처럼 에이전트의 단순 실행 결과(`success`)를 폴백으로 사용합니다.

2. **규칙 ②: Verifier Feedback 루프 (Verifier-is-the-Gradient)**
   - Verifier 검증 실패 시, 해당 검증기가 출력한 실패 세부 정보(에러 메시지, 컴파일 실패 로그, 단위 테스트 실패 스택 트레이스 등)인 `outputSnippet`을 추출합니다.
   - 추출한 피드백을 다음 재시도 프롬프트 하단에 시스템 지시문 형태로 동적 주입하여, 에이전트가 이전 실패 원인을 파악하고 스스로 코드를 수정할 수 있는 "그래디언트(Gradient)" 역할을 하도록 설계합니다.

3. **규칙 ③: N회(기본 3회) 초과 시 사람 에스컬레이션**
   - 자동 복구 시도 횟수를 제한하기 위해 루프 내부에 카운터를 유지합니다.
   - 기본 3회(혹은 태스크 메타데이터에 지정된 값)를 초과하여 실패할 경우 재시도 루프를 탈출합니다.
   - 칸반 태스크를 `review` 컬럼으로 이동시키고, 최종 실행 Task의 메타데이터에 에스컬레이션 정보를 기록하여 인간 작업자의 개입을 유도합니다.

---

## 2. 신규/수정 파일 및 TS 시그니처

### 1) 대상 파일 구조
- **수정**: `src/core/kanban-engine.ts` (루프 처리 핵심 오케스트레이션 로직 추가)
- **참조 및 호환**: 
  - `src/core/task-state.ts` (상태기계 규칙 준수, 기존 상태 변경 로직 미수정)
  - `src/core/quality-gate.ts` (에이전트 자체 출력 품질 평가 모델 연동 가능)
- **신규 파일 생성 없음**: 기존 흐름 구조 내에 긴밀하게 결합하기 위해 별도의 모듈 분리 없이 `KanbanEngine` 클래스의 내부 실행 메커니즘만 개편합니다.

### 2) TS 시그니처 설계

```typescript
// src/core/kanban-engine.ts 에 반영될 주요 인터페이스 및 시그니처

/**
 * DB에서 조회할 Verifier 결과 구조체
 */
interface VerifierResult {
  passed: boolean;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputSnippet?: string;
  error?: string;
}

/**
 * 무인 루프 실행 옵션 및 설정
 */
interface UnattendedLoopConfig {
  maxRetries: number;       // 기본값: 3
  feedbackPrefix?: string;  // 프롬프트 결합 시 가이드 문구
}

// KanbanEngine 클래스 내부 추가/변경 구조
class KanbanEngine {
  // ... 기존 getBoard, moveTask, executePlan 메서드 ...

  /**
   * [핵심 변경] 단일 칸반 태스크를 실행하고 Verifier 기반 무인 루프를 수행
   * @param task kanban_tasks 테이블에서 로드된 레코드 개체
   */
  private async executeKanbanTask(task: any): Promise<any>;

  /**
   * [신규] 실행 완료된 Task DB 레코드로부터 Verifier 통과 여부 검증 및 피드백 추출
   */
  private async getVerifierStatus(
    db: any, 
    taskId: string, 
    agentSuccess: boolean
  ): Promise<{ passed: boolean; feedback: string }>;

  /**
   * [신규] 이전 시도의 실패 정보를 반영하여 프롬프트 재생성
   */
  private injectFeedbackToPrompt(
    originalPrompt: string, 
    feedback: string, 
    currentAttempt: number, 
    maxAttempts: number
  ): string;

  /**
   * [신규] 최대 재시도 횟수 도달 시 시스템 메타데이터 기록 및 알림 이벤트 발행
   */
  private async triggerHumanEscalation(
    db: any, 
    kanbanTaskId: string, 
    lastTaskId: string, 
    reason: string
  ): Promise<void>;
}
```

---

## 3. 연결 지점 (Integration Points)

### 1) `executeKanbanTask` 실행 오케스트레이션 흐름
1. **상태 초기화**: `moveTask(task.id, 'in_progress')` 호출로 칸반 보드 상태를 진행 중으로 전환합니다.
2. **루프 진입**: 로컬 변수로 `attempt = 0`, `currentPrompt = task.title`, `maxAttempts = 3` 설정.
3. **에이전트 실행**: `agentManager.executeTask(agentId, currentPrompt, {})`를 통해 독립적인 Task 인스턴스를 생성.
4. **검증 수행**:
   - 실행 결과 반환 시 `result.taskId` 획득.
   - DB(`tasks`)에서 해당 `taskId`의 `verifier_result_json`과 `error`를 쿼리.
   - `passed` 여부 판별.
5. **분기 처리**:
   - **검증 통과 (Success)**: `moveTask(task.id, 'done')` 호출 및 성공한 `taskId`를 `kanban_tasks.task_id`에 업데이트 후 결과 반환.
   - **검증 실패 (Fail)**:
     - `attempt < maxAttempts`인 경우: `injectFeedbackToPrompt`를 통해 에러 피드백을 가공해 `currentPrompt`를 갱신하고 루프 재시작.
     - `attempt >= maxAttempts`인 경우: 루프를 중단하고 **인간 에스컬레이션** 단계로 이행.

### 2) 기존 상태기계(`task-state.ts`)와의 호환성 확보
- **제약 조건**: `task-state.ts`가 정의하는 상태기계 규칙에 따르면, 완료(`completed`) 또는 실패(`failed`) 상태는 종단 상태(Terminal States)로, 외부로의 추가 상태 전이가 불가능합니다.
- **해결 방식**: 
  - 검증 실패 시 기존 Task ID를 재사용하여 상태 전이를 시도하지 않습니다.
  - 매 재시도마다 `agentManager.executeTask`를 새로 호출하여 **완전하게 독립된 신규 Task 레코드**(`task_XXX`)를 생성합니다.
  - 이를 통해 기존 상태기계 변경 없이 단일 칸반 태스크의 무인 루프를 안전하게 구현합니다.
  - 모든 이력은 개별 Task 레코드로 DB에 온전히 보존되어 감사 추적성(Audit Trail)이 향상됩니다.

### 3) 인간 에스컬레이션 처리
- `maxAttempts` 초과 실패 시 `moveTask(task.id, 'review')`를 통해 칸반 상에서 해당 태스크를 검토 열로 강제 이동시킵니다.
- DB `tasks` 테이블 내 최종 실패한 Task 레코드의 `metadata_json`에 다음과 같이 에스컬레이션 메타데이터를 추가 작성합니다.
  ```json
  {
    "escalated_to_human": true,
    "escalation_reason": "Max verifier retries (3) exceeded on verification gate."
  }
  ```
- 에스컬레이션 시점에 `eventBus.publish`를 통해 이벤트(`kanban:task_escalated`)를 발행하여 대시보드나 알림 봇에 전송합니다.

---

## 4. 리스크 및 대응책 (Risks & Mitigation)

1. **컨텍스트 크기 한계 및 토큰 인플레이션 (Prompt Bloat)**
   - *리스크*: 단위 테스트 오류 로그나 빌드 에러가 수만 자에 달할 경우, 프롬프트에 그대로 주입 시 모델 컨텍스트 한계 초과 및 토큰 요금 폭증 발생 가능.
   - *대응*: 실패 피드백 주입 시 `verifierResult.outputSnippet`을 최대 1,500자로 엄격하게 슬라이싱하고, 오류 패턴이 명확한 부분(예: AssertionError, compile error 라인) 위주로 후방에서부터 추출하는 가공 로직 적용.

2. **비정상 오류 발생 시 무한 루프 고착**
   - *리스크*: 에이전트 실행 도중 샌드박스가 정지하거나 일시적인 네트워크 차단으로 검증 결과 파싱이 연속적으로 실패하여 루프가 중단되지 않는 상황 발생 가능.
   - *대응*: 루프 전체를 감싸는 안전 `try-catch` 블록을 구성하고, 실행 실패 예외 발생 시에도 반드시 `attempt` 카운터를 증가시킵니다. 어떤 예외 상황에서도 지정된 최대 횟수 내에 에스컬레이션으로 안전하게 빠져나가도록 설계합니다.

3. **병렬 태스크 실행 시 피드백 오염**
   - *리스크*: 칸반 엔진이 여러 태스크를 병렬(`execution_type = 'parallel'`)로 처리할 때, 서로 다른 에이전트의 실패 피드백이 섞여 엉뚱한 수정 지시가 주입될 수 있음.
   - *대응*: 재시도 상태값(카운트, 프롬프트 문자열)을 클래스 멤버 변수나 공유 컨텍스트가 아닌, 개별 `executeKanbanTask` 프레임의 로컬 변수로 철저히 캡슐화하여 완벽한 스레드 안전성(Thread-safety)을 보장합니다.
