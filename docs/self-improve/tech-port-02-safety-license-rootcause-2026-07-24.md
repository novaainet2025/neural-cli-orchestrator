---
title: "Team 02 Safety and License 실패 패턴·근본원인"
date: 2026-07-24
team: team_tech-port-02-safety-license
sample: 48h/12
tags:
  - nco/self-learning
  - tech-port-02
  - root-cause
---

# Team 02 Safety and License 실패 패턴·근본원인

> 대상: `team_tech-port-02-safety-license`
> 지시문 스냅샷: score `60.2`, completion `58.3%`, 최근 48시간 12건
> 추출 시각: 2026-07-24 11:32 KST (`2026-07-24 02:32 UTC`)
> T1 원본: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `team_lifecycle_events`
> 안전 경계: 팀 상태·라이프사이클·은퇴 상태와 소스코드는 변경하지 않았다.

## 판정 요약

- `tasks` 원본은 `completed=7`, `failed=5`로 완료율
  `7 / 12 = 58.3%`다.
- score `60.2`, 표본 `n=12`, completion `58.3%`는 lifecycle event
  `tle_yCX2m_MVWHx8f4vt`에 함께 기록돼 있다. 이후 생성된 score check는 이
  지시문 스냅샷과 분리하며, 이 노트의 기준값으로 사용하지 않았다.
- 상태 실패 5건 중 4건은 요청 provider `codex`가 1,800,000ms 대기한 뒤
  `claude-code`로 재할당됐지만 열린 circuit에서 종료된 동일 패턴이다.
- 나머지 상태 실패 1건은 서버 재시작 뒤 orphan 재큐잉 한도 2회를 소진했다.
- 완료 7건 중 2건은 `qualityRejected=true` 및
  `qualityHeuristics=["FORMAT_MISMATCH"]`다. 따라서 원시 완료 상태와 품질
  통과는 같지 않다.
- 12건 모두 `evidence_json`이 `NULL`이다. 완료 7건 중 4건은 verifier 결과가
  없고, 3건의 verifier는 도메인 심사가 아닌 공통 `npm run build`만 확인했다.

## 표본과 에이전트별 패턴

`assigned_to`는 최종 실행 provider 기준이다. 원 요청 provider는
`metadata_json.requestedProvider`로 따로 대조했다.

| 최종 에이전트 | 완료 | 실패 | 완료 중 품질 반려 | 원시 완료율 | T1 task_id |
|---|---:|---:|---:|---:|---|
| `codex` | 3 | 0 | 0 | 100.0% | `task_oKEifL4S7YldmoJA`, `task_AFSNmyp9lc2gJHCO`, `task_8L00qmKQxhiqO41O` |
| `agy` | 1 | 0 | 0 | 100.0% | `task_MYCufZt2vW1EXuJh` |
| `retired-provider` | 3 | 1 | 2 | 75.0% | `task_Mqmm4ZPMeCUp1r45`, `task_JeWCRJMlJnJXZC1r`, `task_NQnttzUV0hM-QQ0R`, `task_ROCbX9F5GvclOGiR` |
| `claude-code` | 0 | 4 | 0 | 0.0% | `task_a2yeB8hkpBXUhPAL`, `task_Zkfq4JCCwMGZd3aj`, `task_tsLca16rRfTKk-iJ`, `task_ujrEzMQMcyKrkzvG` |
| **합계** | **7** | **5** | **2** | **58.3%** | 12건 |

원 요청 기준으로는 `codex` 요청 7건 중 3건이 완료되고 4건이 위 failover
패턴으로 실패했다. `retired-provider` 요청 5건 중 4건이 완료됐으며, 그중 1건
`task_MYCufZt2vW1EXuJh`는 retired-provider timeout 후 `agy`가 완료했다.

## 실패 유형별 빈도표

아래 교차 패턴은 같은 task에 중복될 수 있다. 예를 들어 상태 실패 5건은 모두
빈 산출물이기도 하므로 단순 합산하지 않는다.

| 실패·품질 유형 | 빈도 | 표본 비율 | T1 task_id·원본 필드 |
|---|---:|---:|---|
| `codex` queue wait 1,800,000ms → `claude-code` 재할당 → circuit open 실패 | 4 | 33.3% | `task_a2yeB8hkpBXUhPAL`, `task_Zkfq4JCCwMGZd3aj`, `task_tsLca16rRfTKk-iJ`, `task_ujrEzMQMcyKrkzvG`; `metadata_json.escalationHistory`, `error` |
| 서버 재시작 orphan poison, 재큐잉 2회 소진 | 1 | 8.3% | `task_ROCbX9F5GvclOGiR`; `error="orphaned: server restart (poison — requeued 2x)"`, `orphan_requeue_count=2` |
| `FORMAT_MISMATCH` 품질 반려인데 상태는 `completed` | 2 | 16.7% | `task_JeWCRJMlJnJXZC1r`, `task_NQnttzUV0hM-QQ0R`; `metadata_json.qualityRejected=true` |
| timeout/escalation 기록 | 5 | 41.7% | 위 circuit 4건 + `task_MYCufZt2vW1EXuJh`의 `retired-provider → agy`, reason `The operation was aborted due to timeout` |
| 빈 산출물(`response IS NULL`) | 5 | 41.7% | 상태 실패 5건 전부 |
| 안전·라이선스 구조화 근거 부재(`evidence_json IS NULL`) | 12 | 100.0% | 표본 12건 전부 |
| verifier 결과 부재 | 9 | 75.0% | `verifier_result_json IS NULL`; 결과가 있는 3건도 공통 build 검증만 수행 |

### `FORMAT_MISMATCH` 상세

- `task_JeWCRJMlJnJXZC1r`는 요구한 안전·라이선스 심사 대신
  `searchFiles`/`readFile` 도구 설명만 응답했다.
- `task_NQnttzUV0hM-QQ0R`는 `[thinking]`으로 시작하고 이전 단계 본문과
  반복적인 “다음 단계”를 되풀이했으며, 라이선스를 “확인 필요”로 남긴 채
  요구된 명시적 STOP 형식을 충족하지 않았다.
- 두 parent의 quality retry 자식
  `task_f2I3glhLCweL8o2s`, `task_20av7nDpNzkgVN6-`,
  `task_iqPH5esATgktcv66`은 모두 `team_id=NULL`이다. 이 중
  `task_iqPH5esATgktcv66`은 교정된 `SAFETY_DECISION: STOP` 산출물을
  완료했지만 대상 팀의 48시간 집계에는 연결되지 않는다.

## 상위 3개 근본원인 가설

### 1. 가용성 확인 없는 failover가 완료율 손실을 집중시킨다

- 관측: 상태 실패 5건 중 4건(80.0%)이 동일한
  `queue_wait_timeout → claude-code circuit open` 계보다.
- T1 근거: `task_a2yeB8hkpBXUhPAL`, `task_Zkfq4JCCwMGZd3aj`,
  `task_tsLca16rRfTKk-iJ`, `task_ujrEzMQMcyKrkzvG`의
  `attemptedAgents`, `escalationHistory`, `error`.
- 해석: 30분을 이미 소진한 task가 열린 회로로 다시 배정돼 회복 기회를 잃는다.
  failover 직전 후보 circuit 가용성 재검사가 우선 개선 지점이다.

### 2. 품질 재시도 계보가 팀 귀속을 잃어 교정 성과가 점수에 환류되지 않는다

- 관측: `FORMAT_MISMATCH` parent 2건은 `completed` 상태로 남았고, 그 뒤 생성된
  retry 자식 3건은 모두 `team_id=NULL`이다.
- T1 근거: parent `task_JeWCRJMlJnJXZC1r`,
  `task_NQnttzUV0hM-QQ0R`; child `task_f2I3glhLCweL8o2s`,
  `task_20av7nDpNzkgVN6-`, `task_iqPH5esATgktcv66`.
- 해석: 품질 반려가 원시 완료로 남는 동시에 성공한 교정 결과는 팀 표본에서 빠진다.
  parent의 `team_id`·회사 run 메타데이터를 quality retry에 승계하는 것이
  점수 피드백의 최소 수정 후보이다.

### 3. 안전·라이선스 도메인 증거 계약이 completion gate에 연결되지 않았다

- 관측: 표본 12건 모두 `evidence_json=NULL`이고, 완료 7건 중 4건은 verifier가
  없다. 나머지 3건은 `npm run build`만 통과해 라이선스·SBOM·CVE·권한 판정의
  출처를 검증하지 않는다.
- T1 근거: 12개 task의 `evidence_json`, `verifier_result_json`;
  특히 무관한 git 상태 설명으로 끝난 `task_Mqmm4ZPMeCUp1r45`와 도구 설명만
  반환한 `task_JeWCRJMlJnJXZC1r`.
- 해석: 파일/URL/commit/SBOM 등 최소 도메인 증거가 없어도 executor 종료가
  완료로 기록될 수 있다. 안전 심사 task에만 opt-in하는 evidence schema와
  `SAFETY_DECISION: GO|STOP` 출력 gate가 필요하다.

## 경계가 명확한 후속 개선 후보

1. failover enqueue 직전에 대상 provider의 circuit 가용성을 재검사하고 열린
   후보는 건너뛴다.
2. quality retry payload에 parent `team_id`, `companyRunId`,
   `organizationId`를 승계한다.
3. team 02 task에 한해 source URL/commit, license identifier, SBOM 또는
   `[미검증]`, 위험·완화·잔여위험, 최종 `SAFETY_DECISION`을 요구하는
   출력/evidence gate를 적용한다.

이 항목들은 이번 자가학습 산출물의 제안이며 **미구현·미검증**이다. 팀 삭제,
비활성화 또는 라이프사이클 변경은 제안하지 않는다.

## Mem0 연동 요약

- agent: `self-learning`
- user: `team_tech-port-02-safety-license`
- key: `tech-port-02 실패패턴`
- summary: `48h/12에서 completed 7·failed 5. 실패 5건 중 4건은 codex 30분
  대기 후 열린 claude-code circuit로 failover, 1건은 restart poison.
  completed 중 FORMAT_MISMATCH 2건이며 quality retry 3건은 team_id가 없다.
  전체 12건 evidence_json이 NULL.`
- Mem0 row id: `mem0-1784860562616-8uw8ar` (`embedded=false`,
  `NCO_MEM0_NO_EMBED=1` 로컬 BM25 모드)

## T1 재현 쿼리

```sql
SELECT id, assigned_to, status, response, error, parent_task_id,
       orphan_requeue_count, evidence_json, verifier_result_json,
       json_extract(metadata_json,'$.requestedProvider') AS requested_provider,
       json_extract(metadata_json,'$.qualityRejected') AS quality_rejected,
       json_extract(metadata_json,'$.qualityHeuristics') AS quality_heuristics,
       json_extract(metadata_json,'$.escalationHistory') AS escalation_history
FROM tasks
WHERE team_id='team_tech-port-02-safety-license'
  AND created_at >= datetime('now','-48 hours')
ORDER BY created_at;
```

```sql
SELECT id, parent_task_id, team_id, assigned_to, status, error
FROM tasks
WHERE parent_task_id IN (
  'task_JeWCRJMlJnJXZC1r',
  'task_NQnttzUV0hM-QQ0R'
)
ORDER BY created_at;
```

## 검증 영수증

- [변경] `docs/self-improve/tech-port-02-safety-license-rootcause-2026-07-24.md`
  — 실제 task/lifecycle 원본 기반 개선 노트.
- [검증방법] DB 집계·Mem0 row 재조회·`npx tsc --noEmit`·`npm run build`.
- [등급] T1 — SQLite 원본 행, 파일 내용, 실제 명령 본문과 exit code.
- [Gap] 런타임 `localhost:6200`은 추출 시점에 연결할 수 없어
  `nco_list_tasks`/`nco_get_task` HTTP 래퍼 대신 두 API의 원천 저장소인
  `db/nco.db`를 읽기 전용 조회했다.
- [미검증항목] score 산식 독립 재계산, 후속 개선안 구현 효과, 변경 후 48시간
  completion/score, 품질 retry의 실제 팀 점수 반영.

### 검증 로그

```text
$ npx tsc --noEmit
(stdout/stderr 없음)
exit code 0
```

```text
inline Node/better-sqlite3 48h task/lifecycle assertion (위 재현 쿼리)
sample=12, completed=7, failed=5
formatMismatch=2, circuitOpen=4, poisonRestart=1
evidenceNull=12, verifierResultNull=9
retryChildren=3, retryChildrenTeamIdNull=3
lifecycle=score 60.2, n 12, completion 58.3
ASSERTION_PASS
exit code 0
```

```text
$ npm run build
> neural-cli-orchestrator@1.0.0 build
> tsc
exit code 0
```

```text
$ SELECT id, agent_id, user_id, content, metadata, embedding IS NOT NULL
  FROM mem0_memories
  WHERE id='mem0-1784860562616-8uw8ar';
id=mem0-1784860562616-8uw8ar
agent_id=self-learning
user_id=team_tech-port-02-safety-license
metadata.key=tech-port-02 실패패턴
embedded=0
```

```text
$ mem0Search({
    agentId: "self-learning",
    userId: "team_tech-port-02-safety-license",
    query: "실패패턴"
  })
mode=bm25
ids=["mem0-1784860562616-8uw8ar"]
count=1
```
