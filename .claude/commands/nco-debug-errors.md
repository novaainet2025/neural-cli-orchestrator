# AI 합의 투표 — 여러 AI가 투표로 최적 답안을 결정합니다.
# 사용법: /nco-consensus <질문 또는 설계 결정>
# 예: /nco-consensus "Redis vs PostgreSQL for session storage?"

PROMPT="$ARGUMENTS"
if [ -z "$PROMPT" ]; then
  echo "[오류] 합의할 내용을 입력하세요."
  echo "예: /nco-consensus \"아키텍처 A vs B 중 어느 것이 더 좋은가?\""
  exit 1
fi

curl -s -X POST http://localhost:6200/api/realtime/consensus \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": $(echo "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'), \"providers\": [\"opencode\",\"gemini\",\"cursor-agent\"]}" \
  | python3 -m json.tool 2>/dev/null || echo "[오류] NCO 서버 응답 없음 — /nco-start 로 NCO를 먼저 시작하세요."
)

by = e.get('by_type', {})
if by:
    print()
    print('  유형별 집계:')
    for k, v in sorted(by.items(), key=lambda x: -x[1]):
        icon = {'context_overflow':'↔','connection_refused':'⚡','cuda_oom':'💾',
                'timeout':'⏱','http_5xx':'🔴','http_4xx':'🟡','json_parse':'⚠'}.get(k,'◉')
        print(f'    {icon} {k}: {v}회')

recent = e.get('recent', [])
if recent:
    print()
    print(f'  최근 {len(recent)}개 에러:')
    for err in recent:
        mark = '✓' if err.get('recovered') else '✗'
        print(f\"    [{err['time']}] {mark} [{err['type']}]\")
        print(f\"              {err['msg']}\")
else:
    print()
    print('  (최근 에러 없음)')
" 2>/dev/null
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
