# Team 01 Source Discovery 개선 패치 검증 영수증

- 대상: `team_tech-port-01-source-discovery`
- 개선 사이클: 2/3
- 지시 시점 점수: `85.3`, 완료율: `85.7%`, 표본: 최근 48시간 terminal 14건
- 변경 전 Git 기준선: `e0a786f5`
- 변경 범위: task intake의 team 01 전용 응답·증거 계약과 단위 테스트
- 비변경 범위: 팀 활성 상태, 조직 구성, HR 라이프사이클, 전역 채점 규칙

## 실제 task 근거

수집 시점에 `localhost:6200`은 연결 거부 상태였다. 수치를 추정하지 않고 API의 원천
저장소인 `db/nco.db`의 `tasks`, `agent_actions`, `team_lifecycle_events`를 읽기 전용으로
조회했다.

```sql
WHERE team_id='team_tech-port-01-source-discovery'
  AND created_at >= datetime('now','-48 hours')
  AND status IN ('completed','failed')
```

`team_lifecycle_events`의 `tle_6KDnBODHJQjHaPbh`는 score `85.3`,
`metadata_json={"sample":"48h","n":14,"completion":85.7,...}`를 기록한다.
동일 표본의 task 행은 완료 12건, 실패 2건으로 `12 / 14 = 85.7%`다.

| 에이전트 | 완료 | 실패 | 완료 중 품질 반려 | T1 task_id |
|---|---:|---:|---:|---|
| nvidia | 11 | 0 | 6 | `task_NKawqqiFpXLljVLL`, `task_0234WuBNjiGFESV4`, `task_Jq0FLMM0vk5GUwK2`, `task_9uDxncTJy9zqEXTw`, `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`, `task_Fb04BOuy_oyxT5i5`, `task_5nxk46BW555YCZOF`, `task_clcf6LKHo7dSTMS_`, `task_02dHVv7xgJHs-FS5`, `task_j7eaD8UBVMf3jPtQ` |
| agy | 1 | 0 | 0 | `task_DTAdlujVk6vhxlZI` |
| ollama | 0 | 2 | 0 | `task_zrtJeLH7fGDdUfiP`, `task_whudc2vYe2g_1YHf` |

취소된 `task_QNfQhafszE2fdNhu`는 terminal score 표본에서 제외했다.

### 관찰된 패턴

1. 완료 12건 중 6건의 task row가
   `qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`다. 6건 모두
   build verifier는 exit 0이었지만 응답 첫 줄이 허용 protocol 접두사로 시작하지
   않았다.
   - `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`: 현재 소스 발굴 결과 대신
     `createFile`/`searchFiles` 도구 설명을 반환했다.
   - `task_Fb04BOuy_oyxT5i5`: `<thinking>`으로 시작했다.
   - `task_clcf6LKHo7dSTMS_`, `task_02dHVv7xgJHs-FS5`,
     `task_j7eaD8UBVMf3jPtQ`: 자유형 Markdown으로 시작했다.
2. 해당 task의 저장된 prompt에는 결과가 `done:` 또는 `status:`로 시작해야 한다는
   계약이 없다. 반면 verifier가 있는 경로의 품질 검사는 이 접두사를 요구한다.
3. 품질 반려가 없는 행도 곧바로 성공 증거는 아니다. 예를 들어
   `task_NKawqqiFpXLljVLL`과 `task_0234WuBNjiGFESV4`는 verifier가 없었고 실제
   source dossier 대신 무관한 파일 도구 설명을 반환했다. 14건 모두
   `evidence_json`은 `NULL`이다.
4. 완료율 손실 2건은 별도 원인이다.
   - `task_zrtJeLH7fGDdUfiP`: API 입력 prompt가 `title`, `direction`,
     `targetValue`, `unit`, `reflection`, `improvement`에 실제 값을 주지 않아
     `unknown: failure pattern in output`으로 실패했다.
   - `task_whudc2vYe2g_1YHf`: `orphaned: server restart (poison — requeued 2x)`다.

따라서 이번 패치의 직접 대상은 반복 품질 반려와 무관 산출물이며, 과거 완료율
`85.7%`나 점수 `85.3`을 소급 개선했다고 주장하지 않는다.

## 변경

- `src/server/task-intake.ts`
  - `metadata.teamId`가 team 01일 때만 응답 계약을 prompt에 추가한다.
  - 완료 시 첫 줄 `done:`, 자료 부족·미완료 시 `status:`와 `[미검증]`을 요구한다.
  - 공식 URL, 버전/commit SHA, 검증일, 라이선스·보안 상태, 대안을 요구한다.
  - 도구 함수 설명·지시문 반복을 산출물로 대신하지 못하게 하고 미확인 수치 생성을
    금지한다.
  - marker로 retry/intake 재진입 시 계약을 중복 추가하지 않는다.
- `src/server/task-intake.test.ts`
  - team 01 계약 추가, idempotency, 다른 팀 무변경을 검증한다.
- `docs/self-improve/tech-port-01-source-discovery-fix-2026-07-24.md`
  - task 근거, 변경·검증 로그, Gap과 롤백을 기록한다.

전 팀의 verifier나 quality gate를 끄지 않았고, 팀을 삭제·비활성화하지 않았다.

롤백: 패치가 커밋된 뒤 `git revert <team-01-patch-commit-sha>` 한 번으로 되돌린다.

## 검증 로그

### 관련 Vitest

명령:

```text
npx vitest run src/server/task-intake.test.ts tests/response-quality.test.ts
```

실측 출력:

```text
Test Files  2 passed (2)
Tests  22 passed (22)
Duration  1.14s
exit code 0
```

### 타입체크

명령:

```text
npx tsc --noEmit
```

실측 출력:

```text
stdout/stderr 없음
exit code 0
```

### 빌드

명령:

```text
npm run build
```

실측 출력:

```text
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

### 전체 Vitest

명령:

```text
npm run test:run
```

실측 출력:

```text
Test Files  3 failed | 94 passed (97)
Tests  7 failed | 454 passed (461)
exit code 1
```

실패는 이번 두 소스 파일 밖의 항목이다.

- `tests/근거.test.ts`: 기대 날짜 `2026-07-14`, 실제 포인터 `2026-07-24`
- `tests/security-policy-v1.1.test.ts`: 공유 DB lock/비상정지 상태 관련 3건
- `src/__tests__/dispute_system.test.ts`: 테스트 wallet/citizen fixture 상태 관련 3건

따라서 관련 테스트·타입체크·빌드는 통과했지만 전체 Vitest PASS는 주장하지 않는다.

### diff 검사

명령:

```text
git diff --check -- src/server/task-intake.ts src/server/task-intake.test.ts
```

실측 출력:

```text
stdout/stderr 없음
exit code 0
```

## 판정

- 등급: T1 — SQLite task/event 행, 변경 파일 내용, 관련 Vitest·타입체크·빌드 본문 확인.
- Gap:
  - NCO API가 꺼져 있어 수정된 prompt로 team 01 운영 task를 재실행하지 못했다.
  - 모델이 새 계약을 실제로 준수하는지는 비결정적이며 운영 표본으로 재측정해야 한다.
  - 과거 실패 2건의 API 필수 값 부재와 서버 재시작은 이번 패치 대상이 아니다.
  - 전체 Vitest는 위의 범위 밖 7건 때문에 exit 1이다.
  - 변경 후 48시간 score·completion은 관찰 기간이 지나지 않아 자료 없음이다.
- 미검증항목: 운영 NCO 재기동 후 team 01 실제 task 1회, 후속
  `qualityRejected`/`evidence_json`, 차기 48시간 HR score.
