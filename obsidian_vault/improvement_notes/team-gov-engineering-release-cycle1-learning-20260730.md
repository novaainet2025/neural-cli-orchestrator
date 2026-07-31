# team_gov-engineering-release — cycle 1 학습 노트

tags: #nco/improvement #gov-engineering-release #cycle1 #mem0-candidate

## 패턴 요약

- **관찰:** codex가 Integration and Release 일일 태스크에서 “STOP/HOLD” 텍스트만
  완료한다. 7d 집계는 55–73% 완료로 보이나 HR 48h scorer는 completion=0%.
- **분류:** (1) 플릿 감사 게이트 아티팩트 (2) 릴리스 헌장 준수 vs HR 완료 정의 불일치.
- **재발 신호:** `score < 10` && `completion = 0` && `n >= 2` → 먼저
  `AUDIT_APPROVED_COMPLETION` 의심.

## 에이전트별 힌트

| agent | 관찰 | 권장 |
|---|---|---|
| codex | 관찰·보류 보고 완료, 빌드 미실행 | HOLD 시에도 `audit-pipeline-health` 1회 실행을 [검증기준]에 명시 |
| cursor-agent | 24h 실패 건수 변동 큼 | 릴리스 차단 근거로 쓰기 전 task id 연결 필수 |
| ollama | 검증·회귀 후보 | cycle2에서 `verify.sh` 위임 |

## Mem0 후보

> Integration and Release 팀 HR score 6.1/0%는 2026-07-30 기준 감사 영수증 게이트
> 미배선으로 인한 플릿 붕괴 가능성이 높다. 팀 일일 산출물은 정상적으로 HOLD를
> 보고하나 T1 통합 증거는 없다.

## 다음 사이클

1. 48h 실패 4건 task id·error DB 덤프
2. AP-4 > 0 또는 스코어러 완화 배포 후 score 재측정
3. HOLD 보고서 + 최소 1개 기계 검증 출력 병행
