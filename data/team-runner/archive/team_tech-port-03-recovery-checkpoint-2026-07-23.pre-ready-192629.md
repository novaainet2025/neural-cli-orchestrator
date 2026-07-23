# 03 복구 지점·롤백팀 — browser-control-extension-port

검증일: 2026-07-23 (Asia/Seoul)  
근거 수집 시각: 2026-07-23T18:57:42+0900  
필수 스펙:
`/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md`  
회사 목표 범위: cli-extensions의 P1~P4 브라우저 제어 능력을
`nova-use` Electron/WebContents 구조에 적응 이식

## 판정

`RECOVERY_GATE: BLOCKED`

`PRODUCT_SOURCE_OR_GIT_METADATA_MUTATED_BY_THIS_STEP: NO`

`CONFIG_SNAPSHOT: PARTIAL_BUT_VERIFIED`

`NCO_REPORT_ARTIFACTS_MUTATED_BY_THIS_STEP: YES`

아직 구현을 시작하면 안 된다. 세 원본 저장소가 모두 dirty이고,
`nova-use`와 `nco`의 기존 16:02 체크포인트는 현재 변경과 일치하지
않는다. `nova-use`의 구현 대상 파일 10개도 이미 수정 중이다. 현재
Electron 프로세스가 userData를 열고 있어 전체 런타임 데이터의
일관된 스냅샷도 만들지 않았다.

이번 단계에서는 세 저장소의 제품 코드·설정·Git 메타데이터를
수정·stash·commit하지 않았고,
존재하는 브라우저 설정 두 파일만 권한을 유지해 `/private/tmp`에
복제한 뒤 원본/사본 SHA-256 일치를 확인했다. 실제 격리 worktree와
fresh 전체 checkpoint는 아래 절차를 원본 쓰기 권한이 있는 실행자가
완료해야 한다.

## 1. 기준 SHA와 dirty worktree

수치는 동일 명령 묶음에서 수집했다. `worktree diff`는
`git diff --binary HEAD`, `untracked list`는 NUL 구분
`git ls-files --others --exclude-standard -z`의 SHA-256이다.

| 저장소 | 브랜치 / 기준 HEAD | unstaged | staged | untracked | worktree diff SHA-256 | untracked list SHA-256 |
|---|---|---:|---:|---:|---|---|
| nova-use | `main` / `408718d1739bcea747c3c863f75da5ac5a600446` | 63 | 4 | 162 | `d7c19079facaaee94ee343727aeea7506a4dde6c7f2135728d04a00704645560` | `5b7f4af613ba2f29da63d664595b1377cf835c208e7769cce4dfe830d08cd5de` |
| nco | `main` / `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 0 | 434 | `b274fa0be966d7b0615d2c250e532d5e14171123847becd081bce8c0fb266df8` | `a556844a3b867336471db066577d7e672468e92a43f0b8b8a79e423f24042b8b` |
| nova-ax | `main` / `7644131db39062ffad62f0a1a61cf55c32bc9ab1` | 2 | 0 | 8 | `045e54efb7caec9fc3a6d9305d2035ea53eb80b8c20d590ce5e8f3f0fbbfbcfc` | `262210b4ee085088e492bbabd3a18b423fa40269317793cc409ca612489ad5f1` |

`nova-use` untracked 수는 18:54의 158개에서 18:57의 162개로,
`nco`는 432개에서 434개로 증가했다. 이는 작업 트리가 실행 중에도
변하는 상태라는 직접 증거다. 다음 단계는 오래된 수치를 재사용하지
말고 쓰기 주체를 멈춘 직후 다시 캡처해야 한다.

### nova-use 충돌 지점

스펙이 지정한 다음 파일이 이미 수정 상태다.

- `src/main/agent-browser-adapter.ts`
- `src/main/agent-control.ts`
- `src/main/browser-consent.ts`
- `src/main/browser.ts`
- `src/main/policy.ts`
- `src/shared/ipc.ts`
- `tests/agent-browser-adapter.spec.ts`
- `tests/agent-control.spec.ts`
- `tests/browser-consent.spec.ts`
- `tests/browser.spec.ts`

이 10개 파일의 unstaged binary diff는 102,619바이트,
SHA-256은
`5b00fd5d297ced3c4c5777252c1378776581e19e3a0cab2f526432756432a8ea`다.
P2 후보 `src/main/browser-learning.ts`는 아직 존재하지 않는다.
소유자 확인 없이 이 변경을 자동 적용하거나 덮어쓰면 안 된다.

### 기존 체크포인트 평가

세 저장소의 `checkpoints/uncommitted_changes.patch`는 모두
`git apply --numstat` 파싱에 성공했다. 그러나 이 파일은
2026-07-23T16:02:01+0900에 생성됐고 untracked 파일 내용은 담지 않는다.

| 저장소 | 기존 patch SHA-256 | 현재성 |
|---|---|---|
| nova-use | `5db705934566b7fcfd76a989ecc0e66810c010c812ea01f1158979977d124a31` | 현재 diff와 불일치 — stale |
| nco | `7a3a64d261bcace96c5694baa10ae6fc4148ce88ca7cd076f6b1c88f623dcb65` | 현재 diff와 불일치 — stale |
| nova-ax | `045e54efb7caec9fc3a6d9305d2035ea53eb80b8c20d590ce5e8f3f0fbbfbcfc` | tracked diff는 일치하나 untracked 내용 미보존 |

따라서 기존 체크포인트만으로 세 저장소의 현재 상태를 복원할 수 있다고
주장하지 않는다.

## 2. 복구 자산과 설정 백업

Electron userData의 확인 경로는
`/Users/nova-ai/Library/Application Support/nova-use`다.
`lsof +D`와 `SingletonLock`에서 Electron PID `34706`이 이 디렉터리를
사용 중임을 확인했다. 실행 중인 Chromium DB 전체를 단순 복사하면
일관성이 깨질 수 있으므로 전체 디렉터리는 복사하지 않았다.

이번 이식과 직접 관련된 현재 JSON 상태:

| 파일 | 상태 | 크기 / mode | SHA-256 |
|---|---|---|---|
| `browser-agent-settings.json` | 존재, 백업 완료 | 273바이트 / `0600` | `c0a97cfa9a10d1ff425db46d7b1018232d5d0b9b8635138ea6872e077aae3635` |
| `browser-bookmarks.json` | 존재, 백업 완료 | 510바이트 / `0600` | `4c29877c5b129c8159e025116621e733f6b75cc70bf7e10f58d3720f6efa8bd4` |
| `settings.json` | 없음 | — | — |
| `automation-policy.json` | 없음, 내장 default-deny 사용 | — | — |
| `browser-profiles.json` | 없음, 기본 profile 사용 | — | — |
| `browser-learning.json` | 없음, P2 미구현 | — | — |
| `browser-shared-learning.json` | 없음 | — | — |

검증된 설정 사본:

`/private/tmp/nova-use-browser-control-recovery-20260723T185742+0900`

디렉터리는 `0700`, 두 사본은 `0600`이며 각 원본/사본의 SHA-256이
정확히 일치했다. `/private/tmp`는 재부팅 후 보존을 보장하지 않으므로
이는 단기 복구 자산이다. 구현 전 앱을 정상 종료한 뒤 아래와 같이
동일 사용자 전용의 지속 경로로 한 번 더 복제해야 한다.

```bash
user_data_dir='/Users/nova-ai/Library/Application Support/nova-use'
backup_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-20260723T185742+0900'

install -d -m 700 "$backup_dir"
for item_name in \
  browser-agent-settings.json \
  browser-bookmarks.json \
  browser-profiles.json \
  automation-policy.json \
  browser-learning.json
do
  source_file="$user_data_dir/$item_name"
  if test -f "$source_file"; then
    cp -p "$source_file" "$backup_dir/$item_name"
    chmod 600 "$backup_dir/$item_name"
  fi
done

lsof +D "$user_data_dir"
find "$backup_dir" -maxdepth 1 -type f -exec shasum -a 256 {} \;
```

`lsof`가 Electron 항목을 반환하면 전체 userData/Chromium 저장소
백업을 진행하지 않는다. 브라우저 쿠키, 인증 저장소,
`secrets.enc.json`은 이번 이식 대상이 아니며 저장소나 보고서로
복사하지 않는다.

## 3. 격리 worktree와 브랜치

현재 동일 이름 브랜치는 없고 아래 예정 경로도 존재하지 않는다.
기존 `*-cognee` worktree는 별도 작업이므로 재사용하지 않는다.

| 저장소 | 기존 추가 worktree | 이 단계의 예정 브랜치 | 예정 경로 | 실행 상태 |
|---|---|---|---|---|
| nova-use | `nova-use-cognee` | `feat/browser-control-port-20260723` | `/Users/nova-ai/project/nova-use-browser-control-port` | 미생성 |
| nco | `nco-cognee`, prunable detached 2개 | `ops/browser-control-port-recovery-20260723` | `/Users/nova-ai/project/nco-browser-control-port` | 미생성 |
| nova-ax | `nova-ax-cognee` | `ops/browser-control-port-compat-20260723` | `/Users/nova-ai/project/nova-ax-browser-control-port` | 미생성 |

이 세 저장소의 `.git`은 현재 실행 환경에서 읽기 전용이라 branch와
worktree를 만들지 않았다. 원본 쓰기 권한이 있는 실행자가 아래 명령을
사용한다.

```bash
git -C /Users/nova-ai/project/nova-use worktree add \
  -b feat/browser-control-port-20260723 \
  /Users/nova-ai/project/nova-use-browser-control-port \
  408718d1739bcea747c3c863f75da5ac5a600446

git -C /Users/nova-ai/project/nco worktree add \
  -b ops/browser-control-port-recovery-20260723 \
  /Users/nova-ai/project/nco-browser-control-port \
  4adf31725bad1f44220d04952151c8197469f6e1

git -C /Users/nova-ai/project/nova-ax worktree add \
  -b ops/browser-control-port-compat-20260723 \
  /Users/nova-ai/project/nova-ax-browser-control-port \
  7644131db39062ffad62f0a1a61cf55c32bc9ab1
```

실제 P1~P4 구현은 `nova-use` worktree에만 한다. `nco`와 `nova-ax`는
호환성 검증이 명시적으로 필요할 때까지 read-only다. 원본 main의
dirty patch를 새 worktree에 통째로 적용하지 않는다. 특히 위 10개
충돌 파일은 소유자와 hunk 단위로 분리한 뒤 필요한 변경만 옮긴다.

### fresh Git 체크포인트 절차

쓰기를 발생시키는 앱/팀 작업을 먼저 멈추고, 각 저장소마다 다음을
수행한다. 이 절차는 working tree를 바꾸지 않는다.

```bash
repository='/Users/nova-ai/project/nova-use'
checkpoint_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/git-nova-use-20260723T185742+0900'

install -d -m 700 "$checkpoint_dir"
git -C "$repository" rev-parse HEAD
git -C "$repository" diff --binary HEAD \
  --output="$checkpoint_dir/tracked.patch"

(
  cd "$repository"
  git ls-files --others --exclude-standard -z |
    tee "$checkpoint_dir/untracked-files.nul" |
    tar --null -czf "$checkpoint_dir/untracked-files.tar.gz" -T -
)

git apply --numstat "$checkpoint_dir/tracked.patch"
tar -tzf "$checkpoint_dir/untracked-files.tar.gz" >/dev/null
shasum -a 256 \
  "$checkpoint_dir/tracked.patch" \
  "$checkpoint_dir/untracked-files.nul" \
  "$checkpoint_dir/untracked-files.tar.gz"
```

`repository`와 `checkpoint_dir`을 nco, nova-ax의 절대경로로 바꿔
반복한다. 캡처 전후 `HEAD`, tracked 개수, untracked 목록 SHA가
같아야 checkpoint를 유효로 판정한다. 달라지면 쓰기 주체가 남아 있는
것이므로 해당 캡처는 폐기하지 말고 `stale`로 표기한 뒤 재시도한다.

## 4. DB 마이그레이션 역방향 절차

이번 P1~P4 스펙은 nova-use main 프로세스의 제한된 JSON 학습 저장소를
요구하며 SQL DB나 스키마 마이그레이션을 요구하지 않는다.
`nova-use`에는 tracked DB/migration 파일도 없다.

따라서 정상 구현의 DB 역방향 절차는 `N/A`다.

- P2 학습 데이터는 `app.getPath('userData')` 아래 단일 파일이어야 한다.
- rollback 때 파일을 삭제하지 말고 앱 종료 후 백업 디렉터리로
  이동해 복구 가능하게 격리한다.
- nco와 nova-ax의 DB/마이그레이션은 이 회사 목표에서 수정 금지다.
- 구현 diff에 `.sql`, migration runner, NCO/nova-ax DB 쓰기가 생기면
  스펙 이탈로 차단하고 별도 승인·down migration rehearsal을 요구한다.

현재 DB를 읽기 전용 `PRAGMA quick_check`로 확인한 결과:

| DB | 크기 | tables | quick_check |
|---|---:|---:|---|
| `/Users/nova-ai/project/nco/db/nco.db` | 335,814,656바이트(최초 측정) | 116 | `ok` |
| `/Users/nova-ai/project/nco/db/nco.db.cognee-bak` | 335,036,416바이트 | 116 | `ok` |
| `/Users/nova-ai/project/nova-ax/db/nova-ax.db` | 47,448,064바이트 | 60 | `ok` |
| `/Users/nova-ai/project/nova-ax/db/nova-ax.db.cognee-bak-20260723T1803+0900` | 47,423,488바이트 | 60 | `ok` |
| `/Users/nova-ai/project/nova-ax/nova-ax.db.cognee-bak` | 0바이트 | 0 | SQLite 빈 DB로 열림 — 복구에 사용 금지 |

live DB는 실행 중 증가할 수 있어 위 크기는 관찰 시점 값이다. 기존
`cognee-bak`은 다른 작업의 복구 자산이며 browser-control 이식의
fresh DB checkpoint로 간주하지 않는다.

## 5. 롤백 명령과 순서

### A. merge 전

격리 worktree의 변경을 main에 합치지 않는다. 실패 시 원본 main은
그대로이므로 앱을 원본 빌드로 실행하고, 격리 worktree는 보존해
원인을 분석한다. `git reset --hard`, `git clean`, stash,
worktree 강제 제거를 사용하지 않는다.

### B. merge 후

1. nova-use를 정상 종료한다.
2. port commit SHA를 식별하고 `git revert <port-commit-sha>`로
   새 역커밋을 만든다. 공유 main을 reset하지 않는다.
3. 새 P2 파일은 삭제 대신 격리한다.
4. 설정을 실제로 변경한 경우에만 검증된 사본을 복원한다.
5. typecheck/build/test와 runtime smoke를 다시 수행한다.

P2 파일 격리 예시:

```bash
user_data_dir='/Users/nova-ai/Library/Application Support/nova-use'
rollback_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-rollback'

install -d -m 700 "$rollback_dir"
if test -f "$user_data_dir/browser-learning.json"; then
  mv "$user_data_dir/browser-learning.json" \
    "$rollback_dir/browser-learning.json.disabled-20260723"
fi
```

설정 복원은 먼저 현재 파일을 별도 이름으로 보존한 뒤 수행한다.

```bash
user_data_dir='/Users/nova-ai/Library/Application Support/nova-use'
backup_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-20260723T185742+0900'
rollback_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-rollback'

install -d -m 700 "$rollback_dir"
for item_name in browser-agent-settings.json browser-bookmarks.json browser-profiles.json automation-policy.json
do
  live_file="$user_data_dir/$item_name"
  backup_file="$backup_dir/$item_name"
  if test -f "$live_file"; then
    cp -p "$live_file" "$rollback_dir/$item_name.before-restore"
  fi
  if test -f "$backup_file"; then
    cp -p "$backup_file" "$live_file"
    chmod 600 "$live_file"
  fi
done
```

위 merge/revert/restore 명령은 실제 port commit과 지속 백업이 생긴 뒤
명시적 rollback 승인 아래에서만 실행한다.

## 6. 검증 체크리스트

- [x] 필수 스펙을 먼저 읽었다.
- [x] 세 저장소 HEAD, branch, dirty 개수와 지문을 직접 수집했다.
- [x] 기존 checkpoint patch 세 개가 파싱되는지 확인했다.
- [x] 기존 checkpoint의 stale/untracked 미보존 gap을 식별했다.
- [x] 구현 대상 파일의 기존 충돌을 식별했다.
- [x] 브라우저 설정 두 파일을 0700/0600 경로에 복제하고 SHA-256을
  원본과 대조했다.
- [x] nco/nova-ax live DB와 기존 백업을 읽기 전용 quick_check했다.
- [ ] Electron 종료 후 지속 설정 백업을 만들고 해시를 다시 대조한다.
- [ ] 세 저장소의 fresh tracked patch + untracked archive를 만든다.
- [ ] 세 격리 worktree/branch를 실제 생성한다.
- [ ] nova-use 충돌 10개 파일의 소유자/hunk를 분리한다.
- [ ] P1~P4 구현 후 nova-use `npm run typecheck`, `npm run build`,
  `npm test`를 통과시킨다.
- [ ] rollback rehearsal에서 P2 파일 격리, 설정 복원, 재빌드를
  검증한다.
- [x] nco `npm run build`를 통과시켰다(`tsc`, exit 0).

## 7. 검증 영수증

| 변경/관찰 | 검증방법 | 등급 | Gap | 미검증항목 |
|---|---|---|---|---|
| 스펙 범위 고정 | 지정 파일 직접 읽기 | Evidence Tier 1 | 없음 | 없음 |
| Git 기준선 | `rev-parse`, `status`, diff/list SHA-256 | Evidence Tier 1 | 작업 트리가 계속 변함 | fresh 정지시점 캡처 |
| 기존 patch | `git apply --numstat` | Evidence Tier 1 | stale, untracked 내용 없음 | 실제 복원 rehearsal |
| 설정 단기 사본 | mode/size/SHA-256 원본-사본 대조 | Evidence Tier 1 | `/private/tmp` 수명, 앱 실행 중 | 지속 사본 |
| DB 무결성 | `sqlite3 -readonly`, `PRAGMA quick_check` | Evidence Tier 1 | 다른 작업의 backup | browser-port fresh backup은 불필요/미생성 |
| 격리 worktree | 브랜치·경로 충돌 여부 읽기 확인 | Evidence Tier 1(사전조건) | `.git` 쓰기 권한 없음 | 실제 생성 |
| nco build | `npm run build` → `tsc`, exit 0 | Evidence Tier 1 | 없음 | 없음 |
| nova-use P1~P4 T1 | 미실행 | 미검증 | 구현 전 단계 | typecheck/build/test/runtime |

## 미검증항목과 handoff 조건

이 문서는 복구 설계 자체는 실측으로 보정했지만, 복구 게이트를
통과했다고 선언하지 않는다. 다음 구현 팀은 아래 네 조건을 모두
충족한 영수증을 첨부해야 한다.

1. 쓰기 주체가 멈춘 동일 시점의 fresh Git checkpoint.
2. 지속 경로의 설정 backup과 원본 해시 일치.
3. 실제 `nova-use` 격리 worktree 생성 및 10개 충돌 파일의 소유자 확인.
4. P1~P4 구현 뒤 T1 `typecheck + build + test` 통과와 rollback rehearsal.

이 네 조건 전에는 `RECOVERY_GATE`를 `READY`로 바꾸지 않는다.
