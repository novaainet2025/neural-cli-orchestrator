# Verifier Gate v0
## 1. Intake: `POST /api/tasks`
- Zod 위치: `src/utils/validation.ts`의 `CreateTaskInput`.
- 추가 필드:
```ts
verifier: z.object({
  type: z.literal('run'),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
}).optional()
```
- `src/server/gateway.ts`의 `/api/task`가 `CreateTaskInput.parse()` 후 DB insert payload를 만들므로, 여기서 `verifier`를 `tasks.verifier_json`에 `JSON.stringify(input.verifier)`로 저장하고 `taskQueue.enqueue(...)`에도 전달한다. `/api/tasks`는 `/api/task` alias라 추가 분기 불필요.
- `QueuedTask` 확장:
```ts
verifier?: { type: 'run'; command: string; timeoutMs?: number };
```
- Migration `064_verifier_gate.sql` 전문:
```sql
ALTER TABLE tasks ADD COLUMN verifier_json TEXT;
ALTER TABLE tasks ADD COLUMN verifier_result_json TEXT;
```

## 2. Gate: `src/core/task-queue.ts`
- 삽입점: `runJob()`의 `const classified = classifyResult(result);` 직후 1곳, `enqueueSemaphore()`의 동일 라인 직후 1곳. 둘 다 completed 확정 전 마지막 공통 관문이다.
- 의사코드:
```ts
let gated = classifyResult(result);
if (gated.success && task.verifier?.type === 'run') {
  const startedAt = new Date().toISOString();
  try {
    const timeoutMs = task.verifier.timeoutMs ?? 60_000;
    const child = spawn(process.platform === 'win32' ? 'cmd' : 'bash',
      process.platform === 'win32' ? ['/d', '/s', '/c', task.verifier.command] : ['-lc', task.verifier.command],
      { cwd: env.PROJECT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal });
    const { code, stdout, stderr, timedOut } = await waitForExitWithTimeout(child, timeoutMs);
    const merged = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.slice(0, 2000);
    const passed = code === 0 && !timedOut;
    gated = passed ? gated : {
      ...gated,
      success: false,
      error: [gated.error, `verifier failed: ${merged}`].filter(Boolean).join('\n\n'),
    };
    verifierResult = { type: 'run', command: task.verifier.command, timeoutMs, startedAt, exitCode: code, timedOut, passed, outputSnippet: merged };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 2000);
    gated = { ...gated, success: false, error: [gated.error, `verifier failed: ${msg}`].filter(Boolean).join('\n\n') };
    verifierResult = { type: 'run', command: task.verifier.command, passed: false, spawnError: msg };
  }
}
```
- 판정 규칙: `exitCode === 0`만 PASS. 비0, spawn error, timeout은 모두 FAIL-CLOSED로 `success:false`로 뒤집는다.
- 샌드박스 판단: 기존 `SandboxManager`는 에이전트별 command/path gate이며 `agentManager.executeTask()` 내부에서만 연결된다. verifier는 서버 프로세스 후처리이므로 그 경로를 직접 재사용하지 않고 `child_process`로 실행하되 `cwd=env.PROJECT_DIR`, `timeout`, `AbortController`, 출력 2000자 절단으로 범위를 제한한다. v0에서는 "기존 sandbox 정책 경유 안 함"이 맞다.

## 3. Persist: `tasks.verifier_result_json` 선택
- 선택: 별도 테이블 대신 `tasks.verifier_result_json TEXT`.
- 근거:
  1. v0는 task당 verifier 1개, 판정도 1회라 1:1 컬럼이 충분하다.
  2. `/api/tasks/:id/retry`가 이미 `tasks` 한 row 또는 `dead_letter_tasks` 한 row만 읽으므로, 직전 verifier FAIL 출력 주입에 join이 필요 없다.
  3. `transitionTask()`와 terminal 상태는 그대로 두고 `response/error` alongside 증거만 추가하면 되어 기존 미선언 task 동작이 불변이다.
- 저장 JSON 예시:
```json
{"type":"run","command":"npm test -- run smoke","timeoutMs":60000,"startedAt":"...","exitCode":1,"timedOut":false,"passed":false,"outputSnippet":"..."}
```

## 4. Retry Prompt Injection: `POST /api/tasks/:id/retry`
- 위치: `src/server/gateway.ts`의 `failedTask` 조회 컬럼 확장 후, `payload` 조립 직전에 verifier 결과를 읽어 prompt 끝에 붙인다. 실제 재시도 생성은 기존 `app.inject({ method:'POST', url:'/api/task', payload })`를 유지한다.
- 조회 추가:
```sql
SELECT assigned_to, prompt, mode, workspace_id, priority, system_prompt, verifier_result_json
FROM tasks
WHERE id=? AND status='failed'
```
- 주입 규칙: `verifier_result_json.passed === false`이고 `outputSnippet`이 있을 때만 아래 블록을 `payload.prompt` 말미에 추가한다.
```text

[Previous verifier failure]
Command: <command>
Exit: <exitCode or "spawn-error/timeout">
Output:
<outputSnippet>
```
- 이유: retry 프롬프트 본문 끝은 원래 작업 지시를 보존하면서도 직전 실패 증거를 가장 직접적으로 모델에 전달하는 위치다. `systemPrompt`에 섞으면 기존 운영 프롬프트와 책임 경계가 흐려진다.
