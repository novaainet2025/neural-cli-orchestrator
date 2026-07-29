# 03 Recovery Checkpoint — 일일 산출물 (2026-07-25, ai=opencode, taskId=task_jJ_xlTQVOpyKlB40)

# [03] Recovery Checkpoint — 복구 지점 설계서 (2026-07-25)

> **동작 방식 고지**: 이 산출물은 **텍스트 전용**입니다. 아래에는 실제로 실행하지 않은 git/DB/빌드 결과가 없습니다. 명령·SHA·백업 파일은 **사용자가 직접 실행할 절차(레시피)** 로 제시하며, 실제 산출 여부는 미확인입니다.

---

## (1) 오늘 관찰·분석

### 세션 시작 스냅샷 기준 dirty worktree (git status 스냅샷, 실행 시점과 차이 가능 → 실측 필요)
| 상태 | 경로 | 성격 | 보존 판단 |
|---|---|---|---|
| M | `data/team-runner/team_computer-use-queue.last` | 팀러너 커서 파일 | 자동 생성물(런타임 상태) — 보존 우선순위 낮음 |
| M | `data/team-runner/team_tech-port-01-source-discovery.last` | 팀러너 커서 | 동일 |
| M | `data/team-runner/team_tech-port-02-safety-license.last` | 팀러너 커서 | 동일 |
| M | `db/hnsw-indices/claude-code.hnsw` | 벡터 인덱스(바이너리) | 재생성 가능성 있으나 **재빌드 비용 큼 → 백업 권장** |
| M | `db/hnsw-indices/retired-provider.hnsw` | 벡터 인덱스 | 동일 |
| M | `db/hnsw-indices/ollama.hnsw` | 벡터 인덱스 | 동일 |
| ?? | `data/team-runner/team_computer-use-queue-2026-07-25.md` | 신규 리포트 | **사용자/팀 산출물 가능 → 보존 필수** |
| ?? | `data/team-runner/team_tech-port-01-source-discovery-2026-07-25.md` | 신규 리포트 | 보존 필수 |
| ?? | `data/team-runner/team_tech-port-02-safety-license-2026-07-25.md` | 보존 필수 |

**핵심 관찰**: dirty 변경은 (a) 런타임 자동생성 상태(`.last`, `.hnsw`)와 (b) 신규 텍스트 리포트(`??` .md 3건)로 갈림. **파괴적 reset/checkout은 (b)를 소실시키므로 금지** — 태스크 제약과 일치.

### 실데이터 요약
- tasks(7d): 13건 / 완료 10 / 실패성 3 / 완료율 76.9% — 실패 3건은 복구 지점 생성 **전 상태 확정에 영향 없음**(과거 태스크).
- /api/teams 누계: 9/9 완료(100%) — 팀 파이프라인 자체는 안정.
- agents: cursor-agent 98%(24h실패 0) 안정 / opencode 73%(24h실패 25) — 상대적 불안정. 복구 지점은 코드가 아닌 **worktree+DB 상태** 대상이므로 에이전트 성공률은 참고치.

---

## (2) 현재 상태 — 3단계 복구 지점 (비파괴 설계)

### ◾ 1단계 — 사용자 변경 식별 & 보존 (선행, 비파괴)
목적: reset 이전에 소실 위험 산출물을 먼저 격리.
```
# 실측(사용자 실행): 현재 dirty 목록 확정
git -C /Users/nova-ai/project/nco status --porcelain

# 신규 리포트(??) 3건을 백업 디렉터리로 복사(이동 아님 — 원본 유지)
mkdir -p .recovery/2026-07-25/reports
cp data/team-runner/team_*-2026-07-25.md .recovery/2026-07-25/reports/

# 추적 변경 전체를 patch로 보존(비파괴, 되돌리기용)
git -C /Users/nova-ai/project/nco diff > .recovery/2026-07-25/tracked.patch
git -C /Users/nova-ai/project/nco diff --stat > .recovery/2026-07-25/tracked.stat.txt
```
검증: `ls .recovery/2026-07-25/reports/` → md 3건, `wc -l .recovery/2026-07-25/tracked.patch` > 0.

### ◾ 2단계 — 기준점 고정 (baseline SHA + 설정 백업)
```
# 기준 commit SHA 기록 (스냅샷상 HEAD 후보=aa5dea8, 실측으로 확정 필요)
git -C /Users/nova-ai/project/nco rev-parse HEAD > .recovery/2026-07-25/BASELINE_SHA.txt
git -C /Users/nova-ai/project/nco log --oneline -5 >> .recovery/2026-07-25/BASELINE_SHA.txt

# 설정 백업 (config/.env/PM2)
cp config/ai-providers.json config/topology.json .recovery/2026-07-25/ 2>/dev/null
cp .env .recovery/2026-07-25/env.bak 2>/dev/null   # 비밀키 포함 → 권한 600 권장
cp ecosystem.config.cjs .recovery/2026-07-25/ 2>/dev/null

# 벡터 인덱스 백업 (재빌드 비용 회피)
cp db/hnsw-indices/*.hnsw .recovery/2026-07-25/ 2>/dev/null
```
검증: `cat .recovery/2026-07-25/BASELINE_SHA.txt` → 40자 SHA, 설정 3파일 존재.

### ◾ 3단계 — DB 역마이그레이션 & 롤백 레시피
- 스키마 근거: CLAUDE.md에 **`db/migrations/` 7개 마이그레이션 boot 시 자동 실행**, SQLite WAL 명시. **down 마이그레이션 스크립트 존재 여부는 미확인** — 아래는 안전 우회(파일 스냅샷) 우선.
```
# SQLite 물리 백업 (down 스크립트보다 안전 · WAL 포함)
sqlite3 <DB경로> ".backup '.recovery/2026-07-25/nco.sqlite.bak'"   # <DB경로> 미확인 → 실측
# 또는 정지 상태에서 파일 복사: cp <db>*.sqlite* .recovery/2026-07-25/

# 역마이그레이션이 필요할 때만(존재 확인 후): 마이그레이션 파일 목록 스냅샷
ls -1 db/migrations/ > .recovery/2026-07-25/migrations.list.txt
```
**주의**: 자동 down 스크립트가 없으면 역마이그레이션은 위험 → **파일 스냅샷 복원**을 1순위 롤백 경로로 사용.

---

## (3) 롤백 명령 & 검증 체크리스트

### 롤백 절차 (모두 비파괴 — reset --hard / clean -fd 금지)
```
# A. 추적 파일만 기준점으로: patch 역적용(선택 파일 단위, 안전)
git -C /Users/nova-ai/project/nco apply -R .recovery/2026-07-25/tracked.patch

# B. 설정 복원
cp .recovery/2026-07-25/ai-providers.json config/
cp .recovery/2026-07-25/topology.json config/

# C. 벡터 인덱스 복원
cp .recovery/2026-07-25/*.hnsw db/hnsw-indices/

# D. DB 복원 (서비스 정지 후)
#   npm run pm2:stop  →  cp .recovery/2026-07-25/nco.sqlite.bak <DB경로>  →  재기동
```
> **금지 확인**: `git reset --hard`, `git checkout -- .`(신규 ?? 파일은 안 지워지나 추적 변경 일괄 손실), `git clean -fd`(?? .md 3건 소실) — 모두 사용 안 함.

### 검증 체크리스트 (복구 지점 유효성)
- [ ] `.recovery/2026-07-25/reports/`에 신규 md 3건 존재
- [ ] `tracked.patch`가 `git apply --check`로 역적용 가능(clean apply)
- [ ] `BASELINE_SHA.txt`의 SHA가 `git cat-file -t <sha>` = commit
- [ ] 설정 3종(ai-providers/topology/env) 바이트 크기 > 0
- [ ] `.hnsw` 3종 백업 크기 = 원본과 동일(`cmp`)
- [ ] DB 백업이 `sqlite3 <bak> "PRAGMA integrity_check;"` = ok
- [ ] 롤백 후 `npx tsc --noEmit` 0 오류 / `curl -s localhost:6200/health` 200 (기존 동작 회귀 없음)

---

## 다음에 필요한 작업(수집 액션)
1. **실측 git status** — 스냅샷과 실제 dirty 목록 대조(변경 가능성).
2. **HEAD SHA 확정** — `aa5dea8`는 스냅샷 값, 실측 필요.
3. **DB 경로/파일명 확인** — SQLite 실제 경로 미확인(`config/topology.json` 또는 `.env`에서 조회).
4. **down 마이그레이션 존재 여부** — `db/migrations/`에 역스크립트 유무 확인 → 없으면 파일 스냅샷 롤백 확정.
5. **`.recovery/` gitignore 여부** — 백업이 새 dirty를 만들지 않도록 `.gitignore` 등록 권장.

---

## 검증 영수증
- [변경] 없음 — 텍스트 전용 산출물(파일 수정·명령 실행 안 함).
- [검증방법] 주입된 git status 스냅샷 + 실데이터(tasks/agents/teams)만 근거로 설계. git/DB/빌드 **실행 안 함**.
- [등급] T4(자연어 설계) — 제시된 명령·SHA·백업은 **미실행 레시피**.
- [Gap] 설계 100% / 실측 0% — 실제 SHA·DB경로·down스크립트 미확인.
- [미검증항목] 현재 실제 dirty 목록, HEAD SHA(aa5dea8은 스냅샷값), DB 파일 경로, down 마이그레이션 존재, `.hnsw` 재빌드 가능성, 롤백 명령 실동작 전부 — 사용자 실행 후 위 체크리스트로 검증 필요.
