#!/bin/bash
set -euo pipefail

# 1) 성과보고서 목표설정 (Goal Setting)
echo "POST /api/goals"
curl -s -X POST http://localhost:6200/api/goals \
  -H "Content-Type: application/json" \
  -d '{
    "subjectKind": "team",
    "subjectId": "team_self-learning",
    "period": "daily",
    "periodKey": "2026-07-23",
    "title": "자가학습팀 일일 성과 개선 및 효율성 향상",
    "direction": "increase",
    "targetValue": 5,
    "unit": "%"
  }' \
  -w "\n%{http_code}\n" | tail -n 1

# 2) 성과보고 (Performance Report)
echo "POST /api/performance/reports"
curl -s -X POST http://localhost:6200/api/performance/reports \
  -H "Content-Type: application/json" \
  -d '{
    "subjectId": "team_self-learning",
    "period": "daily",
    "periodKey": "2026-07-23",
    "reflection": "일부 학습 알고리즘 연산 지연으로 목표 2% 미달 발생. 병목 구간 로깅 미흡.",
    "improvement": "병목 구간 상세 로깅 추가 및 동시성 처리 로직 최적화 적용."
  }' \
  -w "\n%{http_code}\n" | tail -n 1
