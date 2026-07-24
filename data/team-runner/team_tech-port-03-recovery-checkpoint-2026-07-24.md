# 03 Recovery Checkpoint — 일일 산출물 (2026-07-24, ai=opencode, taskId=task_S7J68DEZzFaBXtqJ)

# 2026-07-24 복구 체크포인트 (Stage 3) — 텍스트 전용

## (1) 관찰·분석

**데이터 가용성 (주입된 실데이터만 사용)**
| 항목 | 상태 | 값 | 출처 |
|------|------|-----|------|
| 작업 완료율 7일 | 확인됨 | 4/4 = 100% | `[tasks]` |
| 팀 태스크 누계 | 확인됨 | 4/4 = 100% | `[/api/teams]` |
| opencode 상태 | 확인됨 | idle, tasks=2034, 성공=73%, 24h실패=15 | `[/api/agents]` |
| codex 상태 | 확인됨 | idle, tasks=2333, 성공=94%, 24h실패=27 | `[/api/agents]` |
| cursor-agent 상태 | 확인됨 | idle, tasks=10891, 성공=98%, 24h실패=11 | `[/api/agents]` |
| dirty worktree 파일 | **미확인** | — | 읽기/명령 금지 |
| 현재 HEAD SHA | **미확인** | — | `git rev-parse HEAD` 필요 |
| DB 스키마 버전 | **미확인** | — | `ls db/migrations/` + DB 쿼리 필요 |
| SQLite 파일 경로 | **미확인** | — | `src/storage/` 추정 |
| Redis 키 상태 | **미확인** | — | `redis-cli KEYS *` 필요 |
| .env/config 백업 상태 | **미확인** | — | `ls config/` + `.env` 필요 |
| PM2 프로세스 상태 | **미확인** | — | `pm2 list` 필요 |

## (2) 현재 상태 (증거 기반)

- **에이전트 풀**: 모두 idle (opencode·codex·cursor-agent). gemini·aider·openclaw는 offline. 24h 실패율: opencode 73% (worst, 15 failures), cursor-agent 98% (best, 11 failures).
- **작업 파이프라인**: backlog 0, 진행 0. 최근 7일 태스크 4건 모두 완료. 팀 누계도 4/4 완료.
- **opencode 위험 신호**: 성공률 73%는 다른 에이전트(codex 94%, cursor 98%) 대비 현저히 낮음. 24h 실패 15회 — 이 에이전트가 생성한 변경이 dirty worktree 원인일 가능성 있음.

## (3) 복구 체크포인트 설계 (명령 실행 불가 — 아래는 다음 실행 시 수행할 플랜)

### Step A: Dirty Worktree 식별 및 보존
```bash
# 필요한 명령 (직접 실행 필요 — 추정, 미검증)
git status --porcelain          # 변경·추적파일·stash 식별
git diff --stat HEAD            # 수정 파일 목록
git stash list                  # 기존 stash 확인
```
보존 전략: dirty 파일을 `~/nco-checkpoint-20260724/`에 `cp --parents`로 복사 후 `git stash`로 working tree 정리(필요시).

### Step B: 기준점 기록
```bash
git rev-parse HEAD              # 복구 기준 SHA
git log --oneline -5            # 최근 5개 커밋 컨텍스트
# .env 백업
cp .env ~/nco-checkpoint-20260724/.env.backup
```

### Step C: DB 롤백 준비 (SQLite WAL)
```bash
ls db/migrations/               # 마이그레이션 파일 목록 (순서 확인)
sqlite3 data/nco.db .schema    # 현재 DB 스키마 덤프
sqlite3 data/nco.db .dump > ~/nco-checkpoint-20260724/db-dump.sql
```
역마이그레이션 명령: 없으면 최근 migration 파일 역순으로 `ALTER TABLE ... DROP COLUMN` 등 직접 작성 필요.

### Step D: 롤백 명령 (필요시)
```bash
# Git 롤백 (dirty 보존 후)
git checkout <known-good-SHA> -- src/ config/     # 특정 파일만 (reset 금지)

# DB 롤백 (가상 예시 — 실제 migration 이름 미확인)
npm run db:migrate:down          # or 직접 SQL
rm data/nco.db && sqlite3 data/nco.db < dump.sql  # 풀 리스토어
```

### Step E: 검증 체크리스트 (다음 실행 시)
| # | 항목 | 검증 방법 | Evidence Tier |
|---|------|-----------|---------------|
| 1 | HEAD SHA 기록 | `git rev-parse HEAD` 출력 캡처 | T1 |
| 2 | dirty worktree 보존 | `ls ~/nco-checkpoint-20260724/` | T1 |
| 3 | .env 백업 존재 | 파일 크기 `stat` | T1 |
| 4 | DB 덤프 완료 | `wc -l dump.sql` | T1 |
| 5 | 빌드 타입체크 | `npx tsc --noEmit` exit 0 | T3 |
| 6 | opencode 73% 원인 분석 | agent_integration test | T1 |

## (4) 미확인/잔여 항목

- dirty worktree 파일 목록, 경로, 개수 → **미확인** (`git status`로 수집 필요)
- 현재 HEAD SHA → **미확인** (`git rev-parse HEAD` 필요)
- DB 파일 위치 및 마이그레이션 버전 → **미확인** (DB 쿼리 필요)
- Redis 데이터 무결성 → **미확인** (Redis ping + key scan 필요)
- PM2 프로세스 정상 여부 → **미확인** (pm2 list 필요)
- opencode 성공률 73%의 구체적 실패 원인 → **미확인** (에이전트 로그 분석 필요)
- .env 파일 존재 및 API 키 유효성 → **미확인** (파일 읽기 필요)
- `config/topology.json` 백업 필요 여부 → **미확인** (파일 목록 확인 필요)

**요약**: 모든 에이전트 idle, 작업 backlog 0, 완료율 100%. dirty worktree·git SHA·DB 버전·Redis 상태는 명령 실행 금지로 전부 미확인. 위 플랜을 실행 세션에서 `bash`로 수행해야 복구 체크포인트가 완성됨. 특히 opencode(성공률 73%)의 최근 실패 패턴을 역추적하는 게 복구 우선순위 1순위.
