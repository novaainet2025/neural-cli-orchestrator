---
created_at: 2026-07-24T12:40:00+09:00
verified_at: 2026-07-24T12:45:53+09:00
tags:
  - improvement-note
  - team/kd-memory
  - evidence/T1
  - cycle/3
  - sample-absence
---

# kd-memory cycle 3 — 감사 표본 부재 판정

> 대상: `team_kd-memory` (`kd-memory`, 지식·메모리 감사부)
>
> T1 원천: `db/nco.db`의 `team_lifecycle_events`, `tasks`, `teams` 직접 조회
>
> 관련 근거: [kd-memory 근본원인·수정 증거](../../docs/self-improve/kd-memory-rootcause-2026-07-24.md)

## T1 증거표

| task_id | DB 상태 | DB 실행자 | DB 원문 요약 | 실패 분류 | 등급 |
|---|---|---|---|---|---|
| `task_pKVM8hAZUmzskqwL` | `failed` | `hermes` | `spawned_by_cli=commander-perfgoal`; prompt 접두사=`[성과보고·목표설정 입력 지시]`; response=`curl: (7) Failed to connect to localhost port 6200 ... Couldn't connect to server`; `error=unknown: failure pattern in output`; `evidence_json=NULL` | 목표·성과보고 제어면의 NCO gateway 연결 실패. 지식·메모리 감사 산출물 실패가 아님 | T1 |
| `task_WpB7UCfWLhPnwx-u` | `failed` | `ollama` | `spawned_by_cli=commander-perfgoal`; prompt 접두사=`[성과보고·목표설정 입력 지시]`; response=`targetValue, direction, reflection, improvement are unknown; cannot fabricate values`; `error=unknown: failure pattern in output`; `evidence_json=NULL` | 목표·성과보고 입력 계약의 필수값 미주입. 지식·메모리 감사 산출물 실패가 아님 | T1 |
| `task_tnhlWTnnJz5dVshv` | `lease_expired` | `ollama` (`requestedProvider=nvidia`, `nvidia→ollama`) | `spawned_by_cli=commander-perfgoal`; prompt 접두사=`[성과보고·목표설정 입력 지시]`; response=`NULL`; escalation=`empty completion from provider 'nvidia' after 1 iteration(s)`; `heartbeat_seq=1`; `lease_expires_at=2026-07-23 11:58:17`; `evidence_json=NULL` | 목표·성과보고 제어면의 provider/lease 실패. 지식·메모리 감사 산출물 실패가 아님 | T1 |

세 task에는 각각 `npm run build` verifier 통과 기록이 있다. 이 값은 저장소
빌드 결과일 뿐, 요청된 HTTP 입력 성공이나 지식·메모리 감사 산출물 생성을
증명하지 않는다.

## lifecycle 기준선

| lifecycle event | DB 관측값 | 해석 |
|---|---|---|
| `tle_ueLLSiAc52oyb1-T` / cycle 1 직전 | score `3.3`, `48h/3`, completion `0%` | 같은 제어면 task 3건이 표본으로 집계된 저장 스냅샷 |
| `tle_GvDIgf32aTN9yhuz` / cycle 3 직전 | score `1.9`, `48h/2`, completion `0%` | cycle 3 HR directive의 직접 기준선 |
| `tle_qnpKq7-k0FhfY5Vs` / cycle 3 directive | score `1.9`, improvement count `3` | 이번 요청과 일치하는 HR 이벤트 |

`tasks WHERE team_id='team_kd-memory'`를 전수 집계한 실측값은 다음과 같다.

- 전체 team task: `3`
- `spawned_by_cli='commander-perfgoal'`이면서 prompt가
  `[성과보고·목표설정 입력 지시]`로 시작하는 제어면 task: `3`
- 위 조건에 해당하지 않는 task: `0`

`48h/2`가 세 task 중 어느 두 행을 센 값인지는 저장된 lifecycle 집계 결과다.
현재 worktree의 scorer 조건을 과거 이벤트에 소급 적용한 운영값으로 바꾸어
보고하지 않는다.

## 성공·실패 패턴과 결론

관측된 세 실패는 각각 gateway 연결 거부, 필수 입력값 미주입, provider/lease
만료다. 공통점은 모두 목표·성과보고를 입력하는 `commander-perfgoal` 제어면
task라는 것이다. 지식·메모리 감사 실행, 감사 보고서 생성, 장기기억 검증 같은
실제 감사 task는 DB에 한 건도 없다.

따라서 `completion=0%`는 다음을 증명하지 않는다.

- 감사 산출물 경로를 NCO가 인식하지 못했다.
- Mem0가 연동되지 않았다.
- 실제 지식·메모리 감사 세 건이 모두 실패했다.

확정 가능한 결론은 **실제 감사 표본 부재**다. 저장된 score와 completion은
제어면 task를 대상으로 계산된 값이며, 감사 품질의 성공률로 해석할 수 없다.
새 실제 감사 task가 생성·종결되기 전에는 score/completion 개선 여부도
판정할 수 없다.

## 안전 경계와 가역성

- 이 작업은 노트 한 파일만 추가한다. rollback은 이 파일만 제거하면 된다.
- task 상태, score, lifecycle event, 팀 활성 상태를 변경하지 않았다.
- DB에는 cycle 3 이후 HR 소유 `retired` 이벤트
  `tle_yRKRILKPGgWi_gJH`와 `teams.is_active=0`이 관측되지만, 이는 이번
  작업의 행위나 성공 증거가 아니다. 복원·비활성화·retirement 판단은 HR
  권한으로 남긴다.
- Mem0/knowledge-base 쓰기 및 연동 검증은 이번 범위 밖이다.
- 외부 Obsidian 원본 vault 동기화는 `[미검증]`이다. 이 노트는 저장소의
  `obsidian_vault/improvement_notes` 미러에만 기록한다.

## 검증 영수증

- `[DB task rows]` 지정 task 3건의 status, assigned_to, prompt 접두사,
  spawned_by_cli, response/error, lease metadata, evidence_json을 직접 조회했다.
- `[DB population]` 팀 task `3`, 확정 제어면 task `3`, 비제어면 task `0`.
- `[DB lifecycle]` cycle 1 기준 `3.3/48h/3/0%`, cycle 3 기준
  `1.9/48h/2/0%`, cycle 3 directive improvement count `3`을 직접 조회했다.
- `[DB integrity]` SQLite `PRAGMA quick_check` → `ok`.
- `[typecheck]` `npx tsc --noEmit` → exit `0`, 출력 없음.
- `[build]` `npm run build` → `tsc`, exit `0`.
- `[잘못된 호출 2건]` 후속 검증 도구가 각각 `영수증:`과 `결과:`를
  Vitest 파일 필터로 전달했다. 두 호출 모두 `No test files found`, exit `1`이며
  테스트 본문은 실행되지 않았으므로 통과나 프로젝트 회귀로 계산하지 않는다.
- `[focused test 직접 실행]`
  `npx vitest run src/core/team-scorer.test.ts` → `1` file,
  `4` tests passed, exit `0`.
- `[등급]` T1 — DB 행 원문과 파일 내용을 직접 확인.
- `[Gap]` 외부 vault 동기화와 새 실제 감사 task의 효과 검증이 남아 있다.
- `[미검증]` 외부 Obsidian 원본 vault 동기화, 새 실제 감사 task의 향후 결과.
- score/completion 상승은 주장하지 않는다.
