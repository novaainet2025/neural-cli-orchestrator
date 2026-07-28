# 03 Recovery Checkpoint — 일일 산출물 (2026-07-29, ai=codex, taskId=task_SbwW2dMNK8UZ6DcW)

done: [Evidence Tier 1] 대화에 주입된 실데이터와 프로젝트 지침을 직접 대조하여 텍스트형 3단계 복구 체크포인트를 작성했습니다. 파일·Git·DB·API는 제약에 따라 조회하거나 변경하지 않았으므로 실제 복구 지점 생성은 미수행·미확인입니다.

## 1. 오늘 관찰·분석 — 2026-07-29

- 최근 7일 태스크는 전체 47건, 완료 19건, 실패성 28건, 진행 0건이며 완료율은 40.4%입니다.
- 계산상 실패성 비율은 59.6%입니다. 완료 19건과 실패성 28건의 합은 전체 47건과 일치합니다.
- `/api/teams`의 전체·완료·실패·진행·완료율은 `[tasks]` 집계와 일치하며 대기 태스크도 0건입니다.
- 최근 7일 작업 보고는 제출 8건, 누락 2건입니다.
- 에이전트 현황:
  - opencode: idle, 누적 태스크 1,537건, 성공률 29%, 24시간 실패 38건
  - codex: working, 누적 태스크 2,652건, 성공률 90%, 24시간 실패 5건
  - cursor-agent: idle, 누적 태스크 3,635건, 성공률 95%, 24시간 실패 17건
- 태스크 집계에는 진행 0건이지만 codex 상태는 working입니다. 집계 범위·갱신 시각·상태 정의가 제공되지 않아 원인은 미확인입니다.
- 실패성 태스크 28건을 특정 에이전트의 24시간 실패 수치와 직접 연결할 근거는 없습니다.

## 2. 현재 상태

- 프로젝트: `/Users/nova-ai/project/nco`
- 작업 유형: bugfix
- 현재 브랜치: 미확인
- 기준 commit SHA: 미확인
- dirty worktree 여부: 미확인
- 수정·추가·삭제·미추적 파일: 미확인
- 사용자 변경과 자동 생성물의 구분: 미확인
- 설정 파일 실제 존재 여부 및 현재 내용: 미확인
- 설정 백업: 미생성
- SQLite DB 경로·스키마·적용 마이그레이션: 미확인
- 역마이그레이션 제공 여부: 미확인
- Redis·Gateway·WebSocket 실행 상태: 미확인
- 빌드·타입 검사·테스트 결과: 미확인
- 실제 복구 체크포인트: 미생성

## 3. 3단계 복구 체크포인트

아래 명령은 실행하지 않은 운영자용 템플릿입니다. `<CHECKPOINT_DIR>`, `<BASELINE_SHA>`, `<DB_PATH>`, `<RECOVERY_WORKTREE>`는 실제 확인값으로 치환해야 합니다.

### 1단계 — dirty worktree 식별 및 사용자 변경 보존

가장 먼저 다음 정보를 수집합니다.

```bash
cd /Users/nova-ai/project/nco
git status --porcelain=v2 --branch
git rev-parse HEAD
git diff --binary
git diff --cached --binary
git ls-files --others --exclude-standard
```

기준 SHA는 `git rev-parse HEAD`의 실제 출력으로 기록합니다. 현재 값은 미확인입니다.

사용자 변경을 원본 worktree에서 제거하지 않고 외부 체크포인트에 보존합니다.

```bash
mkdir -p "<CHECKPOINT_DIR>/config"
chmod 700 "<CHECKPOINT_DIR>"

git status --porcelain=v2 --branch > "<CHECKPOINT_DIR>/git-status.txt"
git rev-parse HEAD > "<CHECKPOINT_DIR>/baseline-sha.txt"
git diff --binary > "<CHECKPOINT_DIR>/working-tree.patch"
git diff --cached --binary > "<CHECKPOINT_DIR>/index.patch"
git ls-files --others --exclude-standard > "<CHECKPOINT_DIR>/untracked-files.txt"

rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  /Users/nova-ai/project/nco/ \
  "<CHECKPOINT_DIR>/worktree/"
```

패치만으로는 미추적 파일이나 일부 바이너리를 완전히 보존하지 못할 수 있으므로 worktree 스냅샷과 함께 보관합니다. `reset`, `checkout`, `clean`, 대량삭제는 사용하지 않습니다.

### 2단계 — 설정 및 DB 백업

프로젝트 지침에 언급된 설정 후보는 다음과 같습니다. 실제 존재 여부를 확인한 파일만 복사합니다.

- `config/ai-providers.json`
- `config/topology.json`
- `.env`
- `ecosystem.config.cjs`

```bash
cd /Users/nova-ai/project/nco

for f in config/ai-providers.json config/topology.json .env ecosystem.config.cjs; do
  if [ -e "$f" ]; then
    cp -p -- "$f" "<CHECKPOINT_DIR>/config/"
  fi
done
```

`.env` 백업은 비밀정보를 포함할 수 있으므로 체크포인트 접근 권한을 제한하고 본문이나 로그에 내용을 출력하지 않습니다.

DB 경로는 현재 미확인입니다. `config/topology.json`, 환경 설정 및 초기화 코드를 통해 실제 `<DB_PATH>`를 먼저 확정해야 합니다. 확정 후 SQLite 온라인 백업과 무결성 검사를 수행합니다.

```bash
sqlite3 "<DB_PATH>" ".backup '<CHECKPOINT_DIR>/db-before.sqlite'"
sqlite3 "<CHECKPOINT_DIR>/db-before.sqlite" "PRAGMA quick_check;"
```

DB 역마이그레이션은 적용 버전과 `db/migrations/`의 실제 내용이 확인되지 않아 명령을 확정할 수 없습니다. 추측한 테이블명이나 역방향 SQL을 실행해서는 안 됩니다.

필요한 선행 확인:

```bash
ls -la db/migrations
sqlite3 "<DB_PATH>" ".tables"
sqlite3 "<DB_PATH>" ".schema"
```

각 forward migration의 역연산, 데이터 손실 가능성, 트랜잭션 적용 여부를 검토합니다. 검증된 down migration이 없다면 DB 전체 백업 복원이 기본 롤백 수단입니다.

### 3단계 — 비파괴 롤백 및 검증

기존 dirty worktree를 그대로 보존하면서 기준 SHA를 검증하려면 별도 worktree를 사용합니다.

```bash
git -C /Users/nova-ai/project/nco worktree add \
  --detach "<RECOVERY_WORKTREE>" "<BASELINE_SHA>"
```

기준 commit만 복구하려면 스냅샷을 덮지 않습니다. 체크포인트 당시의 dirty 변경까지 재현해야 할 때만 먼저 dry-run으로 비교한 뒤 복원합니다.

```bash
rsync -a --dry-run \
  "<CHECKPOINT_DIR>/worktree/" \
  "<RECOVERY_WORKTREE>/"

rsync -a \
  "<CHECKPOINT_DIR>/worktree/" \
  "<RECOVERY_WORKTREE>/"
```

`--delete`는 사용하지 않습니다. 설정은 파일별 차이를 검토한 뒤 선택적으로 복원합니다.

DB 전체 복원이 필요하면 모든 DB writer가 중지됐다는 직접 증거를 확보한 후 실행합니다. 실제 서비스 중지 방식은 현재 미확인입니다.

```bash
sqlite3 "<DB_PATH>" ".restore '<CHECKPOINT_DIR>/db-before.sqlite'"
sqlite3 "<DB_PATH>" "PRAGMA quick_check;"
```

## 롤백 검증 체크리스트

- [ ] 저장된 `baseline-sha.txt`와 복구 worktree의 `git rev-parse HEAD`가 정확히 일치
- [ ] 체크포인트 전후 `git status --porcelain=v2` 비교 완료
- [ ] 미추적 파일 목록과 worktree 스냅샷 대조 완료
- [ ] 설정 파일별 체크섬 대조 완료
- [ ] `.env` 내용이 로그에 노출되지 않았고 백업 권한이 제한됨
- [ ] DB 백업의 `PRAGMA quick_check;` 결과가 정확히 `ok`
- [ ] 적용 마이그레이션 버전과 복원 대상 버전 일치
- [ ] `npx tsc --noEmit` 오류 0개
- [ ] `npm run test:run` 결과 확인
- [ ] 기존 `/api/*` 응답 확인
- [ ] WebSocket 브리지 `:6201` 연결·재연결 확인
- [ ] SQLite 데이터 무결성 확인
- [ ] Redis 사용 시 SQLite와의 복구 동기화 확인
- [ ] 복구 후 `/api/teams` 수치를 체크포인트 시점 기준값인 전체 47, 완료 19, 실패 28, 진행 0, 대기 0, 완료율 40.4%와 비교
- [ ] 에이전트 상태처럼 변동 가능한 값은 동일성 강제 대신 조회 시각과 함께 별도 기록

unverified/remaining:

- 실제 dirty 상태와 사용자 변경 식별
- 기준 commit SHA 수집
- 체크포인트 저장 위치 결정
- 설정 및 DB 백업 생성
- DB 경로·마이그레이션 수준·역마이그레이션 방법 확정
- 비파괴 롤백 실행
- 타입 검사·테스트·HTTP·WebSocket·DB 검증 수행
