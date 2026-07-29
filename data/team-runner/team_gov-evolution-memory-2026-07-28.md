# Knowledge and Memory Stewardship — 일일 산출물 (2026-07-28, ai=claude-code, taskId=task_xb2JxRA0d2WYwnc-)

# Knowledge and Memory Stewardship Report — 2026-07-28

## (1) 오늘 관찰·분석

**데이터 가용성 (주입된 실데이터 기준):**
- `[tasks]` 최근 7일 — 전체=5, 완료=5, 실패=0, 진행=0, 완료율=100.0% — [Evidence Tier 3: 주입된 상태 문자열] ✅ 사용 가능
- `[work_reports]` 최근 7일 — submitted=3 — [Evidence Tier 3] ✅ 사용 가능
- `[/api/teams]` 팀 태스크 누계 — 전체=5, 완료=5, 실패=0, 진행=0, 대기=0, 완료율=100.0% — [Evidence Tier 3] ✅ 사용 가능
- `[/api/agents]` 5개 에이전트 상태 — [Evidence Tier 3] ✅ 사용 가능
- cursor-agent, agy, higgsfield, retired-provider: **데이터 없음** — `/api/agents`에 해당 에이전트 행이 실데이터로 주입되지 않음 → 미확인

**주요 관찰:**
1. **claude-code 위험 신호**: 태스크=2300, 성공률=19%, 24시간실패=73 — 전체 태스크의 37.7%를 차지하나 성공률이 극히 낮고 실패 집중도가 높음 (73/2,300=3.17% 단순비지만 24시간에 73건 실패는 운영상 심각). 상태=error.
2. **codex 생산성 리더**: 태스크=2519, 성공률=92%, 24시간실패=4 — 가장 높은 처리량과 성공률. 나머지 4개 에이전트 합계(2519+1420+998+2173=7110)의 35.4%를 단독 처리.
3. **opencode 성공률 저조**: 태스크=1420, 성공률=28%, 24시간실패=8 — codex(92%) 대비 1/3 수준. 설계/아키텍처 전문 에이전트이나 성공률 낮음.
4. **hermes 처리량 대비 성공률**: 태스크=2173, 성공률=57% — 중간 수준. 24시간실패=2로 안정적.
5. **팀 완료율 100%** (전체=5)와 **개별 에이전트 누계** 간 불일치: `/api/teams`는 "최근 7일 팀 태스크=5"인데 각 에이전트 개별 태스크는 998~2519. 이는 `/api/teams`가 특정 태스크 유형/범위만 집계하거나, 에이전트 개별 통계가 전체 기간 누적인 것으로 추정 — **직접 확인 불가, 스키마 문서 필요**.

**장기 기억 상충 검토:**
- 이전 task_TRmtenu0XE09r7zo (2026-07-24) 당시 `[tasks] 최근 7일: 전체=2, 완료=2` → 현재는 전체=5, 완료=5 (3건 증가). 추세 양호.
- task_sHeD0PEUWjcptlZR (2026-07-28, 오늘) Governance Officer 보고가 먼저 작성됨 → 해당 보고가 어떤 액션을 제안했는지 주입되지 않음 → 중복/상충 판단 불가.

## (2) 현재 상태

| 항목 | 상태 | 근거 등급 |
|------|------|-----------|
| 팀 태스크 7일 완료율 | 100% (5/5) | T3 (주입 문자열) |
| 팀 활동성 | work_reports=3건 | T3 |
| 지식 저장소 신선도 | 미확인 | 데이터 없음 |
| 지식 중복 현황 | 미확인 | 데이터 없음 |
| provenance 메타데이터 | 미확인 | 데이터 없음 |
| 보존/삭제 정책 이행률 | 미확인 | 데이터 없음 |
| claude-code 운영 상태 | error, 24h실패=73 | T3 — **경고 필요** |
| codex·opencode·ollama·hermes 운영 상태 | 모두 working | T3 |

## (3) 다음에 필요한 작업 제안

**T1 확인 필요 항목 (도구/커맨드 실행 가능할 때):**
1. `curl -s localhost:6200/api/agents | jq` — 4개 누락 에이전트(cursor-agent, agy, higgsfield, retired-provider) 상태 수집
2. `sqlite3 data/nco.db "SELECT COUNT(*), type FROM memories GROUP BY type"` — 지식 저장소 테이블 스키마 및 레코드 수 확인
3. `cat db/migrations/*.sql | grep -i "memory\|knowledge\|artifact"` — 저장소 마이그레이션 현황
4. `ls -la .claude/memory_backups/ 2>/dev/null || echo "no backup dir"` — 백업 정책 존재 여부 확인

**제안 액션 (정책 수립):**
- **claude-code 제한/격리**: 24시간 73건 실패, 성공률 19%. 태스크 배정을 단순 검증·조회로 제한하고 codex/opencode 경유로 우회 위임. opencode 설계 후 codex 구현 루트를 기본 경로로.
- **지식 만료 정책 도입**: 현재 `work_reports=3`이 7일간의 지식 업데이트량. 모든 장기 기억 항목에 `created_at`, `provenance`(출처 agent/태스크ID), `evidence_tier`, `freshness_ttl_days` 필드 추가 제안.
- **중복 제거 스캔**: 5개 장기 기억 컨텍스트 중 Dynamic Browser Implementation이 2개(2026-07-24, 2026-07-26) — 병합 또는 최신 유지·구버전 아카이브 필요.
- **Knowledge Graph 연동**: gbrain MCP가 설치되어 있다면 `gbrain search "schema:knowledge"`로 기존 지식 그래프와 정책 정합성 확인.

**미확인/잔여 항목:**
- 지식 저장소의 물리적 위치(schema, file path) — 미확인
- Provenance 추적 시스템 존재 여부 — 미확인
- 삭제 정책(soft-delete/ hard-delete/ TTL) — 미확인
- 백업·복구 절차 존재 여부 — 미확인
- 보안·비밀정보 필터링 정책 — 미확인
- 4개 에이전트(cursor-agent, agy, higgsfield, retired-provider) 상세 상태 — 미확인
- `/api/teams`와 개별 에이전트 태스크 수 불일치 원인 — 미확인 (스키마 문서 필요)
