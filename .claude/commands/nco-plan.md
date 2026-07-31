# 새 Plan을 생성합니다. 토론 결과를 기반으로 자동 태스크 분해 + docs/plans/ 마크다운 파일을 생성합니다.
# $ARGUMENTS를 Plan 제목으로 사용합니다.
# 형식: /nco-plan <Plan 제목>

# 1. 먼저 /nco-discussion으로 주제를 토론한다.
# 2. 토론 결과를 기반으로 Plan을 생성한다:
# 3. 생성된 Plan의 docs/plans/<slug>.md 파일에 태스크 체크박스를 추가한다.
# 4. Stop Hook이 이 파일을 읽어 gap 분석에 반영한다.
#
# 2026-07-29 수정 2건:
#  (a) 3·4 항이 주석이 아닌 맨 텍스트라 런타임에 `3.: command not found` 로 실행됐다.
#  (b) 제목을 문자열 보간으로 JSON 에 넣어 " 나 \ 가 들어가면 JSON 이 깨졌다.
#      jq 로 안전하게 인코딩하고, 빈 인자 가드도 추가한다.

if [ -z "$ARGUMENTS" ]; then
  echo "사용법: /nco-plan <Plan 제목>"
  exit 1
fi

jq -n --arg title "$ARGUMENTS" '{"title":$title}' \
  | curl -s -X POST http://localhost:6200/api/plan/create \
      -H "Content-Type: application/json" \
      --data-binary @- \
  | python3 -m json.tool
