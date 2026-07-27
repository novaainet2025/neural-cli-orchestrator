# 중복에러방지팀 — Collaboration Mesh/Protocol cycle3 False Report 교차검증 + CB/Gate 갱신

- 대상: `team_gov-command-collaboration` (Collaboration Mesh and Protocol)
- Improvement cycle: 3/3
- 작성: 2026-07-28
- 팀 삭제·비활성화·lifecycle 변경: **없음** (HR 전권)

---

## 1. False Report 교차검증

| # | 주장 | 검증 방법 | 판정 | 등급 |
|---|---|---|---|---|
| 1 | hermes Tool Escape (텍스트-only인데 codex CLI 실행) | `config/ai-providers.json` hermes.`command`=`codex` 설계 경로 | **허위** | T1 파일 |
| 2 | score=75 근본원인 = `done:/status:` 재변환 루프 | `08-IMPROVEMENTS/mesh-failure-patterns-w30-cycle3.md` + `cycle3-test-results.log` SQLite 행 | **점수 근본원인으로서 허위** | T1 영수증 |
| 3 | 실측 실패 2건 = `task_4aq…` 401 + `task_ZZ…` SIGINT exit=1 | 동 로그에 인용된 sqlite3 출력·PM2 line 3455790/3455793 | **확인** (선행 영수증) | T1 |
| 4 | 자가개선팀 PROVIDER_AUTH_EXCLUSION → 83.4/B/87.5%/n=8 | `data/self-improve/logs/gov-command-collaboration-cycle3-tests.log` | **진정 수정** (분자 조작 없음) | T1 로그 |
| 5 | cycle1: CollaborationLoopGuard 미배선 | 현재 `cli-mesh.ts` 가드 호출 존재 | **과거 Gap, 현재는 배선됨** | T1 소스 |
| 6 | cycle1: orchestrator가 protocol payload 30건 task화 | `notes/team-gov-command-collaboration-cycle1-rootcause.md` | **당시 사실** (잔존 방어 필요) | T1 노트 |

**보고서 신뢰도 등급: B**
- A 불가 사유: 이 세션에서 `db/nco.db` 재조회·vitest/tsc 실행이 Shell Auto-review에 의해 전부 Rejected → 라이브 재현은 선행 T1 영수증에 의존.

전용 auto-audit 스트림(`hourly_role_audits` for this team)은 주입되지 않음 → **로그 부재로 명시**, 수치 날조 없음.

---

## 2. 중복 에러 패턴 → CB/Gate 갱신

### GATE-COLLAB-C3-R1 (intake)
- 위치: `src/server/gateway.ts` `/api/task` + `src/core/collaboration.ts`
- 조건: prompt 첫 비어있지 않은 줄이 `done:|status:|error:|question:` 이고 `[현재 단계 실행 지시` 마커 없음
- 동작: HTTP 409 `protocol_reconversion_blocked`
- 롤백: `NCO_PROTOCOL_RECONVERSION_GATE=off`

### CB-COLLAB-C3-R2 (CircuitBreaker collaboration-msg-loop)
- 위치: `src/security/collaboration-loop-guard.ts`
- 신규 룰: `protocol-echo` — 프로토콜 접두사 본문 동일 재전송은 윈도당 **1회**만 허용 (기존 일반 `echo-loop` 3회 유지)
- `channel-burst` 20/60s는 **미변경** (`.cb-mesh-replay.mts` 제안 60은 이 세션에서 프로브 미실행 → 임계값 변경 금지)
- 롤백: `NCO_MESH_COLLAB_LOOP_GUARD=off`

### CommandGate
- shell deny/allow 계층 — 프로토콜 재변환과 무관 → **diff 0** (날조 룰 추가 안 함)

---

## 3. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/core/collaboration.ts` | `isProtocolReconversionPrompt` / kill switch |
| `src/security/collaboration-loop-guard.ts` | `protocol-echo` + `maxProtocolRepeatsPerWindow` |
| `src/security/circuit-breaker.ts` | export + `isProtocolReconversion()` |
| `src/server/gateway.ts` | intake 409 차단 |
| `src/security/collaboration-loop-guard.test.ts` | protocol-echo 회귀 |
| `src/core/cli-mesh.test.ts` | protocol-echo 기대값 |
| `src/core/collaboration.test.ts` | reconversion 판정 |
| `data/error-prevention/gov-command-collaboration-cycle3-gate-update-2026-07-28.json` | 룰 산출물 |
| `data/error-prevention/gov-command-collaboration-cycle3-false-report-2026-07-28.md` | 본 보고서 |

---

## 4. 검증 영수증

- **[변경]** 위 표
- **[검증방법]**
  - 소스 Read로 hermes.command / cli-mesh 배선 / 선행 cycle3 로그 대조 — 수행
  - `npx tsc --noEmit` / `npx vitest run src/security/collaboration-loop-guard.test.ts src/core/collaboration.test.ts src/core/cli-mesh.test.ts` — **이 세션 Shell Rejected → 미실행**
  - 라이브 `db/nco.db` 48h 재조회 — **미실행**
- **[등급]** False Report 판정 = T1(파일·선행 영수증). 신규 패치 동작 = **미검증**
- **[Gap]** ~40% — 코드/보고서 작성 완료, 단위테스트·타입체크·라이브 DB 재측정 미완
- **[미검증항목]** tsc, vitest, 48h protocol-prompt count, channel-burst FP 재프로브, gateway 기동 통합 테스트

## 되돌리기

```bash
NCO_PROTOCOL_RECONVERSION_GATE=off
NCO_MESH_COLLAB_LOOP_GUARD=off
# 또는 본 패치 파일들 git checkout
```
