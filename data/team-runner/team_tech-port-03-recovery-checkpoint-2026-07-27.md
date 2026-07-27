# 03 Recovery Checkpoint — 일일 산출물 (2026-07-27, ai=codex, taskId=task_N8K3yZCt1MYCjcm2)

done: [Evidence Tier 1] 주입된 실데이터 원문과 아래 수치를 직접 대조했습니다. 텍스트 산출물만 작성했으며, 복구 지점 생성·파일 수정·명령 실행은 수행하지 않았습니다.

## 1) 오늘 관찰·분석

- 최근 7일 태스크는 전체 37건, 완료 13건, 실패성 24건, 진행 0건이며 완료율은 35.1%입니다.
- `/api/teams`의 전체·완료·실패·진행·완료율이 위 태스크 집계와 일치합니다.
- 작업 보고서는 submitted 4건, missed 2건입니다. 누락 사유와 대상 보고서는 미확인입니다.
- 에이전트 데이터:
  - opencode: working, 누계 1,369건, 성공률 26%, 24시간 실패 14건
  - codex: idle, 누계 2,404건, 성공률 93%, 24시간 실패 8건
  - cursor-agent: working, 누계 3,482건, 성공률 96%, 24시간 실패 2건
- 상단 Team 상태와 `/api/agents` 상태가 충돌합니다. 상단에는 opencode·cursor-agent가 idle이고 codex가 working이지만, API 값은 그 반대입니다. 수집시각이 없어 최신 상태는 미확인입니다.
- 에이전트 누계와 최근 7일 팀 집계는 기간이 다르므로 직접적인 원인 관계를 도출할 수 없습니다.

## 2) 현재 상태

- 프로젝트 경로: `/Users/nova-ai/project/nco`
- 작업 유형: bugfix
- dirty worktree: 미확인
- 사용자 변경 파일: 미확인
- 기준 commit SHA: 미확인
- 설정 파일 위치·내용·백업 상태: 미확인
- DB 종류·접속 대상·스키마 버전·마이그레이션 도구: 미확인
- 역마이그레이션 존재 여부와 데이터 손실 가능성: 미확인
- 빌드·테스트·서비스 상태: 미확인
- 실제 복구 지점: 생성되지 않음

## 3) 3단계 복구 지점 생성안

아래 명령은 실행하지 않은 제안이며, `<...>` 값이 확인되기 전에는 실행할 수 없습니다.

### 1단계 — 사용자 변경 식별·보존

먼저 다음 정보를 수집합니다.

```sh
git status --short --branch
git diff --name-status
git diff --cached --name-status
git ls-files --others --exclude-standard
git rev-parse --verify HEAD
```

수집 결과를 `<CHECKPOINT_DIR>`에 보존합니다.

```sh
git rev-parse --verify HEAD > "<CHECKPOINT_DIR>/BASE_SHA"
git status --short --branch > "<CHECKPOINT_DIR>/STATUS.before"
git diff --binary > "<CHECKPOINT_DIR>/worktree.patch"
git diff --cached --binary > "<CHECKPOINT_DIR>/staged.patch"
git ls-files --others --exclude-standard > "<CHECKPOINT_DIR>/untracked.list"
```

- 추적되지 않은 파일은 목록을 검토한 뒤 별도 보관합니다.
- 비밀키·토큰·개인정보가 포함된 설정은 평문 공용 저장소에 넣지 않습니다.
- 작업 전후 `git status`를 대조해 원본 worktree가 바뀌지 않았음을 확인합니다.
- `reset`, `checkout`, 대량삭제는 사용하지 않습니다.

### 2단계 — 설정 및 DB 복구 자료 확정

설정 백업:

- 실제 사용 중인 설정 경로를 먼저 확인합니다.
- 각 파일의 원래 경로, 권한, 체크섬, 백업 경로를 기록합니다.
- 템플릿 명령:

```sh
cp -p "<CONFIG_PATH>" "<CHECKPOINT_DIR>/<CONFIG_BACKUP_PATH>"
```

DB 역마이그레이션:

- DB 엔진과 대상 환경을 확인합니다.
- 현재 스키마 버전과 적용된 migration ID를 조회합니다.
- DB 백업 또는 스냅샷의 복원 가능성을 먼저 검증합니다.
- `<MIGRATION_TOOL>`, `<CURRENT_VERSION>`, `<TARGET_VERSION>`을 확정합니다.
- 운영 DB에 앞서 격리된 복원본에서 역마이그레이션을 수행합니다.
- 역마이그레이션이 없거나 데이터 손실 가능성이 있으면 실행을 중단하고 forward-fix를 별도 설계합니다.

현재는 DB 정보가 없으므로 실제 역마이그레이션 명령을 안전하게 확정할 수 없습니다.

### 3단계 — 비파괴 롤백 리허설

원본 worktree를 건드리지 않고 기준 SHA의 격리 worktree를 만듭니다.

```sh
git worktree add --detach "<RECOVERY_WORKTREE>" "<BASE_SHA>"
cd "<RECOVERY_WORKTREE>"
git apply --check "<CHECKPOINT_DIR>/staged.patch"
git apply --check "<CHECKPOINT_DIR>/worktree.patch"
```

검사가 성공한 뒤에만 격리 worktree에서 복원합니다.

```sh
git apply --index "<CHECKPOINT_DIR>/staged.patch"
git apply "<CHECKPOINT_DIR>/worktree.patch"
```

이미 커밋된 변경을 되돌려야 한다면 대상 범위를 확인한 뒤 새 역커밋을 만드는 방식을 사용합니다.

```sh
git revert --no-commit "<BAD_START>^..<BAD_END>"
```

이 명령 역시 대상 commit 범위와 DB 호환성이 확정되기 전에는 실행하지 않습니다.

## 검증 체크리스트

- [ ] `BASE_SHA`가 실제 `HEAD` 출력과 일치한다.
- [ ] staged·unstaged·untracked 변경이 각각 기록됐다.
- [ ] 백업 전후 원본 worktree 상태가 동일하다.
- [ ] 패치에 비밀정보가 포함되지 않았다.
- [ ] 설정 파일별 원본 경로·권한·체크섬이 기록됐다.
- [ ] 격리 worktree에서 두 패치 모두 `git apply --check`를 통과했다.
- [ ] 추적되지 않은 파일을 충돌 없이 복원할 수 있다.
- [ ] DB 백업을 격리 환경에 실제 복원했다.
- [ ] 역마이그레이션 후 목표 스키마 버전과 핵심 데이터 불변식을 확인했다.
- [ ] 프로젝트에서 정의한 빌드·테스트·행동 프로브를 수행했다.
- [ ] 서비스 검증 시 상태 문자열뿐 아니라 HTTP 응답 본문을 확인했다.
- [ ] 애플리케이션·설정·DB 롤백 순서를 호환성 근거와 함께 기록했다.

## 변경 파일 목록

없음. 파일을 열거나 수정하지 않았습니다.

## 핵심 diff 요약

없음. diff를 생성하거나 적용하지 않았습니다.

## unverified/remaining

dirty 상태, 사용자 변경, 기준 SHA, 설정 경로, DB 정보, 실제 백업, 역마이그레이션, 롤백 리허설, 빌드 및 테스트는 모두 미확인·미수행입니다. 다음 수집은 위 1단계 읽기 전용 명령 결과부터 시작해야 합니다.
