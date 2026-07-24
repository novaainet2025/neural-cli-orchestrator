# 기술 포팅 06 개선 방향 토론팀 실패 패턴 분석

---
작성일: 2026-07-24
대상 팀: team_tech-port-06-improvement-debate
조직 경로: nova-ax/technology-porting/tech-port-06-improvement-debate
분석 구간: 2026-07-22 02:14:14 ~ 2026-07-24 02:14:14 협정 세계시
표본: 취소 상태를 제외한 최근 48시간 작업 12건
개선 주기: 2/3
---

## 결론

완료율 저하의 직접 원인은 `opencode`에 배정된 작업 5건 가운데 3건이 `lease_expired`, 1건이 서버 재시작 뒤 고아 작업으로 실패하면서 네 작업 모두 응답을 남기지 못한 것이다. 품질 점수 정체의 별도 원인 후보는 완료 상태 7건 중 3건에 `qualityRejected=true`와 `FORMAT_MISMATCH`가 함께 기록됐는데도 완료 상태가 유지된 점이다. 이 세 작업은 모두 `npm run build` 검증을 통과했으므로, 빌드 검증이 문서·응답 형식 계약을 검증하지 못한다.

이 노트는 원인 범위를 좁히는 자가학습 산출물이다. 팀 삭제·비활성화·수명주기 상태 변경은 수행하지 않았고, 운영 코드도 수정하지 않았다.

## 데이터 가용성과 표본 재현

| 항목 | 실측값 | 근거 |
|---|---:|---|
| 지시문에 제공된 점수 | 60.2 | 인사 지시문 스냅샷이며 이 분석에서 재산정하지 않음 |
| 최근 48시간 팀 작업 | 13건 | `tasks.team_id`와 `created_at` 기준 |
| 취소 작업 | 1건 | `task_PD3srSFLsaJQejFT` |
| 평가 표본 | 12건 | 취소 작업 1건 제외 |
| 완료 | 7건 | `status='completed'` |
| 실패성 | 5건 | `failed` 2건과 `lease_expired` 3건 |
| 완료율 | 58.3% | 7 ÷ 12를 소수 첫째 자리로 반올림 |

`nco_list_tasks`와 `nco_get_task`가 사용하는 로컬 NCO API는 수집 시점에 `localhost:6200` 연결이 거부됐다. 지표를 추정하지 않고 두 도구의 원천 저장소인 [`db/nco.db`](../../db/nco.db)의 `tasks` 행을 읽기 전용으로 조회했다. API 도구 호출 성공 여부는 **[미검증]**이며, 아래 빈도와 태스크 상세는 데이터베이스 행 직접 조회에 근거한 T1 증거다.

## 에이전트별 성공·실패 패턴

| 에이전트 | 표본 | 완료 | 실패 | 임대 만료 | 명시적 형식 반려 |
|---|---:|---:|---:|---:|---:|
| `opencode` | 5 | 1 | 1 | 3 | 0 |
| `nvidia` | 3 | 3 | 0 | 0 | 2 |
| `hermes` | 2 | 1 | 1 | 0 | 0 |
| `claude-code` | 1 | 1 | 0 | 0 | 1 |
| `cursor-agent` | 1 | 1 | 0 | 0 | 0 |
| 합계 | 12 | 7 | 2 | 3 | 3 |

해석:

- `opencode`는 원시 완료 기준 1/5로 20.0%이며, 실패성 5건 중 4건을 차지한다.
- `nvidia`의 세 작업은 모두 완료 상태지만, 그중 두 작업에는 `FORMAT_MISMATCH`가 명시돼 있다.
- `claude-code`의 한 작업도 완료 상태와 `FORMAT_MISMATCH`가 동시에 기록돼 있다.
- 에이전트별 표본이 작으므로 이 결과를 장기 성능으로 일반화하는 것은 **[미검증]**이다.

## 실패 유형별 빈도

아래 태그는 서로 중복될 수 있다. `근거등급 미달`은 산출물의 거짓을 뜻하지 않고, 구조화된 `evidence_json`이 없다는 운영상 정의다.

| 실패 유형 태그 | 빈도 | 표본 비율 | 근거 태스크 |
|---|---:|---:|---|
| `근거등급 미달` — `evidence_json` 부재 | 12 | 100.0% | 전체 표본 |
| 산출물 부재 — 응답 길이 0 | 4 | 33.3% | `task_WHn4No9eM_HH6WJQ`, `task_xn-WyOVjIHSEgnD0`, `task_T42Cd0mgElSOaoXU`, `task_1SAeDCVfMO8FDlBz` |
| `FORMAT_MISMATCH` | 3 | 25.0% | `task_zpPvDFRqCqWu4NUE`, `task_Pe00dCrVyKbbWFcM`, `task_9NxxNDRueeHKplTB` |
| `lease_expired` | 3 | 25.0% | `task_WHn4No9eM_HH6WJQ`, `task_xn-WyOVjIHSEgnD0`, `task_T42Cd0mgElSOaoXU` |
| 고아 작업 — 서버 재시작 뒤 재대기 2회 | 1 | 8.3% | `task_1SAeDCVfMO8FDlBz` |
| 알 수 없는 출력 실패 패턴 | 1 | 8.3% | `task_eTYAEfE-U8SP4X8F` |

추가 관찰:

- `FORMAT_MISMATCH` 3건은 모두 원시 상태가 완료이므로 완료 7건의 42.9%다.
- 위 3건의 `verifier_result_json`은 모두 `npm run build`, 종료 코드 0, `passed=true`를 기록한다.
- 구조화된 `evidence_json`은 12건 모두 비어 있다.
- 자유 형식 응답에서 T1을 주장한 작업은 3건이지만, 구조화된 증거 필드와의 연결은 없다.
- 자동 검증 결과가 없는 작업은 4건이다. 자동 검증 유무와 실제 산출물 품질의 인과관계는 **[미검증]**이다.

## 표본별 분류

| 태스크 ID | 에이전트 | 원시 상태 | 응답 길이 | 관찰 태그 |
|---|---|---|---:|---|
| `task_WHn4No9eM_HH6WJQ` | `opencode` | `lease_expired` | 0 | 임대 만료, 산출물 부재, 구조화 근거 부재 |
| `task_xn-WyOVjIHSEgnD0` | `opencode` | `lease_expired` | 0 | 임대 만료, 산출물 부재, 구조화 근거 부재 |
| `task_T42Cd0mgElSOaoXU` | `opencode` | `lease_expired` | 0 | 임대 만료, 산출물 부재, 구조화 근거 부재 |
| `task_f2rIUTYccNHb5T72` | `opencode` | `completed` | 4,962 | 구조화 근거 부재 |
| `task_zpPvDFRqCqWu4NUE` | `claude-code` | `completed` | 1,474 | `FORMAT_MISMATCH`, 구조화 근거 부재 |
| `task_-JdHSjEtuok4zBx6` | `cursor-agent` | `completed` | 437 | 자유 형식 T1 주장, 구조화 근거 부재 |
| `task_eTYAEfE-U8SP4X8F` | `hermes` | `failed` | 353 | 알 수 없는 출력 실패 패턴, 구조화 근거 부재 |
| `task_Pe00dCrVyKbbWFcM` | `nvidia` | `completed` | 311 | `FORMAT_MISMATCH`, 구조화 근거 부재 |
| `task_9NxxNDRueeHKplTB` | `nvidia` | `completed` | 134 | `FORMAT_MISMATCH`, 구조화 근거 부재 |
| `task_53r-X8exdmIhmHco` | `nvidia` | `completed` | 266 | 구조화 근거 부재, 자동 검증 없음 |
| `task_lue2DAqFKkmNm23z` | `hermes` | `completed` | 1,965 | 자유 형식 T1 주장, 구조화 근거 부재, 자동 검증 없음 |
| `task_1SAeDCVfMO8FDlBz` | `opencode` | `failed` | 0 | 서버 재시작 고아 작업, 산출물 부재, 구조화 근거 부재, 자동 검증 없음 |

## 상위 3개 근본원인 가설

### 우선순위 1 — 임대와 재시작 복구 실패가 완료율을 직접 낮춘다

`opencode` 배정 5건 가운데 3건이 같은 분에 `lease_expired`로 종료됐고, 다른 1건은 서버 재시작 뒤 두 번 재대기된 후 고아 작업으로 실패했다. 네 작업 모두 응답 길이가 0이다. 이는 실패성 5건 중 4건이므로 완료율 저하와 직접 연결되는 가장 강한 가설이다.

- T1 근거: [`task_WHn4No9eM_HH6WJQ`, `task_xn-WyOVjIHSEgnD0`, `task_T42Cd0mgElSOaoXU`, `task_1SAeDCVfMO8FDlBz`](#t1-1)
- 아직 확인할 것: 임대 만료가 공급자 무응답, 하트비트 누락, 임대 시간 설정 중 무엇 때문인지는 **[미검증]**이다.

### 우선순위 2 — 완료 상태와 품질 반려 상태의 분리가 점수 정체를 숨긴다

완료 7건 중 3건의 `metadata_json`에 `qualityRejected=true`와 `qualityHeuristics=["FORMAT_MISMATCH"]`가 기록돼 있다. 원시 완료율은 이 세 작업을 성공으로 세지만, 품질 관점에서는 반려 기록이 남는다. 점수 60.2의 계산식은 **[미검증]**이므로 직접 인과로 단정하지 않고, 점수 정체의 유력한 가설로 둔다.

- T1 근거: [`task_zpPvDFRqCqWu4NUE`, `task_Pe00dCrVyKbbWFcM`, `task_9NxxNDRueeHKplTB`](#t1-2)
- 아직 확인할 것: 점수 산식에서 `qualityRejected`가 차지하는 가중치는 **[미검증]**이다.

### 우선순위 3 — 검증기가 산출물 계약과 근거 연결을 검사하지 않는다

형식 반려 3건 모두 일반 빌드 검증은 통과했다. 빌드 성공은 저장소 타입 건전성을 보여주지만 문서 구조, 요구된 결정문, 변경 파일 목록, 근거 등급을 검증하지 않는다. 또한 12건 모두 `evidence_json`이 비어 있어 응답 안의 근거 주장과 데이터베이스 증거를 기계적으로 연결할 수 없다.

- T1 근거: [형식 반려 3건의 검증 결과와 전체 표본의 근거 필드](#t1-3)
- 아직 확인할 것: 응답 형식 전용 검증기를 어느 단계에 추가해야 재시도 폭증 없이 효과가 나는지는 **[미검증]**이다.

## 제한적이고 되돌릴 수 있는 개선안

이 자가학습 하위작업에서 적용한 수정은 한 줄 자리표시자를 이 실측 노트로 교체하고, 같은 요약을 Mem0에 한 건 추가하는 것으로 제한한다. 운영 코드와 팀 수명주기는 변경하지 않는다.

후속 구현팀에 권고할 최소 수정 범위:

1. 문서·보고 작업에는 빌드 검증과 별도로 필수 제목, 결정문, 변경 파일, 미검증 항목을 검사하는 형식 검증기를 붙인다.
2. `qualityRejected=true`인 작업은 완료 집계와 품질 통과 집계를 분리해 표시한다.
3. `lease_expired` 세 건의 하트비트와 임대 갱신 이벤트를 조회한 뒤, 원인이 확인된 경우에만 재대기 횟수나 임대 시간을 조정한다.
4. 검증 영수증을 자유 형식 응답에만 남기지 말고 `evidence_json`에 태스크 ID, 검증 명령, 종료 코드, 산출물 경로를 연결한다.

위 권고는 아직 코드에 적용하지 않았다. 각 변경은 독립 기능 깃발이나 단일 설정으로 되돌릴 수 있게 구현해야 한다.

## T1 근거 영수증

<a id="t1-1"></a>
### T1-1 — 임대 만료와 고아 작업

`tasks` 직접 조회 결과:

| 태스크 ID | 상태 | 오류 | 응답 길이 |
|---|---|---|---:|
| `task_WHn4No9eM_HH6WJQ` | `lease_expired` | `lease_expired` | 0 |
| `task_xn-WyOVjIHSEgnD0` | `lease_expired` | `lease_expired` | 0 |
| `task_T42Cd0mgElSOaoXU` | `lease_expired` | `lease_expired` | 0 |
| `task_1SAeDCVfMO8FDlBz` | `failed` | `orphaned: server restart (poison — requeued 2x)` | 0 |

<a id="t1-2"></a>
### T1-2 — 완료 상태의 형식 반려

`tasks.metadata_json` 직접 조회 결과:

| 태스크 ID | 상태 | 품질 반려 | 휴리스틱 |
|---|---|---|---|
| `task_zpPvDFRqCqWu4NUE` | `completed` | 참 | `FORMAT_MISMATCH` |
| `task_Pe00dCrVyKbbWFcM` | `completed` | 참 | `FORMAT_MISMATCH` |
| `task_9NxxNDRueeHKplTB` | `completed` | 참 | `FORMAT_MISMATCH` |

<a id="t1-3"></a>
### T1-3 — 검증과 근거 필드

- 위 형식 반려 3건의 `verifier_result_json`: 명령 `npm run build`, 종료 코드 0, 시간 초과 거짓, 통과 참.
- 표본 12건의 `evidence_json`: 모두 비어 있음.
- 표본 12건 중 `verifier_result_json`이 비어 있는 작업: 4건.
- 자유 형식 응답에서 T1을 주장한 작업: 3건.

재현에 사용한 핵심 조회 조건:

```sql
SELECT *
FROM tasks
WHERE team_id = 'team_tech-port-06-improvement-debate'
  AND created_at >= datetime('now', '-48 hours')
  AND status <> 'cancelled'
ORDER BY created_at DESC;
```

## 미검증 항목

- 점수 60.2의 내부 산식과 각 실패 유형의 가중치
- 임대 만료 세 건의 하트비트 누락 원인
- 장기 표본에서의 에이전트별 성능 재현성
- `evidence_json` 부재가 품질 점수에 미치는 직접 영향
- 로컬 NCO API 복구 후 `nco_list_tasks`와 `nco_get_task` 응답이 이 데이터베이스 스냅샷과 같은지 여부

## Mem0 연동 영수증

- 기억 키: `tech-port-06 실패패턴`
- 에이전트: `self-learning`
- 팀 연결: `team_tech-port-06-improvement-debate`
- 기억 ID: `mem0-1784859571760-gf67iu`
- 저장 시각: 2026-07-24 02:19:31 협정 세계시
- 저장 방식: 로컬 NCO API 비가동으로 기존 `mem0Add` 함수를 무임베딩 모드에서 직접 호출
- 데이터베이스 재조회: `mem0_memories`에서 기억 ID, 키, 팀 연결, 표본 12건을 확인
