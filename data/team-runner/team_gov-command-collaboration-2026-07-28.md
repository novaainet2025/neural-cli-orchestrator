# Collaboration Mesh and Protocol — 일일 산출물 (2026-07-28, ai=claude-code, taskId=task_kEK9y3-dIjcFDH9d)

# Collaboration Mesh & Protocol — 분석 보고서 (2026-07-28)

## (1) 오늘 관찰·분석

| 항목 | 값 | 출처 | 등급 |
|---|---|---|---|
| 팀 완료율 7일 | 60.0% (10/6/4/0) | `/api/teams` | T1 |
| work_reports 7일 | 3건 제출 | `[work_reports]` | T1 |
| claude-code 성공률 | 19% (2307 tasks, 24h실패=79) | `/api/agents` | T1 |
| cursor-agent 성공률 | 95% (3588 tasks, 24h실패=23) | `/api/agents` | T1 |
| ollama 성공률 | 76% (1007 tasks, 24h실패=1) | `/api/agents` | T1 |
| hermes 성공률 | 57% (2176 tasks, 24h실패=3) | `/api/agents` | T1 |
| retired-provider 성공률 | 78% (558 tasks, 24h실패=2) | `/api/agents` | T1 |

**Missing data (미확인):**
- handoff 패킷 설계 문서: 미확인
- 파일 lease 시스템 구현/동작 여부: 미확인
- 메시지 프로토콜(`done:/status:/error:/question:`) 위반 감사: 미확인
- 의사결정 로그 저장소 존재 여부: 미확인
- 충돌 해결 프로세스 기록: 미확인
- opencode/codex/agy/higgsfield의 `/api/agents` 통계: **제공되지 않음** (헤더의 상태 문자열만 T4)
- 실패 4개 태스크의 구체적 원인: **제공되지 않음** (확인 위해 `GET /api/tasks?status=failed` 필요)
- work_reports 3건의 내용: **제공되지 않음** (확인 위해 `GET /api/work_reports` 필요)

## (2) 현재 상태

- **Agent 가용성**: 5/9 에이전트 통계 확인됨. claude-code(19%)와 hermes(57%)는 성공률이 낮아 주의 대상. cursor-agent(95%)는 안정적.
- **작업 파이프라인**: 팀 60% 완료율, 진행 중인 태스크 0건. opencode와 codex가 현재 `working` 중이나 `/api/agents` 통계는 없음 → 해당 에이전트가 NCO API에 heartbeat를 보고하지 않거나 `/api/agents` 엔드포인트가 특정 에이전트를 누락.
- **claude-code 위험**: 24시간 실패 79건, 성공률 19% — 심각한 성능 저하. task 수(2307) 대비 실패 편중.
- **work_reports**: 7일간 3건 제출 — 팀 10개 태스크 대비 보고율 30%. 7건 미보고.

## (3) 다음 필요 작업 제안

1. **`GET /api/tasks?status=failed`** — 실패 4건의 구체적 원인 수집. claude-code 24h실패 79건과의 차이 확인.
2. **`GET /api/work_reports`** — 3건 보고서 내용 분석. 누락 7건 태스크 ID 식별.
3. **opencode/codex agent 통계 확인** — 헤더에는 `working` 상태이나 `/api/agents`에 데이터 없음. heartbeat 누락 또는 엔드포인트 필터 문제 진단.
4. **claude-code 평가 중단 고려**: 성공률 19% 리소스 낭비. 원인 분석 후 일시 제외 또는 설정 재조정.
5. **handoff 패킷·lease·메시지 규약·의사결정 로그·충돌 해결 문서** — 모두 미확인. 우선순위를 정해 설계·구현 필요. 첫 단계로 handoff 프로토콜 스키마 정의(JSON schema)와 lease 메커니즘(파일 경로+TTL+소유자) 문서화 제안.

[Evidence Tier: T1 (주입 실데이터 직접 인용) / Unverified: handoff/lease/의사결정로그/opencode+codex 통계(데이터 미제공) — `GET /api/agents?names=opencode,codex` 호출로 해소 가능]
