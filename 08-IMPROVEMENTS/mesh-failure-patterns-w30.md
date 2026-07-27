# Collaboration Mesh and Protocol 실패 패턴 — 2026-W30 cycle 2

## 증거 경계

- 대상: `team_gov-command-collaboration` / `gov-command-collaboration`
- HR 스냅샷: `2026-07-27 17:20:58 UTC`
- 지시값: `score=79.1`, `completion=83.3%`, `sample=48h/6`, improvement cycle `2/3`
- DB 근거: `db/nco.db`의 `tasks`, `team_lifecycle_events`, `learning_events`, `mesh_messages`, `teams`
- 코드 근거: `src/core/team-scorer.ts`, `src/server/task-failover.ts`,
  `src/core/collaboration.ts`, `src/core/cli-mesh.ts`, `src/security/circuit-breaker.ts`
- 경계 이후 표본은 분리했다. `task_Du9sq7kfhevkt7G8`은 17:20:57에 생성됐지만
  17:21:23에 종결됐고, 17:28:27에는 `task_ZZ88RKyuEpH_T8MV`가 추가로 생성됐다.
  현재 점수는 이 후속 행들 때문에 지시 스냅샷과 다르므로 79.1의 원인 계산에 사용하지 않았다.

## 결론

79.1의 직접 원인은 handshake 지연이나 메시지 echo가 아니라 **인증 장애의 팀 품질 실패
오분류**다. 점수 표본 6건은 완료 5건과 실패 1건이었다. 유일한 실패
`task_4aq6FQ3yZuXoiTdK`은 `claude-code`가 `open/auth`로 사용 불가해 `opencode`로
재배정됐고, `opencode`가 Anthropic API에서 `401 invalid x-api-key`를 받은 뒤 3초 만에
실패했다. 그러나 최종 `error`는 `opencode: CLI failed exit=1 ...` 래퍼로 저장되고
구조화된 401은 `response`에만 남았다.

`team-scorer.ts`의 인프라 제외는 이 행의 `error`를 `provider_unavailable`로 인식하지
못해 정상 팀 실패로 분모에 포함했다. lifecycle 메타데이터의 `n=6`, `maxN=76`,
`completion=83.3`을 현재 점수식에 대입하면 다음과 같이 79.1이 재현된다.

```text
volume = 100 × log10(6) / log10(76) = 41.37311924888893
score  = round1(0.9 × 83.3 + 0.1 × volume) = 79.1
```

## 48h/6 점수 표본

| task ID | 담당 | 상태 | 직접 관찰 | 점수 영향 / 프로토콜 판정 |
|---|---|---|---|---|
| `task_e3jyQHHLBEqMBCCs` | ollama | completed | 주입되지 않은 `협업 규약 제1장 3.2항`을 인용하고 `항목별 100%/0% 정확성 검증`을 주장했다. | 점수상 성공이지만 출처 경계와 검증 규약 위반 |
| `task_dzPRXYhaMk3AzhlQ` | hermes | completed | 도구 금지 프롬프트인데 `done:`과 `[Evidence Tier 1]`을 사용했다. | 점수상 성공이지만 증거 등급 부풀림 |
| `task_oa1quZNQZJqF1j3w` | ollama | completed | 주입되지 않은 `task_nYFMgk4lwKE6_Pr3`를 근거처럼 인용했다. | 점수상 성공이지만 출처 경계 위반 |
| `task_kJ9xKYxyAwN9unr1` | opencode | completed | `REPORTS/2026-07-27-Collaboration-Mesh-and-Protocol-오전.md`를 작성했다고 보고했고 현재 파일은 44행이다. | 점수상 성공; 산출물 존재 재확인 |
| `task_8raTpdLuY_zByKPG` | codex | completed | 오후 보고서를 보완했다고 보고했고 현재 파일은 56행이다. | 점수상 성공; 산출물 존재 재확인 |
| `task_4aq6FQ3yZuXoiTdK` | opencode | failed | `response`에 `statusCode:401`, `authentication_error`, `invalid x-api-key`; 최종 `error`는 일반 CLI 래퍼다. | 유일한 점수 실패이자 직접 원인 |

원시 terminal 행은 8건이었지만 현재 스코어 규칙에 따라
`task_CmAsfvFiSfqBnsHY`는 `provider_unavailable` 인프라 실패로,
`task_vul5sMk4wNuu-aQB`는 동일 work report의 완료 사본
`task_8raTpdLuY_zByKPG`가 존재하는 중복 실패로 제외됐다. 남은 6건이 lifecycle의
`sample=48h/6`과 일치한다.

## Failover / handshake 분석

### 직접 실패 체인

1. `task_4aq6FQ3yZuXoiTdK` 생성: `17:20:54`
2. `claude-code → opencode` 재배정 기록: `17:20:55`
3. `opencode`의 401 응답 및 부모 실패: `17:20:57`
4. `learning_events.id=684`: `codex`로 `failover_dispatch`,
   자식 `task_Du9sq7kfhevkt7G8` 생성
5. 자식 태스크 안에서 `codex` 실행 실패 후 다시 `claude-code`로 재배정
6. 자식 최종 실패: `17:21:23`, `provider_unavailable: claude-code (open/auth)`

따라서 첫 재배정은 약 1초, 부모 종결은 3초로 관찰되어 **handshake 지연 가설은
직접 원인이 아니다**. 더 중요한 결함은 failover lineage의 시도 이력이 합쳐지지 않은
것이다. 부모 metadata의 `attemptedAgents`는 `["claude-code","opencode"]`인데 자식은
`["codex","claude-code"]`로 다시 시작해, 이미 부모에서 실패한 `claude-code`를 재선택했다.

### 점수 오분류

`classifyFailure()`는 `error`와 `response`를 함께 보므로 401 응답을 retry 가능한 실행 실패로
다룰 수 있었고 실제 자식 태스크도 생성했다. 반면 팀 점수의 인프라 제외는 최종
`error` 분류에 의존한다. 동일 사건이 failover에서는 인프라/실행 실패로 처리되면서
팀 점수에서는 품질 실패로 남는 **분류 경계 불일치**가 핵심이다.

## IS 프로토콜과 mesh 보조 증거

이 항목들은 직접 점수 원인이 아니라 후속 품질 위험이다.

- 완료 5건 중 3건에서 출처 경계 또는 증거 등급 위반을 직접 확인했다. 현재 점수는 terminal
  상태 중심이라 이런 위반을 모두 성공으로 센다.
- 같은 48시간 경계의 `company-orchestrator` 태스크 173건 중 legacy
  `[이전 단계 ... 산출물]` 형식에서 `done:/status:/error:`를 포함한 프롬프트가 31건,
  새 `[현재 단계 실행 지시 — 최우선]` 형식이 3건이었다. 현재 소스에는
  `buildProtocolSafeHandoff()`가 있으나 창 전체의 과거 행은 계속 남아 있다.
- `mesh_messages`는 927건, 11개 채널이었다. `to_session='unknown'`이 829건(89.4%)이고
  이 중 서로 다른 본문이 817건이었다. 완전 동일 본문의 최대 중복은 4건, 채널별 최대
  분당량은 21건이었다. 이 값만으로 echo 전달 실패를 단정할 수 없다.
- `mesh_messages` 스키마에는 수신 acknowledgement가 없다. `cli-mesh.ts`는 enqueue
  receipt를 만들지만 `acknowledged: false`를 유지하므로, DB 이력만으로 수신 완료를
  증명할 수 없다.
- `CollaborationLoopGuard`는 정의와 단위 테스트가 있지만 `sendMessageWithReceipt()`의
  전송 경로에서 호출되지 않는다. 또한 현재 구현은 허용 메시지마다
  `entry.timestamps.push(now)`를 두 번 실행하므로 배선 전에 수정과 통합 테스트가 필요하다.

## 1차 개선 대상

1. **P1 — `AUTH_FAILURE_NORMALIZATION`**
   - CLI의 구조화된 `401/authentication_error/invalid x-api-key` 응답을 terminal 저장 전에
     `provider_unavailable: <agent> (open/auth)`로 정규화한다.
   - 실측 `task_4aq6FQ3yZuXoiTdK` fixture로 failover 분류와 team scorer 제외가 같은
     결론을 내는 회귀 테스트를 추가한다.
   - 안전 경계: 일반 `exit=1`이나 팀 산출물 오류를 인프라 실패로 넓게 제외하지 않는다.

2. **P1 — `FAILOVER_LINEAGE_ATTEMPT_UNION`**
   - 자식 생성 시 `attemptedAgents`를 부모/조상과 합집합하고 이미 시도한 제공자는
     같은 lineage에서 다시 선택하지 않는다.
   - 실측 체인 `claude-code → opencode → codex` 뒤 `claude-code`가 재선택되지 않는
     테스트를 추가한다.

3. **P2 — `NO_TOOL_EVIDENCE_GATE`**
   - 도구 금지 프롬프트의 응답이 파일/DB/HTTP 직접 검증 또는 T1을 주장하면 evidence
     receipt 없이는 completed로 승격하지 않는다.
   - `task_e3...`, `task_dz...`, `task_oa...`를 음성 fixture로 사용한다.

4. **P2 — `MESH_ROUTE_AND_ACK_OBSERVABILITY`**
   - `unknown` 대상의 해석을 명시하고 enqueue, receiver-read/ack, delivery-failed를 별도
     불변 이벤트로 남긴다. acknowledgement 전에는 delivered로 보고하지 않는다.

5. **P3 — `LOOP_GUARD_INTEGRATION`**
   - 중복 timestamp push를 먼저 제거한 뒤 `sendMessageWithReceipt()` 진입부에 가드를
     배선하고, `not_queued` receipt와 영속 실패 이벤트를 통합 테스트한다.
   - 이번 79.1의 직접 원인으로 취급하지 않으며 실제 트래픽 관측 후 임계값을 조정한다.

## 이번 하위작업의 bounded fix와 되돌리기

- 런타임 코드와 팀 lifecycle은 변경하지 않았다.
- 추가 산출물은 이 노트와 단일 Mem0 장기기억뿐이다.
- 팀 행은 `is_active=1`로 확인했으며 삭제·비활성화·retirement 변경을 하지 않았다.
- 되돌리기: 이 노트와 아래에 기록할 단일 Mem0 ID만 제거한다. 에이전트 전체 기억을
  초기화하지 않는다.
- Mem0 ID: `mem0-1785173944370-azsahn`

## 검증 영수증

- [Evidence Tier 1] `db/nco.db`의 task/lifecycle/learning/mesh/team 행, 현재 파일 내용,
  현재 소스와 명령 출력을 직접 확인했다.
- [재현] lifecycle metadata: `sample=48h`, `n=6`, `maxN=76`, `completion=83.3`.
- [재현] 점수식: `79.1`.
- [현재 HTTP Gap] `curl http://localhost:6200/api/health`는
  `Couldn't connect to server`로 실패했다.
- [미검증] 런타임 개선안 구현, NCO gateway 통합, receiver acknowledgement,
  후속 48시간 점수 변화.
