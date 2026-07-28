---
created_at: 2026-07-29T00:39:50+09:00
verified_at: 2026-07-29T02:43:46+09:00
team_id: team_content-quality
team_slug: content-quality
cycle: 4
evidence_tier: T1
artifact_type: verification-receipt
---

# 고품질 검수팀 Cycle 4 — protocol normalization 검증 영수증

## 판정

운영 DB의 HR 스냅샷은 `score=83.8`, `completion=87.5`, `n=8`,
`sample=48h`다. 완료율을 낮춘 단일 실패 행은
`task_JjX-85_K_1H7WuEC`이며, build verifier가 통과했는데도 JSON string으로
직렬화된 응답 `"done: workflow implementation gate passed"`가
`quality_rejected: FORMAT_MISMATCH`로 반려됐다. 동일 workflow의 평문 재시도
`task_VZ3TWJjdlYpZ73Ab`는 완료됐다.

기존 commit `7305bd37fc0b34b66c3ac1161a3d1d15fbe8dbcb`은 품질 게이트에만
JSON-string 해제를 추가했고 `main`과 현재 브랜치에 모두 포함돼 있다. 현행 코드
대조에서 협업 protocol 파서는 여전히 원문을 직접 split해 같은 provider wrapper를
protocol로 인식하지 못하는 불일치를 확인했다. 이 상태에서는 quoted `status:` 또는
`error:`가 최종 단계에서 완료 산출물처럼 취급될 수 있었다.

이번 패치는 JSON string 하나일 때만 해제하는 규칙을 협업 protocol 모듈의 공용
함수로 옮기고 품질 게이트와 protocol parser가 함께 사용하도록 했다. malformed
JSON과 구조화 JSON의 기존 처리는 바꾸지 않았다. 과거 task 상태나 HR metric은
수정하지 않았으므로 현재 측정값이 향상됐다고 주장하지 않는다.

## 변경 파일과 핵심 diff

- `src/core/collaboration.ts`
  - `normalizeCollaborationProtocolResponse()` 추가
  - 유효한 JSON string 하나만 해제하고 protocol parser에서 공용 사용
- `src/verification/response-quality.ts`
  - 로컬 중복 decoder를 제거하고 공용 normalization 사용
- `src/core/collaboration.test.ts`
  - quoted multiline `done:` parsing과 malformed JSON 거부 회귀 추가
- `src/core/company-orchestrator.test.ts`
  - quoted `done:`은 승인하고 quoted `status:`는 완료로 승인하지 않는 통합 회귀 추가
- `obsidian_vault/improvement_notes/team-content-quality-cycle4-verification-receipt-20260729.md`
  - 현재 단계 T1 검증 영수증

팀 삭제·비활성화, `protected`, retirement, HR lifecycle status, DB task/score 행은
변경하지 않았다.

## Tier 1 근거

### 운영 DB

명령:

```bash
sqlite3 -readonly -json db/nco.db "
SELECT id,status,error,response,
       json_extract(verifier_result_json,'$.passed') AS verifier_passed,
       json_extract(metadata_json,'$.workflowRunId') AS workflow_run_id,
       team_id,spawned_by_cli,created_at
FROM tasks
WHERE id IN ('task_JjX-85_K_1H7WuEC','task_VZ3TWJjdlYpZ73Ab')
ORDER BY datetime(created_at);
SELECT id,event_type,score,
       json_extract(metadata_json,'$.completion') AS completion,
       json_extract(metadata_json,'$.n') AS n,
       json_extract(metadata_json,'$.maxN') AS maxN,
       json_extract(metadata_json,'$.sample') AS sample,
       created_at
FROM team_lifecycle_events
WHERE id='tle_J-rXGkS3YNuxiu-1';"
```

원문 결과:

```json
[{"id":"task_JjX-85_K_1H7WuEC","status":"failed","error":"quality_rejected: FORMAT_MISMATCH","response":"\"done: workflow implementation gate passed\"","verifier_passed":1,"workflow_run_id":"wfr_MBseWr_vOB55BRRZ","team_id":"team_content-quality","spawned_by_cli":null,"created_at":"2026-07-28 12:32:01"},
{"id":"task_VZ3TWJjdlYpZ73Ab","status":"completed","error":null,"response":"done: workflow implementation gate passed","verifier_passed":1,"workflow_run_id":"wfr_MBseWr_vOB55BRRZ","team_id":"team_content-quality","spawned_by_cli":null,"created_at":"2026-07-28 12:35:10"}]
[{"id":"tle_J-rXGkS3YNuxiu-1","event_type":"score_checked","score":83.79999999999999716,"completion":87.5,"n":8,"maxN":60,"sample":"48h","created_at":"2026-07-28 15:20:00"}]
```

빌드 산출물로 재계산:

```bash
node --input-type=module -e \
  "import { computeTeamScores } from './dist/core/team-scorer.js';
   const row=computeTeamScores().find((item)=>item.teamId==='team_content-quality');
   console.log(JSON.stringify(row));"
```

```json
{"teamId":"team_content-quality","slug":"content-quality","name":"고품질 검수팀","organizationId":"org_sns-blog","score":83.8,"grade":"B","completion":87.5,"n":8,"maxN":60,"sample":"48h"}
```

안전 불변식 직접 조회:

```json
[{"id":"team_content-quality","is_active":1,"charter_prefix":"@전담러너 [고품질 검수 게이트 — Google Search Quality 기준] nova-money-hub 블로그 콘텐츠를 게시 전 실검증한다"}]
[{"id":"team_content-quality","is_active":1,"protected":1,"charter_prefix":"@전담러너 [고품질 검수 게이트 — Google Search Quality 기준] nova-money-hub 블로그 콘텐츠를 게시 전 실검증한다"}]
```

### 관련 unit/integration 회귀

직전 `runTest` 오류는 필터로 전달된 `결과:`와 일치하는 test file이 없어 발생했다.
정확한 파일 경로로 다시 실행했다.

```bash
./node_modules/.bin/vitest run \
  tests/response-quality.test.ts \
  src/core/collaboration.test.ts \
  src/core/company-orchestrator.test.ts \
  src/storage/content-quality-dedicated-runner-migration.test.ts
```

원문 결과:

```text
Test Files  4 passed (4)
Tests  96 passed (96)
Duration  2.19s
```

### TypeScript 타입체크·빌드

```text
./node_modules/.bin/tsc --noEmit
exit 0

./node_modules/.bin/tsc
exit 0
```

빌드 산출물의 protocol 판정:

```bash
node --input-type=module -e "
import { isCompanyStageOutputAcceptable } from './dist/core/company-orchestrator.js';
const opts={isLastStage:true,requireProtocolPrefix:true};
console.log(JSON.stringify({
  quotedDone:isCompanyStageOutputAcceptable(
    JSON.stringify('done: workflow implementation gate passed'),opts),
  quotedStatus:isCompanyStageOutputAcceptable(
    JSON.stringify('status: blocked by missing evidence'),opts),
  malformed:isCompanyStageOutputAcceptable(
    '"done: truncated',opts)
}));"
```

원문 결과:

```json
{"quotedDone":true,"quotedStatus":false,"malformed":false}
```

### package script와 delivery gate

`npm run typecheck`, `npm run test`, `npm run build`은 TypeScript 또는 Vitest
실행 전에 sandbox에서 `tsx` CLI IPC socket 생성이 거부돼 각각 exit 1이었다.

```text
Error: listen EPERM: operation not permitted .../tsx-501/61931.pipe
Error: listen EPERM: operation not permitted .../tsx-501/61957.pipe
Error: listen EPERM: operation not permitted .../tsx-501/61990.pipe
```

표준 gate:

```bash
/Users/nova-ai/.codex/plugins/cache/nova-use/nco-shared-toolkit/0.1.3/skills/nco-delivery-gate/scripts/run-delivery-gate.sh --full
```

원문 요약:

```text
[gate] FAIL project/worktree inspection
[gate] FAIL npm run typecheck
[gate] FAIL npm run test
[gate] FAIL npm run build
[Gap] PASS=0 FAIL=4 SKIP=0
```

inspection은 현재 브랜치가 `main`보다 `ahead-not-integrated`이고 dirty worktree라
실패했다. package 3단계는 모두 동일한 `tsx ... listen EPERM`이며, 직접 vitest와
직접 TypeScript compiler 결과를 별도로 기록했다.

NCO 통합 상태:

```text
curl: (7) Failed to connect to localhost port 6200 after 0 ms: Couldn't connect to server
```

SECOND-BRAIN의 구현 위임 규칙에 따라 read-only conductor 교차검토도 요청했지만
연결된 NCO MCP가 실행을 수락하지 않았다.

```text
{"content":[{"type":"text","text":"user cancelled MCP tool call"}],"isError":true}
```

### 커밋 시도

저장소 내장 `AgentToolExecutor`의 `gitCommit`은 `git add -A` 후 commit을 실행한다.
현재 worktree의 요청 범위 밖 dirty 파일까지 포함하므로 그대로 호출하지 않았다.
대신 현재 단계 5개 파일만 명시해 stage를 시도했으나 Git metadata 쓰기 권한에서
차단됐다.

```bash
git add -- \
  src/core/collaboration.ts \
  src/verification/response-quality.ts \
  src/core/collaboration.test.ts \
  src/core/company-orchestrator.test.ts \
  obsidian_vault/improvement_notes/team-content-quality-cycle4-verification-receipt-20260729.md
```

원문 결과:

```text
fatal: Unable to create '/Users/nova-ai/project/nco/.git/index.lock': Operation not permitted
```

커밋은 생성되지 않았으며 commit hash는 `unknown`이다.

## 되돌리기 절차

이 변경이 커밋된 뒤에는 해당 커밋을 `git revert <commit>`으로 역적용한다. 수동
되돌리기가 필요하면 아래 현재 단계 5개 파일의 diff만 역적용한다.

- `src/core/collaboration.ts`
- `src/verification/response-quality.ts`
- `src/core/collaboration.test.ts`
- `src/core/company-orchestrator.test.ts`
- 이 검증 영수증

DB task, score snapshot, 팀 활성·보호·lifecycle 필드는 롤백 대상이 아니다.

## 검증 등급과 Gap

- `[Evidence Tier 1]` 운영 DB 행, 현행 파일·Git diff, 테스트/컴파일/실행 명령 출력을
  현재 단계에서 직접 확인했다.
- 관련 회귀: 96/96 통과.
- 직접 TypeScript typecheck와 build: 2/2 exit 0.
- package wrapper: 0/3, `tsx listen EPERM`.
- delivery gate: `PASS=0 FAIL=4 SKIP=0`.

## 미검증·남은 항목

- NCO HTTP `:6200` health/agents 본문과 NCO conductor 교차검토
- 실제 provider→gateway quoted protocol E2E
- 전체 130개 test file 회귀(이번에는 관련 4개 파일만 실행)
- 현재 브랜치의 `main` 통합
- 다음 rolling 48시간 창의 completion/score 향상
- Git metadata 쓰기 권한을 가진 환경에서 대상 5개 파일만 요청 메시지로 커밋
