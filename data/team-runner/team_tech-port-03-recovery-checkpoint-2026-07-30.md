# 03 Recovery Checkpoint — 일일 산출물 (2026-07-30, ai=codex, taskId=task_sihxuZxBa6JZhgQL)

done: [Evidence Tier 1] 주입된 실데이터 원문과 아래 수치를 직접 대조했습니다. 명령·파일 수정은 수행하지 않았으며, 실제 복구 지점은 아직 생성되지 않았습니다.

1) 오늘 관찰·분석

- 최근 7일 태스크: 전체 52건, 완료 23건, 실패성 29건, 진행 0건, 완료율 44.2%.
- `/api/teams`의 전체·완료·실패·진행·완료율이 위 수치와 일치합니다. 대기 태스크는 0건입니다.
- 실패성 태스크 29건이 완료 23건보다 6건 많아, 변경 전 복구 가능성 확보가 우선입니다.
- 작업보고는 submitted 10건, missed 2건입니다.
- `/api/agents` 기준:
  - opencode: online, 누적 태스크 1600건, 성공률 30%, 24시간 실패 9건.
  - codex: working, 누적 태스크 2897건, 성공률 90%, 24시간 실패 6건.
  - cursor-agent: idle, 누적 태스크 3684건, 성공률 95%, 24시간 실패 5건.
- 위 에이전트 통계는 복구 위험 판단의 참고 자료일 뿐, worktree·커밋·DB 상태의 증거는 아닙니다.

2) 현재 상태

- 프로젝트: `/Users/nova-ai/project/nco`
- dirty worktree 여부와 변경 파일 소유자: 미확인
- staged·unstaged·untracked 변경: 미확인
- 기준 commit SHA: 미확인
- 설정 파일의 현재 내용과 백업: 미확인
- SQLite DB 실제 경로·현재 마이그레이션 버전·역마이그레이션 지원 명령: 미확인
- 복구용 patch·untracked archive·DB snapshot: 생성하지 않음
- build·typecheck·test·HTTP 재조회: 실행하지 않음
- destructive reset·checkout·대량삭제: 수행하지 않음

3) 제안하는 3단계 복구 지점

### 1단계 — 사용자 변경 보존 및 기준점 확정

다음은 실행하지 않은 제안 명령입니다. 백업 디렉터리는 프로젝트 밖의 접근 제한된 위치로 먼저 지정해야 합니다.

```bash
cd /Users/nova-ai/project/nco
git status --short --branch
git rev-parse --verify HEAD
git diff --binary > "$CHECKPOINT_DIR/working-tree.patch"
git diff --cached --binary > "$CHECKPOINT_DIR/index.patch"
git ls-files --others --exclude-standard -z > "$CHECKPOINT_DIR/untracked-files.zlist"
tar --null -T "$CHECKPOINT_DIR/untracked-files.zlist" -czf "$CHECKPOINT_DIR/untracked-files.tgz"
```

필수 기록:

- `git rev-parse --verify HEAD`의 실제 출력값을 `BASE_SHA`로 기록
- 각 변경 파일을 사용자 변경·복구 대상 변경·소유자 미확인으로 분류
- 소유자 미확인 변경은 자동 역적용하거나 덮어쓰지 않음
- patch와 archive의 checksum 및 생성 시각 기록

### 2단계 — 설정 및 DB 복구 지점

프로젝트 지침에 언급된 설정 후보는 `config/ai-providers.json`, `config/topology.json`, `.env`, `ecosystem.config.cjs`, `.Codex/settings.json`입니다. 현재 존재 여부는 미확인이므로, 존재 확인 후에만 보존해야 합니다. `.env` 백업은 내용을 출력하지 말고 접근 권한을 제한해야 합니다.

DB는 실제 경로와 마이그레이션 체계를 먼저 확인합니다. SQLite가 실행 중이면 단순 파일 복사 대신 SQLite의 일관된 백업 기능을 사용합니다.

```bash
sqlite3 "$VERIFIED_DB_PATH" ".backup '$CHECKPOINT_DIR/database.sqlite.backup'"
sqlite3 "$CHECKPOINT_DIR/database.sqlite.backup" "PRAGMA integrity_check;"
```

역마이그레이션은 정확한 down 명령과 대상 버전이 주입되지 않아 미확인입니다. 다음 정보가 확보되기 전에는 실행하면 안 됩니다.

- 현재 migration ID
- 목표 migration ID
- down migration 구현 여부
- 데이터 손실 가능성
- 쓰기 트래픽 중단 방법
- 실패 시 DB snapshot 복원 절차

### 3단계 — 비파괴 롤백 및 검증

소스 롤백은 `reset`이나 `checkout` 대신 별도 worktree 또는 이력을 남기는 `git revert`를 사용합니다.

```bash
git cat-file -e "$BASE_SHA^{commit}"
git worktree add "$RECOVERY_WORKTREE" "$BASE_SHA"
```

기존 브랜치에서 결함 커밋만 취소해야 한다면 범위를 직접 확인한 뒤 다음 형태를 사용합니다.

```bash
git revert --no-commit "$FIRST_BAD_SHA^..$LAST_BAD_SHA"
git diff --check
```

사용자 변경 patch는 복구 대상 변경과 분리한 뒤에만 적용합니다.

```bash
git apply --check "$USER_ONLY_PATCH"
git apply "$USER_ONLY_PATCH"
```

DB 역마이그레이션 명령은 현재 프로젝트의 실제 runner가 확인되지 않아 작성할 수 없습니다. 임의 명령을 만드는 대신, migration 구현과 DB snapshot을 확인한 후 승인된 명령으로 채워야 합니다.

검증 체크리스트:

- [ ] 기준 SHA가 실제 commit 객체로 확인됨
- [ ] staged·unstaged·untracked 변경의 목록과 소유권이 기록됨
- [ ] 사용자 변경 patch와 untracked archive가 열리고 checksum이 일치함
- [ ] 설정 백업의 파일 목록·권한·checksum이 확인됨
- [ ] DB snapshot에서 `PRAGMA integrity_check;` 결과가 확인됨
- [ ] 현재·목표 migration ID와 down 절차가 확인됨
- [ ] 롤백 diff에 사용자 변경이 섞이지 않음
- [ ] TypeScript 검사와 관련 테스트의 실제 출력이 보존됨
- [ ] WebSocket 및 기존 `/api/*` 동작을 실제 응답으로 확인함
- [ ] `/api/teams`와 `/api/agents`를 다시 조회하여 예상치 못한 데이터 손실 여부를 비교함

unverified/remaining:

- dirty worktree와 변경 소유권 수집
- 실제 `BASE_SHA` 기록
- 설정 백업 및 checksum 생성
- DB 경로·migration ID·역마이그레이션 명령 확인
- 비파괴 복구 worktree 생성
- rollback rehearsal과 빌드·테스트·HTTP 검증 수행
