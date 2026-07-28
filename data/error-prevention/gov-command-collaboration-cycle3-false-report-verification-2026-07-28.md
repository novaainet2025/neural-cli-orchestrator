# 중복에러방지팀 — cycle3 False Report 교차검증 + CB/Gate 갱신 (재검증본)

- 대상: `team_gov-command-collaboration` (Collaboration Mesh and Protocol)
- Improvement cycle: 3/3 · 작성 2026-07-28 · HEAD(시작) `4bccaf6`
- 팀 삭제·비활성화·lifecycle 변경: **없음** (HR 전권)
- 선행본: `gov-command-collaboration-cycle3-false-report-2026-07-28.md` (자기신고 Gap ~40%, tsc/vitest/DB 전부 미실행)

본 문서는 선행본이 **실행하지 못한 검증을 실제로 수행**하고, 그 과정에서 발견한 오류를 정정한다.

---

## 1. 지시문 수치 자체가 STALE

| 항목 | 지시문 | 라이브 실측 | 근거 |
|---|---|---|---|
| score | 75 | **83.4** | `GET /api/teams/scores` |
| completion | 77.8% | **87.5%** | 동일 |
| n | 9 | **8** | 동일 |

자가개선팀의 `PROVIDER_AUTH_EXCLUSION`은 **이미 커밋(`4bccaf6`)되고 재기동(`d1a23ce`)되어 라이브 반영 완료**다.
선행 메모리 `project_gov_command_collaboration_cycle3_rootcause_provider_auth`의 "미커밋" 기술은 현재 시점 기준 **stale** — 아래 §5에서 갱신.

---

## 2. False Report 교차검증

| # | 주장 | 검증 방법 (T1) | 판정 |
|---|---|---|---|
| 1 | hermes Tool Escape (텍스트-only인데 codex 실행) | `config/ai-providers.json` hermes.`command`=`codex` = 설계값 | **허위** (선행본 판정 유지) |
| 2 | score=75 근본원인 = `done:/status:` 재변환 루프 | 48h tasks 1217건 전량 리플레이 → 게이트 히트 **0건**. 히트는 2026-06-29~07-09에만 503건 | **허위 확정** — 표본 창에 사건이 0건이므로 점수 근본원인이 될 수 없음 |
| 3 | 선행본 "auto-audit 스트림 미주입" | `hourly_role_audits` CHECK 제약이 `subject_kind IN ('hr','self-improvement')`; 실제 subject는 `team_hr-director`/`org_nco-self` 뿐, mesh/collab 키워드 매칭 **0건** | **참** — 팀 전용 감사 스트림은 구조적으로 존재 불가 |
| 4 | 선행본이 나열한 소스 7파일 변경 | 파일 전량 존재 + 심볼(`isProtocolReconversionPrompt`, `protocol-echo`, `protocol_reconversion_blocked`) 실재, 워킹트리 clean = 커밋됨 | **참** (환각 아님) |
| 5 | 선행본 자기신고 "Gap ~40%, tsc/vitest 미실행" | 본 세션에서 실행: tsc 0 / 609 pass / build 0 | **참했고, 이번에 해소** |
| 6 | 가드 헤더 주석의 cycle1 근거<br>"동일 본문 60초 내 최대 **72회**", "동일 채널 분당 최대 **41건**" | `mesh_messages` 직접 집계: 동일 (from,to,content,초) 최대 **2회**; 채널 분당 최대 **65건** | **부분 허위** — 72회는 현 DB에서 재현 불가(0), 41건은 실제 65건으로 과소. §4 참조 |

**보고서 신뢰도 등급: A−**
- A− 사유: 모든 판정이 T1(SQLite 행·실제 함수 리플레이·명령 출력·dist 내용). A 미만인 이유는 주장 #6의 cycle1 원본 관측을 재현할 수 없어(당시 데이터 보존 여부 불명) "허위"인지 "데이터 소실"인지 단정하지 못함.

### 2-1. 본 세션에서 발견한 **자체 오류** (정정)

첫 리플레이는 `created_at`(이미 ISO `...Z`)에 `+ 'Z'`를 덧붙여 `Date.parse` → `NaN`을 만들었고, 그 결과 슬라이딩 윈도가 통째로 무력화되어 **모든 설정에서 일률적으로 "차단 0건"** 이 나왔다. 세 counterfactual이 전부 동일한 0이라는 부자연스러움에서 발견해 파서를 수정했다. 수정 후 실제 수치는 **844건 차단(27.97%)** 이다.
→ 교훈: "차단 0건"을 안전 신호로 보고했다면 그 자체가 False Report였다.

---

## 3. GATE-COLLAB-C3-R1 (intake) — 검증만, 코드 diff 0

실제 게이트 판정 함수를 import 해 `tasks` 전량 리플레이:

| 범위 | 스캔 | 차단 |
|---|---|---|
| 48h 전체 | 1217 | **0** |
| 48h 본 팀 | 11 | **0** |
| 전기간 | 16226 | 503 (`completed` 402 / `failed` 87 / `cancelled` 10 / `lease_expired` 4) |

- 503건 **전부 `mode=task`** → 게이트가 앉은 intake 경로가 맞다 (배치 정확).
- 히트 분포: 2026-06-29 ~ **2026-07-09**, 이후 **신규 0건**.
- 결론: 병리는 실재했으나 **이미 멎었다**. 게이트는 방어적 백스톱이며 현재 점수에 기여하지 않는다. 임계값·조건 **변경 없음(diff 0)** — 근거 없는 튜닝을 하지 않는다.

---

## 4. CB-COLLAB-C3-R3 (신규) — 볼륨 룰이 라이브 트래픽 28%를 오탐 차단

### 발견
48h `mesh_messages` 3018건을 **실제 `CollaborationLoopGuard`에 시간순으로 투입**한 결과:

| 설정 | 차단 | 비율 | 내역 |
|---|---|---|---|
| 현행(shipped) | **844** | **27.97%** | channel-burst 474 + echo-loop 370 |

차단된 샘플은 루프가 아니라 **정상 태스크 완료 통지**였다:
```
nco-system->unknown             :: ❌ [task] codex 완료 (0.4s)
nco-system->work-report-scheduler :: ❌ [task] codex 완료 (13.1s)
```
가드는 `src/core/cli-mesh.ts:406`에 **실제로 배선**되어 있으므로 이는 이론상 위험이 아니라 **실제 메시지 유실**이었다.

**근본원인**: `echo-loop`/`channel-burst`는 협업 피어 간 에코 루프용인데, `nco-system`은 단방향 통지원이다. 병렬 태스크가 동시 완료되면 정상적으로 60초에 20건을 넘겨 burst가 트립한다. 차단 844건 중 실제 루프 **0건**.

### 조치 (bounded · reversible)
`notifierSenders`(기본 `['nco-system']`) 발신자는 **볼륨 룰만** 면제. 임계값은 **하나도 바꾸지 않았다** — 적용 *범위*만 좁혔다.
**불변식**: `protocol-echo`는 발신자와 무관하게 계속 적용 (프로토콜 에코 루프가 원래 표적이므로 보호 유지).

| 채널군 | 메시지 | 변경 전 차단 | 변경 후 차단 |
|---|---|---|---|
| `->unknown` (catch-all sink) | 2907 | 837 | **0** |
| 실명 채널 | 111 | 7 | **0** |

롤백 실증: `NCO_MESH_LOOP_GUARD_NOTIFIERS=off` → 정확히 **837/7 복원**.

### 받아들인 트레이드오프 (숨기지 않음)
48h 트래픽의 **99.97%(3017/3018)** 가 `from_session='nco-system'`이다. 따라서 볼륨 룰은 현재 트래픽 대부분에 대해 **사실상 휴면**이 된다.
- 정당화: 차단 844건이 전부 오탐 → 현 볼륨 룰의 보호가치 0, 피해 27.97%.
- **잔여 위험**: `nco-system`이 실제 폭주하면 볼륨 룰이 잡지 못한다. 통지원 전용 rate-limit은 **별도 과제로 남김(본 사이클 미구현)**.

### Command Gate (shell)
프로토콜 재변환·mesh 루프와 무관 → **diff 0**. 날조 룰 추가하지 않음.

---

## 5. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/security/collaboration-loop-guard.ts` | `DEFAULT_NOTIFIER_SENDERS`·`channelSender()`·`getNotifierSenders()` 추가, `volumeExempt` 2개 분기 (+49) |
| `src/security/collaboration-loop-guard.test.ts` | 면제·과잉면제방지·protocol-echo 유지·env 롤백·파서 회귀 5건 (+63) |
| `data/error-prevention/gov-command-collaboration-cycle3-cb-gate-update-2026-07-28.json` | 갱신된 CB/Gate 설정 산출물 |
| `data/error-prevention/gov-command-collaboration-cycle3-false-report-verification-2026-07-28.md` | 본 보고서 |
| `data/error-prevention/_c3-*.mts` (5) | 재현 가능한 실측 프로브 |

`src/core/team-scorer.ts` 등 점수 경로 **미변경** — 본 CB 변경은 mesh 전달 경로 전용, 점수 diff 0.

---

## 6. 검증 영수증

- **[변경]** `src/security/collaboration-loop-guard.ts` (+49), `collaboration-loop-guard.test.ts` (+63), 산출물 2건 + 프로브 5건
- **[검증방법]**
  - `npx tsc --noEmit` → **exit 0, error TS 0건**
  - `npx vitest run src/` → **98 files, 609/609 passed**
  - `collaboration-loop-guard.test.ts` 개별 verbose → **19/19** (14→19, 신규 5건 개별 통과 확인)
  - `npm run build` → **exit 0**, `dist/security/collaboration-loop-guard.js`에 `volumeExempt` 반영 확인
  - 실데이터 리플레이 844→0, `NCO_MESH_LOOP_GUARD_NOTIFIERS=off` 롤백 시 837/7 정확 복원
  - 라이브 점수 `GET /api/teams/scores` → 83.4/B/87.5%/n=8
  - `hourly_role_audits` 스키마 CHECK + subject 집계 + 키워드 매칭 0건
- **[등급]** **T1** — SQLite 행 직접 조회, 실제 가드/게이트 함수 리플레이, 명령 exit·출력, dist 파일 내용, HTTP 응답 본문
- **[Gap]** 92% — CB 오탐(844건) 해소·게이트 실측 완료·False Report 6건 판정 완료. 미달분: 주장 #6의 cycle1 원본 관측 재현 불가, 통지원 전용 rate-limit 미구현
- **[미검증항목]**
  - 주장 #6 "72회/41건"의 cycle1 당시 원본 — 현 DB에서 재현 불가(허위 vs 데이터 소실 미판별)
  - **미커밋** (워킹트리). 커밋 여부는 지시 대기
  - 라이브 프로세스는 **재기동 전** — dist는 갱신됐으나 실행 중 nco-backend는 아직 구버전 가드를 서빙 중 (pm2 재기동 필요, 본 세션 미실행)
  - 통합 테스트(`tests/*`, 서버 기동 필요) 미실행
  - `nco-system` 실제 폭주 시나리오는 관측 데이터 없음

## 되돌리기
```bash
NCO_MESH_LOOP_GUARD_NOTIFIERS=off   # 면제만 해제 (cycle1 동작)
NCO_MESH_COLLAB_LOOP_GUARD=off      # 가드 전체 우회
NCO_PROTOCOL_RECONVERSION_GATE=off  # intake 게이트 해제
git checkout src/security/collaboration-loop-guard.ts src/security/collaboration-loop-guard.test.ts
```
