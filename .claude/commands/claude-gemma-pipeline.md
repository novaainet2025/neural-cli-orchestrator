# claude-gemma 전 구간 워크플로 (선택 참고용)

**기본 규칙은 슬래시 명령 없이 자동 적용된다** (`UserPromptSubmit` 훅 + `CLAUDE.md`). 이 파일은 단계·템플릿이 필요할 때만 연다.

`ANTHROPIC_BASE_URL=http://localhost:4100` + Gemma MLX 사용 시 아래를 **추가로** 따를 수 있다.

## 원칙 (토큰)

1. **수치 검증은 LLM이 아니라 스크립트**: `bash cli-installs/gemma-gate-check.sh <프로젝트루트> [--plan <파일>] [--no-plan] [--json]`
2. **장문 리뷰 금지**: 단계별 출력은 아래 **고정 템플릿**만 사용 (각 ≤15줄).
3. **설계 난이도가 높을 때만** `~/.claude/settings.json`의 **advisor(최고 성능 모델)** 로 1회 `/advisor` — 이후 구현은 Gemma로 진행.
4. 체크리스트가 있는 작업은 반드시 **`--plan`** 으로 해당 md만 지정. 저장소 전체 `docs/plans/*.md`는 미완료가 많으면 점수가 깎이므로, **그 외 작업은 `--no-plan`** 으로 빌드만 게이트.

---

## 단계

### P0 — 인테이크 (한 번만)

- 목표 1문장 / 범위(포함·제외) / 완료 정의 3개 / 마일스톤 목록 (최대 5개).

### P1..Pn — 마일스톤 루프 (끝까지)

각 마일스톤마다:

1. **실행**: 코드·설정 변경.
2. **검수** (짧게, 템플릿 A).
3. **검증·갭**: 게이트 스크립트 실행 → `PASS_95=1` 될 때까지 수정 (동일 마일스톤 최대 **3회** 재시도).
4. 다음 마일스톤으로 진행.

### Pz — 최종 보고 (한 번만)

- 템플릿 B로만 작성.

---

## 템플릿 A — 마일스톤 검수 (복붙 후 채움)

```
Milestone: [id]
Changed: [파일 ≤5개, 경로만]
Risk: [낮음|중간|높음]
Self-check: [요구사항 대비 OK 3항]
gate: [gemma-gate-check 한 줄 결과 붙임, PASS_95=?]
```

---

## 템플릿 B — 최종 보고서

```
## 요약
- 요청: [1문장]
- 결과: [성공|부분성공|실패]

## 마일스톤
| # | 산출 | 게이트(PASS_95) |
|---|------|-----------------|
| 1 | … | … |

## 검증
- gemma-gate-check 최종: GATE_PCT=__, PASS_95=__

## 남은 갭 (있을 때만)
- [ ] …

## 토큰 절약 메모
- advisor 호출 횟수: [N]
- 불필요한 파일 전체 재읽기: [없음|있음]
```

---

## 필수 커맨드 예시

```bash
# NCO 백엔드만 수정 (기존 plans와 무관할 때)
bash cli-installs/gemma-gate-check.sh . --no-plan

# 특정 플랜만 추적
bash cli-installs/gemma-gate-check.sh . --plan docs/plans/현재작업.md
```

`PASS_95=0`이면 스크립트 출력의 `BUILD_SCORE` / `PLAN_SCORE`를 보고 **작은 수정부터** 반복한다.
