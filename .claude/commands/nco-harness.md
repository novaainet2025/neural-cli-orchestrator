# NCO Harness — 자율 100% 완료 실행 루프
# 요구사항을 받아 Gap분석→Plan→Commander 4-Layer→Triple Verification→품질점수(95점+) 루프
# 평균 점수 95점 이상이 될 때까지 최대 5회 반복 자동 실행
# $ARGUMENTS를 requirement로 사용합니다.
# 형식: /nco-harness <요구사항>

curl -s -X POST http://localhost:6200/api/harness \
  -H "Content-Type: application/json" \
  -d "{\"requirement\":\"$ARGUMENTS\",\"maxIterations\":5,\"scoreThreshold\":95}" | python3 -m json.tool
