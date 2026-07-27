# team_gov-assurance-audit 개선 노트 (Cycle 1/3)

## 1. 태스크 실행 이력 (최근 48h, 5건)

| Task ID | Status | Failure Reason (실패사유) | Evidence Tier (증거등급) |
|---|---|---|---|
| task_IDYxLFpEEiQhoMKz | running | N/A (미완료, 80% completion 원인) | 데이터 없음 (미제출) |
| task_TDsq55NUhMScwcCQ | failed | provider_unavailable / queue_wait_timeout | 데이터 없음 (실패) |
| task_7U-jEljr8bgs-1jI | failed | CLI failed exit=1 / queue_wait_timeout | 데이터 없음 (실패) |
| task_UatrcUS6U9HM64RL | completed | N/A (성공) | T1 (직접 확인) |
| task_sRYn25ipGFgIZOmc | completed | N/A (성공) | 데이터 없음 (보고서 없음) |

## 2. 근본원인 후보 3개 및 근거
1. **인프라/게이트웨이 오탐 (Infrastructure/Gateway False Positive)**
   - 근거: `task_TDsq55NUhMScwcCQ`, `task_7U-jEljr8bgs-1jI` 에러 로그에 `provider_unavailable: claude-code` 및 `queue_wait_timeout: provider claude-code busy for 1800000ms` 기록. (팀 실패가 아닌 시스템 가용성 문제)
2. **프롬프트 형식 불일치 (PromptGate 누락 필드 감점)**
   - 근거: `task_7U-jEljr8bgs-1jI`, `task_UatrcUS6U9HM64RL`, `task_sRYn25ipGFgIZOmc`의 metadata 내 `promptGate` 정보에서 `"score": 0` 및 `"missing": ["컨텍스트", "목표", "제약", "출력형식", "검증기준"]` 발견.
3. **업무 보고서(Work Report) 및 증거등급 누락**
   - 근거: `task_sRYn25ipGFgIZOmc`는 `completed` 상태이나, 연결된 `workReportId`가 없어 증거등급 표기 및 실제 검증 기록이 유실됨.

## 3. 기존 오탐 패턴 매칭 여부
- 기존 `team-gov-assurance-redteam-cycle3-minimum-sample-20260726.md`의 `computeVolume log10(n)` 감점 패턴과 대조 결과, 미완료 건(running 1건)으로 인해 completion이 80%로 떨어졌으며 75.7점의 득점은 promptGate 필드 누락(score: 0)과 인프라/게이트웨이 오탐에 의한 강제 실패가 복합 작용한 결과임.
- 이는 실제 업무 수행 실패가 아니라 인프라 지연(queue_wait_timeout) 및 제어면 오탐 재발에 해당하므로 **재작업 금지**.

## 4. Mem0 / 지식베이스 재발방지 요약
```json
{
  "key": "team_gov-assurance-audit_false_positive",
  "summary": "1. promptGate 필수 5필드 누락으로 score 0 감점\n2. queue_wait_timeout 등 제어면 오류로 인한 태스크 강제 실패\n3. completed 상태이나 workReport 누락으로 증거등급 미표기\n4. 인프라 오류로 인한 감점은 오탐으로 간주하여 재작업 금지\n5. 프롬프트 전송 시 필수 필드 강제화 검증 로직 도입 필요"
}
```
