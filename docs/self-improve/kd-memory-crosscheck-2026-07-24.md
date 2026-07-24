# kd-memory 반복 오류·False Report 교차검증 (2026-07-24)

> 대상: `team_kd-memory` (`kd-memory`, 지식·메모리 감사부)
>
> 기준 HR 이벤트: `tle_qnpKq7-k0FhfY5Vs` / 2026-07-24 03:10:00 UTC /
> score 1.9 / completion 0% / sample 48h/2 / cycle 3/3
>
> T1 원천: `/Users/nova-ai/project/nco/db/nco.db`의 `tasks`,
> `team_lifecycle_events`, `hourly_role_audits`, `logs`, `false_reports`,
> `nova_audit_log`, `verification_gates`; 현재 Git worktree의 소스·테스트

## 1. T1 실패 분류표

`tasks WHERE team_id='team_kd-memory'`의 전체 결과는 3건이며 모두
`spawned_by_cli='commander-perfgoal'`인 목표·성과 입력 제어면 task다.
실제 지식·메모리 감사 산출물 task는 0건이다.

| task_id | 상태·실행자 | DB 원문 | 실패 분류 |
|---|---|---|---|
| `task_pKVM8hAZUmzskqwL` | `failed` / hermes | `curl: (7) Failed to connect to localhost port 6200 ... Couldn't connect to server`; `error='unknown: failure pattern in output'`; 변경 파일 없음 | NCO gateway 연결거부 |
| `task_WpB7UCfWLhPnwx-u` | `failed` / ollama | `targetValue, direction, reflection, improvement are unknown; cannot fabricate values`; `error='unknown: failure pattern in output'` | 목표·성과 입력 필수값 미주입 |
| `task_tnhlWTnnJz5dVshv` | `lease_expired` / nvidia→ollama | response 없음; metadata의 escalation reason=`empty completion from provider 'nvidia' after 1 iteration(s)`; `heartbeat_seq=1`, `lease_expires_at=2026-07-23 11:58:17` | provider 응답 없음 이후 lease 만료 |

세 행에 모두
`verifier_json={"type":"run","command":"npm run build","timeoutMs":120000}`가
붙었고 `verifier_result_json`은 `exitCode=0`, `passed=true`다.
`verification_gates`도 task마다 L1 typecheck pass, L2 lint skip, L3
change-ratio pass를 기록한다. 이 값들은 저장소 빌드 상태만 확인하며 HTTP
목표·성과 입력의 성공을 검증하지 않는다.

따라서 build verifier의 부착은 intake 오분류지만, verifier가 위 세 실패나
lease 만료를 일으켰다는 인과 증거는 없다. “빌드 게이트 실패”로 재분류하거나
이를 근거로 Circuit Breaker 실패 규칙을 바꾸면 실제 원인을 가리게 된다.

## 2. completion 반복의 직접 해석

`team_lifecycle_events`의 실측 저장값은 다음과 같다.

| 시각(UTC) | 이벤트 ID | score | sample | completion |
|---|---|---:|---:|---:|
| 02:40 | `tle_ueLLSiAc52oyb1-T` | 3.3 | 48h/3 | 0% |
| 02:50 | `tle_m7HCGl1y2qSpDmtM` | 3.1 | 48h/3 | 0% |
| 03:00 | `tle_ALuvU-amZDxqbUS6` | 1.9 | 48h/2 | 0% |
| 03:10 | `tle_GvDIgf32aTN9yhuz` | 1.9 | 48h/2 | 0% |

02:40~03:10 사이 이 팀에 새 task는 생성되지 않았다. completion 0%의 반복은
새 감사 task의 반복 실패가 아니라 기존 제어면 행의 재집계다. 03:00부터 표본이
3→2로 바뀐 것은 gateway 연결거부 행이 terminal 분모에서 제외된 결과이며,
나머지 2건도 감사 산출물이 아니다. score/completion 상승은 확인되지 않았고
주장하지 않는다.

## 3. False Report 판정

| 확인 대상 | 실측 행 | 판정 |
|---|---:|---|
| 관련 task 3건의 `false_reports` | 0 | 공식 False Report 등록 없음 |
| `hourly_role_audits.subject_id='team_kd-memory'` | 0 | 팀 전용 auto-audit 데이터 없음 |
| `logs`의 team/task ID 직접 참조 | 0 | 별도 감사·오류 로그 없음 |
| `nova_audit_log`의 target/metadata 직접 참조 | 0 | 별도 감사 체인 데이터 없음 |

task 응답 자체에서도 성공을 가장한 보고는 관찰되지 않았다. hermes는 연결
실패와 미입력을 명시했고, ollama는 근거 없는 필수값을 만들 수 없다고
`status:`로 거부했으며, lease 만료 task는 response가 없다. 따라서 확인 가능한
DB 범위의 판정은 **False Report 없음**이다.

다만 auto-audit·감사 로그가 0건이므로 자동 감사기가 이 세 task를 독립적으로
검사했는지는 `[미검증]`이다. 행 부재를 “감사 통과” 수치로 해석하지 않는다.

## 4. 재발 방지 게이트 판정

현재 `src/server/task-intake.ts`에는 다음 bounded gate가 있다.

- `PERFORMANCE_GOAL_INPUT_PATTERN`은 프롬프트 시작의 정확한
  `[성과보고·목표설정 입력 지시]` 접두사만 감지한다.
- `buildDefaultVerifierWithFs`는 이 접두사를 감지하면 prompt-gate 보강문에
  “수정/빌드”가 있더라도 기본 `npm run build` verifier를 붙이지 않는다.
- 호출자가 명시적 verifier를 제공한 경우 기존 우선순위를 유지한다.
- 회귀 테스트는 같은 접두사와 코드 작업 키워드가 함께 있어도 기본 verifier가
  `undefined`임을 확인한다.

**판정: 동일 접두사를 사용하고 기본 verifier 추론 경로를 거치는 후속 task의
오부착 재발은 차단한다.** 정확한 접두사가 없거나 호출자가 verifier를 직접
전달하는 경로는 차단 대상이 아니다. 이 gate는 gateway 가용성, 필수값 주입,
provider/lease 문제를 해결하지 않으며 기존 task를 소급 수정하지도 않는다.

세 verifier가 모두 통과했고 실패 인과가 없으므로, 이번 증거만으로 별도
Circuit Breaker 룰을 갱신할 필요는 없다. 승인된 CB 레지스트리와 번호는 확인하지
않았으며 임의 번호를 만들지 않는다.

## 5. 안전 경계와 현재 상태

- task·score·팀 활성 상태·lifecycle 이벤트는 읽기 전용으로만 조회했다.
- 현재 DB에는 03:20 UTC의 HR `retired` 이벤트
  `tle_yRKRILKPGgWi_gJH`와 `teams.is_active=0`이 존재한다. 이는 이 교차검증이
  만든 변경이 아니다. HR 전용 상태를 복구·변경하지 않았다.
- intake gate는 이미 HEAD(`ade3456`)에 존재한다. 이 단계에서는 새 동작을
  구현하지 않고 증거와 적용 경계만 교정했다.

## 6. 검증 영수증

- [변경] `docs/self-improve/kd-memory-crosscheck-2026-07-24.md` — cycle 3
  T1 분류표, False Report 판정, intake gate 적용 경계와 미검증 항목 교정.
- [DB] 대상 task 3건, HR lifecycle 원문, verifier 결과와 감사 테이블 건수를
  직접 조회.
- [관련 회귀]
  `npm run test:run -- src/server/task-intake.test.ts`
  → 1 file, 15 tests passed, exit 0.
- [타입체크] `npx tsc --noEmit` → exit 0, 출력 없음.
- [빌드] `npm run build` → `tsc`, exit 0.
- [등급] T1(DB 행·파일 내용·실제 명령 출력).
- [미검증항목] 전체 test suite(관련 intake 회귀만 실행), post-patch NCO HTTP
  생성 경로, auto-audit 독립 판정, 운영 재배포 후 신규 task의 verifier 원문.
