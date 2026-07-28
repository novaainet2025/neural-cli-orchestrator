#!/usr/bin/env bash
curl -s -X POST http://localhost:6200/api/mem0 -H "Content-Type: application/json" -d '{
  "text": "[고품질 검수팀 (team_content-quality) 개선] 완료율 하락 및 FAIL(보류) 응답의 근본 원인은 team-runner.sh가 원문 페이로드 없이 정기적으로 검수 게이트를 호출한 오동작임. DB charter에 @전담러너를 추가하여 team-runner의 스케줄링 대상에서 제외함으로써, 빈 페이로드 검수 요청을 차단하고 이벤트 기반(daily-blog-promo 등)으로만 작동하도록 수정함."
}'
