# team_tech-port-02-safety-license — 개선 사이클 5/3 근본원인 분석 (2026-07-30)

HR DIRECTIVE 입력값: score=83, completion=85.7%, sample=48h/7.

## 1. 실측 표본 (T1, db/nco.db, `created_at >= now-48h`, team_id='team_tech-port-02-safety-license')

| task | agent | status | created | response |
|---|---|---|---|---|
| task_pKJuB7VLeRfSqveq | hermes | completed | 05:03:41 | 1090B |
| task_ATkeua4HRwS_T-tQ | hermes | **timed_out** | 04:28:14 | 65536B (partial) |
| task_UMPsLV228fn3BcP3 | codex | completed | 00:03:00 | 1321B |
| task_9ij6QvWERWZe0pLn | codex | completed | 19:11:30 | 1586B |
| task_Gd4eaqktxwrXpHqR | codex | completed | 05:02:57 | 1143B |
| task_vl9dhTBRwCangcx5 | hermes | completed | 00:47:24 | 951B |
| task_tv_jA924kaAJNOPf | codex | completed | 15:31:38 | 1453B |

7건 중 완료 6건 → completion 6/7 = 85.7%. **HR 지시문 수치는 stale이 아니라 실측과 일치**한다.
품질반려(quality_rejected)·검증기관 반려는 0건이다. 즉 점수 하락 원인은 팀 산출물 품질이 아니라
**단 1건의 실행 실패**로 전부 환원된다.

## 2. 근본원인 — 시도이력(attemptedAgents) 역행에 의한 실패 프로바이더 재선택

task_ATkeua4HRwS_T-tQ metadata_json 실측:

- `requestedProvider: "cursor-agent"`, `workflowStage: "verification"`
- `escalationHistory[0].attemptedAgents = ["cursor-agent","codex","claude-code"]`
  (`reason: "queue_wait_timeout: provider codex busy for 1800000ms"`, 06:11:39 UTC 기준)
- 그런데 최종 top-level `attemptedAgents = ["codex","hermes"]` → **3→2로 축소(역행)**

시도이력이 축소되면 이미 실패한 프로바이더가 다시 후보가 된다. 결과적으로 이 태스크는
04:28:14 생성 → 07:23:59 종료까지 **2시간 55분**을 소진하고 `timeout(idle)`로 끝났으며,
`result_json`·`evidence_json` 모두 NULL — 감사 산출물 0건이다. 저장된 65536B는 abort 시점의
partial output(`PARTIAL_OUTPUT_LIMIT = 64*1024`, src/core/task-queue.ts:61)이지 결과물이 아니다.

원인 지점 2곳:
- (a) `persistTaskReassignment`이 `...metadataPatch`로 persisted 목록을 통째로 덮어씀
- (b) `enqueueWithRetries`가 DB가 아닌 BullMQ job data 스냅샷(`task.metadata`)에서 시딩

## 3. 조치 — 이미 구현됨 (재구현 금지)

src/core/task-queue.ts (working tree, **미커밋**):

- `mergeAttemptedAgents(persisted, incoming)` — 합집합, 순서 보존, 어느 쪽도 축소하지 않음 (L315)
- `persistTaskReassignment`이 DB persisted 목록과 union (L344-349)
- `enqueueWithRetries`가 `loadTaskMetadata(task.taskId).attemptedAgents`로 재시딩 (L1316-1317)
- 롤백: `NCO_ATTEMPT_HISTORY_MONOTONIC=0` → 정확히 이전(덮어쓰기) 동작. 재빌드 불필요.

검증(T1): `npx vitest run src/core/task-queue.attempt-history.test.ts` → **9 passed / 9**,
`npx tsc --noEmit` → **exit 0**. dist/core/task-queue.js 에 `mergeAttemptedAgents` 3회 포함
(빌드 08:26:14 UTC, src 최종수정 07:37:42 UTC → dist 최신).

## 4. 스코어러는 변경하지 않는다 (의도적 결정)

이 실패를 completion 분모에서 제외하면 85.7%→100%가 되지만, **하지 않는다**.
src/core/team-scorer.ts의 모든 인프라 제외 조항(`JOB_WAIT_DEAD_AGENT_EXCLUSION`,
`SPAWN_FAILURE_EXCLUSION`, lease_expired 무-heartbeat 절)은 공통 불변식으로
`COALESCE(k.response,'')='' AND COALESCE(k.result_json,'')=''` (산출물 0바이트)을 요구한다.
task_ATkeua4HRwS_T-tQ는 heartbeat_seq=26, response 65536B로 **에이전트가 실제로 실행되다 시간초과**된
케이스이므로 기존 설계상 정상 계상 대상이다. 여기서 제외 조건을 넓히는 것은 지표 조작이다.

따라서 **이번 사이클의 점수 개선폭은 0이 정상**이다. 재발 방지는 §3 수정이 담당하고,
completion 수치는 48h 창이 2026-07-30 04:28 을 지나면 자연 회복된다.

## 5. 잔여 갭 (미해결, 승인 필요)

라이브 nco-backend는 **08:23:51 UTC 기동**, dist 빌드는 **08:26:14 UTC** →
러닝 프로세스에 이 수정이 적재되어 있지 않다. 적용하려면 `pm2 restart nco-backend`가 필요하지만
현재 in-flight 22건(running 6 / queued 16)이 있어 재기동은 고아 태스크를 만든다.
**운영자 승인 후 유휴 구간에 재기동**할 것. 커밋 역시 미실행 상태다.

## 6. 성공 기준 (다음 사이클 검증용)

1. 재기동 이후 생성된 태스크 중 `escalationHistory[*].attemptedAgents ⊄ metadata.attemptedAgents`
   인 행이 0건 (SQL 검증 가능)
2. team_tech-port-02-safety-license 48h completion ≥ 95% (창이 04:28을 지난 뒤 측정)
3. `timeout(idle)` + response=65536B(=partial cap 도달) 조합의 team-02 태스크 0건
4. `npx vitest run src/core/task-queue.attempt-history.test.ts` 9/9 유지, `tsc --noEmit` 0

## 7. 미검증 항목

- 재기동 후 실환경 재발 여부 (프로세스 미적재 상태라 라이브 검증 불가)
- score 절대값 83 → ? (volume 정규화 의존, 표본 n=7 고정이라 예측 불가 — 수치 예측 금지)
