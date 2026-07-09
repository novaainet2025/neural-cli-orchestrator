# NCO Full Workflow Pipeline — 사용자 요청 전체 자동 실행
# 분석 → 라우팅 → NCO 실행 → 품질 점수 → 자동 보고서 (루프백 포함)
# $ARGUMENTS를 작업 설명으로 사용합니다.
# 형식: /nco-workflow-full <작업 설명>
# 예: /nco-workflow-full 로그인 버그 수정하고 테스트 통과시켜줘
# 예: /nco-workflow-full 처음부터 끝까지 API 엔드포인트 추가하고 검증해줘

---

## PHASE 0: 사전 검증

```bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/nova-ai/project/nco}"
cd "$PROJECT_DIR"

echo "=== NCO Full Workflow Pipeline ==="
echo "Request: $ARGUMENTS"
echo ""

# NCO 서버 확인
if ! curl -sf http://localhost:6200/health >/dev/null 2>&1; then
  echo "✗ NCO 오프라인 — /nco-start 로 시작하세요"
  exit 1
fi
echo "✓ NCO online (:6200)"

# 스크립트 실행 권한
chmod +x scripts/workflow-score.sh scripts/auto-report.sh 2>/dev/null || true
```

---

## PHASE 1: TypeScript 파이프라인 실행

```bash
cd "$PROJECT_DIR"

npx tsx src/core/workflow-pipeline.ts "$ARGUMENTS" > /tmp/nco-workflow-full-last.json 2>/tmp/nco-workflow-full-last.err
PIPELINE_EXIT=$?
cat /tmp/nco-workflow-full-last.json 2>/dev/null | python3 -m json.tool 2>/dev/null || cat /tmp/nco-workflow-full-last.err
```

파이프라인 단계:
1. **analyze** — smartRouter로 mode/providers 결정
2. **execute** — NCO API 호출 (task/parallel/commander/full-pipeline 등)
3. **score** — `workflow-score.sh` 6차원 점수 (임계값 80)
4. **report** — `auto-report.sh`로 `docs/workflows/` 보고서 생성
5. **loop** — 80점 미달 시 최대 3회 재실행

---

## PHASE 2: 점수 상세 확인

```bash
bash scripts/workflow-score.sh "$PROJECT_DIR" --json --workflow-id "manual-$(date +%s)" 2>/dev/null \
  | python3 -m json.tool
```

점수 구성 (100점):
| 차원 | 배점 | 기준 |
|------|------|------|
| build | 25 | tsc/build 오류 |
| tests | 20 | npm test 통과 |
| nco_usage | 15 | 최근 NCO 태스크 활동 |
| plan | 15 | 플랜 체크리스트 완료율 |
| changes | 10 | git 변경 규모 |
| quality | 15 | 에이전트 출력 구조 |

---

## PHASE 3: 보고서 경로 출력

```bash
REPORT_PATH=$(python3 -c "
import json, sys
try:
    d = json.load(open('/tmp/nco-workflow-full-last.json'))
    print(d.get('reportPath', ''))
except:
    pass
" 2>/dev/null)

if [ -n "$REPORT_PATH" ] && [ -f "$REPORT_PATH" ]; then
  echo ""
  echo "✓ Report: $REPORT_PATH"
  head -40 "$REPORT_PATH"
else
  echo "보고서 생성 실패 — 수동 실행:"
  echo "  bash scripts/auto-report.sh --prompt \"$ARGUMENTS\" --score-json '{\"total\":0,\"passed\":false,\"threshold\":80,\"dimensions\":{}}'"
fi
```

---

## PHASE 4: Gemma 게이트 (선택)

```bash
if [ -f cli-installs/gemma-gate-check.sh ]; then
  bash cli-installs/gemma-gate-check.sh "$PROJECT_DIR" --no-plan 2>/dev/null || true
fi
```

---

## 사용 예시

```bash
# 전체 파이프라인
/nco-workflow-full 처음부터 끝까지 사용자 인증 API 구현하고 테스트해줘

# 점수만 (실행 스킵)
npx tsx src/core/workflow-pipeline.ts "점수만 확인" --skip-execution

# 플랜 연동
npx tsx src/core/workflow-pipeline.ts "플랜 실행" --plan docs/plans/test.md
```
