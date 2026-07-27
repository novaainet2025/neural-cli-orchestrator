# team_hr-incubator-2026-w30 — Improvement cycle 2/3 독립 검증 (자가개선팀)

- 일시: 2026-07-28
- 대상: `team_hr-incubator-2026-w30` (HR Incubator 2026-W30, org_knowledge-diet)
- 지시문 기준값: score=81.5, completion=85.7%, sample=48h/7
- 수행 역할: 자가개선팀 — 소스 개선 검증 + **빌드/배포 자동화 검증**
- 소스 변경: **없음 (src/ diff 0줄)**. 본 사이클의 코드픽스는 선행 단계가 이미 구현·커밋함(HEAD `a8c285a`).

## 1. 지시문 수치는 pre-fix stale 값임 (T1)

`computeTeamScores()`를 HEAD 소스로 직접 실행:

| 조건 | score | grade | completion | n | maxN |
|---|---|---|---|---|---|
| 기본 (exclusion ON) | **94.0** | A | **100%** | 6 | 89 |
| `NCO_SCORER_PROVIDER_AUTH_EXCLUSION=off` | **81.5** | B | **85.7%** | 7 | 90 |

토글 OFF 값이 지시문 기준값(81.5 / 85.7% / n=7)과 **정확히 일치** → 지시문 수치는 수정 전 상태.
롤백 토글이 실제로 동작함도 같은 실행으로 확인됨.

## 2. 근본원인 태스크 (T1, DB 행)

```
task_VnTZtkgkcpgPwPhy | claude-code | failed | progress=0
error    = 'subprocess exited with code 1: Invalid API key · Fix external API key'
response = 39자 ('Invalid API key · Fix external API key\n')
result_json = 없음
```
48h 창 계상분 7건 중 유일한 실패. 나머지 실패 2건(`queue_wait_timeout: provider claude-code busy for 1800000ms`)은 기존 규칙으로 이미 제외됨.

## 3. 과잉제외 회귀 감사 — 선행 단계 미보고 항목 (T1)

신규 평문 절을 DB 전체에 직접 질의:

| 검사 | 결과 |
|---|---|
| [A] 절에 매칭되는 행 (status 가드 제외, DB 전체) | **1건** — `task_VnTZtkgkcpgPwPhy` 뿐 |
| [B] `error LIKE '%Invalid API key%'` 인데 매칭 안 된 행 | **0건** (억울하게 계상되는 행 없음) |
| [C] 매칭되는 `status='completed'` 행 | **0건** → completion>100% 회귀 없음 |

안전 불변식 유지 확인. 팀 편향 없음(대상 1건이 곧 해당 팀이나, 동일 오류 형식 자체가 DB에 1건뿐).

## 4. 잔여 6.0점 분해 — 추가 코드 수정 불필요 (T1)

`score = 0.9 × completion + 0.1 × volume`, `volume = 100·log10(n)/log10(maxN)`

```
0.9×100 + 0.1×(100·log10(6)/log10(89)) = 90 + 3.99 = 93.99 → round1 = 94.0  ✓ 실측 일치
```

completion은 이미 **100%로 상한**. 잔여 6.0점은 전량 volume 항(n=6 vs 함대 maxN=89)이며,
이는 팀 처리량 함수이지 결함이 아니다. 스코어러를 더 손대는 것은 지표 조작에 해당하므로 **무변경**.
(기존 `*_score90_volume_formula` 메모 계열과 동일 구조.)

## 5. ⚠ 실제 잔여 블로커 — 배포 갭 (T1, 본 사이클 신규 발견)

코드는 고쳐졌으나 **라이브 NCO가 수정 전 빌드를 서빙 중**:

| 경로 | score | completion | n |
|---|---|---|---|
| HEAD 소스 in-process | 94.0 / A | 100% | 6 |
| **라이브 `GET /api/teams/scores`** | **81.4 / B** | **85.7%** | **7** |

원인: pm2 `nco-backend` pid=10569 기동 **02:46**, 수정 커밋 `a8c285a` **04:39:24** → 구 모듈이 메모리에 적재됨.
(라이브 81.4 vs 로컬 81.5 차이는 maxN 91 vs 89 드리프트로 설명됨 — 동일 상태.)

파급: HR lifecycle 프로파일이 stale 값을 계속 기록 중.
```
last_score = 81.5, last_sample_size = 7
last_checked_at = 2026-07-27T19:40:00Z, consecutive_low_checks = 16
retired_at = (없음), status = probation
```
→ 재기동 전까지 `consecutive_low_checks`가 고쳐진 뒤에도 계속 증가.

### 권고 조치 (미실행 — 승인 필요)
```bash
npx pm2 restart nco-backend      # 되돌리기: npx pm2 restart nco-backend (재기동만으로 원복)
```
**본 세션에서 실행하지 않은 이유**: 현재 `running` 태스크 5건 + `active_run_id` 보유 팀 4개가 존재.
재기동은 단일 팀 범위를 넘는 함대 전역 side effect이며, 타 세션의 진행 중 개선 런을 중단시킬 수 있음.
(파급 자체는 bounded — orphan 태스크는 부팅 시 복구되고 `INFRA_EXCLUSION`으로 점수에서 제외됨.)

## 6. 게이트 (T1, 본 세션 직접 실행)

| 게이트 | 결과 |
|---|---|
| `vitest run src/core/team-scorer.test.ts` | **10 passed / 10**, exit 0 |
| `tsc --noEmit` | **exit 0** |
| `tsc -p tsconfig.json --outDir dist` | **exit 0** |

## 7. Gap / 미검증

- Gap: 코드·스코어러 측면 100% (설계 목표 90점 대비 94.0 달성). 배포 반영은 0% — §5 재기동 대기.
- 미검증: 재기동 후 라이브 API가 94.0을 반환하는지 (재기동 미실행이므로 사후 확인 필요).
- 미검증: 전체 테스트 스위트. 범위 밖 기존 실패가 있어 대상 파일만 실행함.
- 부수효과: `dist/`를 빌드 게이트 실행으로 재생성함(gitignore 대상, 실행 중 프로세스 동작에는 영향 없음).
- lifecycle 무변경: `is_active=1`, `retired_at` 공란 유지. 상태 변경·은퇴 판단은 HR 소유로 미개입.
