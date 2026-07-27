# 03 Recovery Checkpoint — 일일 산출물 (2026-07-26, ai=opencode, taskId=task_oYwS2Oj3mxFSR7S4)

# 2026-07-26 복구 체크포인트 (Stage 3) — 텍스트 전용

## (1) 관찰·분석

**데이터 가용성 (주입된 실데이터만 근거)**
- Tasks 7일: 36건 중 완료 12 (33.3%), 실패 24 — 실패율 66.7%
- Teams 누계: 34건 중 완료 11 (32.4%), 실패 23 — teams 대시보드가 tasks와 거의 동일한 실패 패턴
- Work reports: 7일간 submitted=4, missed=2 — 보고 누락률 33.3%
- opencode: 태스크 2582, 성공률 60%, **24시간 실패 451회** — 심각한 불안정
- codex: 태스크 2490, 성공률 93%, 24시간 실패 0 — 안정적
- cursor-agent: 태스크 10923, 성공률 98%, 24시간 실패 1 — 매우 안정적

**opencode 24h failure 451**이 전체 실패율(66.7%)의 주 원인으로 추정. codex/cursor-agent는 정상.

**미확인 항목** (도구 실행 불가로 확인 불가):
- 현재 git commit SHA, dirty worktree 여부, 변경 파일 목록
- `config/ai-providers.json` 내용 및 수정 여부
- `config/topology.json` 내용
- `.env` 파일 상태
- DB 마이그레이션 버전 (`db/migrations/` 현황)
- Redis 상태, SQLite 파일 존재 여부
- PM2 프로세스 상태

## (2) 현재 상태 요약

| 지표 | 값 | 근거 |
|------|-----|------|
| 작업 완료율 (7일) | 33.3% | injected tasks data |
| 팀 완료율 (누계) | 32.4% | injected /api/teams |
| 보고 누락률 | 33.3% | injected work_reports |
| opencode 24h실패 | 451 | injected /api/agents |
| codex/cursor 실패 | 0 / 1 | injected /api/agents |

**핵심 리스크**: opencode 성공률 60% + 24h 451회 실패 — 집중 진단 필요.

## (3) 다음에 필요한 작업 제안 (도구/명령 사용 전 — 현재 불가)

아래는 도구 접근 가능 시 실행할 액션 목록 — 현재로는 텍스트 제안만 가능:

**Step A — 기준점 확보 (git)**
```
git rev-parse HEAD         # 현재 HEAD SHA
git status --porcelain     # dirty file 목록
git stash list             # stash 확인
```

**Step B — dirty worktree 보존**
```
git diff --stat > /tmp/recovery-20260726-dirty.diff
git stash push -m "recovery-20260726-preserve"   # destructive 금지이므로 stash 사용
```

**Step C — 설정 백업**
```
cp config/ai-providers.json /tmp/recovery-ai-providers-20260726.json
cp config/topology.json /tmp/recovery-topology-20260726.json
cp .env /tmp/recovery-env-20260726
```

**Step D — DB 역마이그레이션 정보**
```
sqlite3 data/nco.db .schema   # 현재 스키마 확인
ls db/migrations/              # 마이그레이션 파일 목록
# 역마이그레이션: 가장 최근 migration 파일부터 순차 롤백
```

**Step E — 롤백 명령어 템플릿**
```bash
# dirty worktree 복원
git stash pop

# 설정 복원
cp /tmp/recovery-ai-providers-20260726.json config/ai-providers.json
cp /tmp/recovery-topology-20260726.json config/topology.json
cp /tmp/recovery-env-20260726 .env

# DB 롤백 (최신 마이그레이션 하나)
# node dist/db/migrate.js rollback  # 실제 명령은 migration 구조 확인 후 결정
```

**Step F — 검증 체크리스트 (회복 후)**
- [ ] `curl -s localhost:6200/health` → 200
- [ ] opencode 에이전트 heartbeat 정상 (online 유지)
- [ ] opencode 24h failure 추세 감소 확인
- [ ] 기존 `/api/*` 엔드포인트 정상 응답
- [ ] WebSocket `:6201` 연결 가능
- [ ] SQLite ↔ Redis sync 정상

## 핵심 권장

**opencode 24h failure 451이 가장 큰 신호.** codex(93%, 0실패)와 cursor-agent(98%, 1실패)에 비해 opencode 성공률 60%는 심각. NCO circuit breaker 또는 task routing 정책에서 opencode로 향하는 요청을 일시적으로 codex/cursor-agent로 재분배하는 방안 검토가 필요. 단, tool 접근 불가로 실제 원인 분석은 미수행 상태.
