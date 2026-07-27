# 중복에러방지팀 — collaboration fix 역효과 모니터링 · False Report 교차검증

- 대상: `team_gov-command-collaboration` (Collaboration Mesh and Protocol), Improvement cycle 1/3
- 작성: 2026-07-27
- 저장소 HEAD: `cc17993768e589631c08452e4520d74bc835d121`
- 데이터 출처: `db/nco.db` (SQLite 직접 조회), 워킹트리 파일 내용, 명령 출력

---

## 1. False Report 교차검증 — 자가개선팀 주장 대조

각 주장에 대해 실제 파일 내용·심볼 참조·명령 출력을 직접 확인했다.

| 주장 | 검증 방법 | 결과 |
|---|---|---|
| `src/core/collaboration.ts` 신규 (프로토콜 분리) | 파일 존재 3581B, `parseCollaborationProtocol`/`buildProtocolSafeHandoff` 정의 | **확인** |
| `company-orchestrator.ts`가 핸드오프를 사용 | `src/core/company-orchestrator.ts:27` import, `:548` 호출 | **확인** |
| `src/mesh/delivery.ts` 신규 (queued/not_queued 구분) | `createMeshEnqueueReceipt` 정의, `acknowledged: false` 고정 | **확인** |
| `cli-mesh.ts`가 receipt를 사용 | `src/core/cli-mesh.ts:9` import, `:469` 호출, `:388` `sendMessageWithReceipt` | **확인** |
| `collaboration-engine.ts`가 전달 요약을 기록 | `:211`, `:313` `cliMesh.sendMessageWithReceipt` 호출 | **확인** |
| `mesh:delivery_failed` 영속 이벤트 | `src/core/event-bus.ts:27` PERSIST_TYPES 등재, `cli-mesh.ts:493` 발행 | **확인** |
| `config/score-measurement.sh` baseline 덮어쓰기 차단 | `exit 5` 분기 존재 | **확인** |
| `npm run test:run` → 115 files / 626 tests | 재실행 → `Test Files 115 passed (115)`, `Tests 626 passed (626)` | **재현됨** |
| 팀 lifecycle 미변경 (`is_active=1`) | `SELECT id,slug,is_active FROM teams` → `team_gov-command-collaboration\|gov-command-collaboration\|1` | **확인** |

**허위 보고 0건.** 다만 인용된 행 번호 일부는 실제 위치와 어긋난다
(예: `collaboration-engine.ts:178`은 `createCollaboration`의 INSERT 구문이고 전달 요약 코드는 `:211`/`:313`).
심볼 단위 주장은 모두 참이므로 허위가 아닌 **행 번호 표기 부정확**으로 분류한다.

## 2. 역효과 48h 모니터링 — 관측 창 부족

collaboration fix 파일들의 mtime은 `2026-07-27 16:48~16:51 KST`(= `07:48~07:51Z`)이다.
따라서 48h 창(`2026-07-25`~`07-27`)의 실패 데이터는 **거의 전부 fix 이전**이며 인과 귀속이 불가능하다.

- 48h tasks: completed 653 / failed 328 / cancelled 48 / queued 1 / running 1 / timed_out 1
- 48h 상위 실패 사유: `queue_wait_timeout` 66, `orphaned: server restart` 53,
  `Circuit breaker open ... hermes` 44, `... claude-code` 42 — 모두 프로바이더/인프라 계열이며 collaboration 경로 아님
- **fix 이후 창**(`>= 2026-07-27T07:48Z`, 약 25분): mesh 메시지 7건 / 채널 1개 / 신규 task 0건

> 결론: **48h 역효과 판정 불가.** 관측 표본(n=7 메시지, 0 task)이 판정에 부족하다.
> "역효과 없음"으로 보고하지 않는다. cycle 2에서 재측정 필요.

## 3. 신규 근본원인 — collaboration 메시지 루프 (fix와 무관, 기존 결함)

`mesh_messages` 48h 실측에서 루프 신호를 확인했다.

| 신호 | 실측값 |
|---|---|
| 동일 (from,to) 채널 + **완전히 동일한 본문**이 60초 이내 재전송 | 최대 **72회** (`nco-system → unknown`) |
| 동일 채널 분당 메시지 최대치 | **41건/분** (`2026-07-25T01:17`) |
| 정상 협업 채널 기준선 | `nco-system → work-report-scheduler` 48h 총 64건 ≈ 1.3건/시간 |
| 48h mesh 전체 | 2835건, 그중 `nco-system → unknown` 2730건 (96.3%) |

mesh 전송 경로에는 채널 단위 중복/버스트 억제 장치가 없었다.

## 4. 적용한 수정 (bounded · reversible)

`src/security/circuit-breaker.ts` (+228줄, 신규 export만 추가 — 기존 심볼 시그니처 무변경):

- `CollaborationLoopGuard` — 채널별 슬라이딩 윈도 인메모리 가드 (**DB 쓰기 없음**)
  - `echo-loop`: 동일 본문(공백 정규화 후 SHA-1) 60초 내 3회 초과 → 차단
  - `channel-burst`: 채널 전체 60초 내 20건 초과 → 차단
  - 트립 시 60초 쿨다운. **차단된 메시지는 윈도에 기록하지 않아** 루프가 계속 재시도해도
    쿨다운이 연장되지 않고 반드시 만료된다(영구 봉쇄 방지)
  - `maxTrackedChannels` 500 + LRU 축출로 메모리 상한 고정
- `CircuitBreaker.checkCollaborationMessage()` — 편의 진입점.
  협업 루프는 프로바이더 장애가 아니므로 **`circuit_states`를 오염시키지 않는다**(회로는 closed 유지).

임계값 근거: 정상 기준선(1.3건/시간)의 수백 배 여유를 두고, 실측 병증(72회/분, 41건/분)은 확실히 잡는 위치.

**되돌리기**: `git checkout -- src/security/circuit-breaker.ts` + `rm src/security/collaboration-loop-guard.test.ts`.
호출부가 없어 부작용이 전파되지 않는다.

## 5. 검증

- `npx vitest run src/security/collaboration-loop-guard.test.ts` → `Test Files 1 passed`, `Tests 11 passed (11)`
- `npm run test:run` → `Test Files 116 passed (116)`, `Tests 637 passed (637)` (626 → 637, +11 신규, 회귀 0)
- `npx tsc --noEmit` → exit 0

## 6. 미해결 (Gap)

- **룰이 아직 호출되지 않는다.** `cli-mesh.ts` / `collaboration-engine.ts` 전송 경로 배선은
  본 하위작업의 지정 범위(`src/security/circuit-breaker.ts` + unit 테스트) 밖이라 적용하지 않았다.
  배선 지점: `CliMesh.sendMessageWithReceipt()` 진입부에서
  `collaborationLoopGuard.check(collaborationChannelKey(from, to), content)` 확인 후
  차단 시 `not_queued` receipt 반환.
- 48h 역효과 판정은 관측 창 부족으로 미완 (§2).
- 임계값의 프로덕션 적정성은 실트래픽 미검증 (배선 전이므로 관측 불가).
