# 03 복구 지점·롤백팀 — 일일 산출물 (2026-07-23, ai=opencode, taskId=task_5aI7z3XbcnERO5OL)

## 3단계 복구 지점 — Checkpoint Manifest (텍스트 전용, 미실행)

### 1. 데이터 가용성 보고

| 항목 | 상태 | 근거 |
|------|------|------|
| nco dirty worktree | **미확인** | git status 미실행 |
| nova-use dirty worktree | **미확인** | git status 미실행 |
| nova-ax dirty worktree | **미확인** | git status 미실행 |
| nco HEAD SHA | **미확인** | `git rev-parse HEAD` 미실행 |
| nova-use HEAD SHA | **미확인** | 동일 |
| nova-ax HEAD SHA | **미확인** | 동일 |
| DB 마이그레이션 파일 | **미확인** | `db/migrations/` glob 미실행 |
| 설정 파일(.env, config/*.json) | **미확인** | 파일 내용 미읽음 |
| 복구 리허설 결과 | **미확인** | 실행 불가 (도구 금지) |

**데이터 가용성**: 주입된 실데이터는 `/api/agents`의 3개 에이전트 상태뿐. git 상태, 파일 내용, DB 스키마, 설정 파일 내용은 전혀 제공되지 않음.

---

## Checkpoint Manifest (설계 전용 — 미실행, 미검증)

### 1. Dirty Worktree 식별 (미확인 — git status 필요)

| 대상 | 경로 | dirty 여부 | 미확인 사유 |
|------|------|-----------|------------|
| nco | `/Users/nova-ai/project/nco` | **미확인** | git status 미실행 |
| nova-use | `/Users/nova-ai/project/nova-use` | **미확인** | git status 미실행 |
| nova-ax | `/Users/nova-ai/project/nova-ax` | **미확인** | git status 미실행 |

**다음 수집 액션**: 각 대상에서 `git status --porcelain` 실행하여 untracked/modified/staged 파일 목록 확보.

### 2. 기준 Commit SHA (미확인)

| 대상 | HEAD SHA | 기준 SHA | 미확인 사유 |
|------|----------|----------|------------|
| nco | 미확인 | 미확인 | `git rev-parse HEAD` 미실행 |
| nova-use | 미확인 | 미확인 | 동일 |
| nova-ax | 미확인 | 미확인 | 동일 |

**다음 수집 액션**: 각 대상에서 `git rev-parse HEAD` 실행.

### 3. 설정 백업 대상 (미확인 — 파일 내용 미읽음)

| 대상 | 예상 경로 | 상태 |
|------|----------|------|
| nco .env | `project/nco/.env` | 미확인 |
| nco config/*.json | `project/nco/config/` | 미확인 |
| nova-use .env | `project/nova-use/.env` | 미확인 |
| nova-ax .env | `project/nova-ax/.env` | 미확인 |

### 4. DB 마이그레이션 역방향 절차 (미확인 — 파일 미읽음)

| 대상 | 예상 경로 | 역방향 절차 | 상태 |
|------|----------|------------|------|
| nco | `project/nco/db/migrations/` | 미확인 — 파일 미읽음 | 미확인 |
| nova-use | `project/nova-use/db/migrations/` | 미확인 | 미확인 |
| nova-ax | `project/nova-ax/db/migrations/` | 미확인 | 미확인 |

**다음 수집 액션**: 각 대상의 `db/migrations/` 디렉터리 glob + 각 마이그레이션 파일의 `down` SQL 확인.

### 5. 롤백 명령 (설계 전용 — 미실행, 미검증)

| 단계 | 명령 | 검증 기준 |
|------|------|----------|
| 1. dirty 변경 보존 | `git stash` 또는 `git diff > /tmp/checkpoint-YYYYMMDD.patch` | patch 파일 존재 확인 |
| 2. 기준 SHA checkout | `git checkout <SHA}` | `git rev-parse HEAD` = 기준 SHA |
| 3. DB 롤백 | 각 마이그레이션의 `down` SQL 순차 실행 | DB 스키마 버전 확인 |
| 4. 설정 복원 | `.env`, `config/*.json` 백업 복사 | diff 0 확인 |
| 5. 검증 | `npm run build` + `npm test` | exit 0 |

### 6. 복구 리허설 결과

**미실행** — 도구/커맨드 사용 금지 지시. 리허설에 필요한 명령:
- `git status --porcelain` (dirty worktree 식별)
- `git rev-parse HEAD` (기준 SHA)
- `git stash create` (dirty 변경 보존)
- `git worktree add` (격리 worktree)
- `ls db/migrations/` (마이그레이션 파일 목록)
- 각 마이그레이션 파일 Read (down SQL 확인)
- `cp .env /tmp/checkpoint-env-backup` (설정 백업)

### 7. Checkpoint Manifest (설계)

```yaml
checkpoint:
  id: "cp-20260723"
  created_by: "architect"
  targets:
    nco:
      path: /Users/nova-ai/project/nco
      head_sha: 미확인
      base_sha: 미확인
      dirty: 미확인
      worktree_branch: "checkpoint/cp-20260723-nco"
      config_backup: 미확인
      migration_reverse: 미확인
    nova-use:
      path: /Users/nova-ai/project/nova-use
      head_sha: 미확인
      base_sha: 미확인
      dirty: 미확인
      worktree_branch: "checkpoint/cp-20260723-nova-use"
      config_backup: 미확인
      migration_reverse: 미확인
    nova-ax:
      path: /Users/nova-ai/project/nova-ax
      head_sha: 미확인
      base_sha: 미확인
      dirty: 미확인
      worktree_branch: "checkpoint/cp-20260723-nova-ax"
      config_backup: 미확인
      migration_reverse: 미확인
```

## 현재 상태

**데이터 가용성**: `/api/agents`의 3개 에이전트 상태만 제공됨. git 상태, HEAD SHA, 설정 파일, DB 마이그레이션, nova-use/nova-ax 프로젝트 존재 여부 — **전부 미확인**.

### 관찰·분석
- opencode 성공률 74% (24h 실패 1) — 가장 낮은 신뢰도. 복구 시 opencode 생성 변경 우선 검증 필요.
- codex 성공률 95% (24h 실패 7) — 높은 신뢰도지만 실패 절대수 7로 가장 많음.
- cursor-agent 성공률 98% (24h 실패 1) — 가장 안정적.
- 3개 프로젝트(nco, nova-use, nova-ax)의 git 상태, HEAD SHA, dirty worktree, DB 마이그레이션, 설정 파일 — **전부 미확인**. 도구 실행 없이 이 데이터를 얻을 방법 없음.

### 현재 상태
- **복구 지점 생성 불가**: dirty worktree, HEAD SHA, 설정 파일, DB 마이그레이션 역방향 절차 — 모두 미확인. 텍스트만으로는 checkpoint manifest를 완성할 수 없음.
- **실데이터 범위**: `/api/agents`의 3개 에이전트 상태만 있음. nco 프로젝트의 git 상태, nova-use/nova-ax 존재 여부조차 미확인.
- **제약**: 도구/커맨드 실행 금지 → git status, git rev-parse, ls, read 등 모든 검증 수단 차단됨.

### 다음에 필요한 작업 제안

1. **dirty worktree 식별**: 각 대상에서 `git status --porcelain` 실행, 결과를 checkpoint manifest에 기록.
2. **기준 SHA 확보**: `git rev-parse HEAD`로 현재 HEAD 기록. 복구 지점 브랜치명: `checkpoint/cp-20260723-{target}`.
3. **설정 백업**: `.env`, `config/*.json`을 `/tmp/checkpoint-20260723/`에 복사.
4. **DB 마이그레이션 역방향 절차**: 각 `db/migrations/` 디렉터리 glob → 각 파일의 `down` SQL 수집 → 역순 실행 스크립트 작성.
5. **복구 리허설**: 격리 worktree에서 `git checkout <base_SHA>` → `npm run build` → `npm test` → DB 롤백 시뮬레이션. 결과를 manifest에 기록.
6. **승인 조건**: 모든 대상의 dirty 변경이 patch로 보존되고, 기준 SHA checkout 후 build+test 통과가 T1 검증되어야 다음 단계 진행 승인.

**결론**: 텍스트만으로는 checkpoint manifest를 완성할 수 없음. 위 6단계 실행 후 재보고 필요. 현재 등급: [Evidence Tier 4] — LLM 자연어 설계 전용, T1 검증 0건.
