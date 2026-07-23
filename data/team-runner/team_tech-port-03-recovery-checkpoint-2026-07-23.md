# 03 복구 지점·롤백팀 — browser-control-extension-port

검증일: 2026-07-23 (Asia/Seoul)  
근거 수집 시각: 2026-07-23T19:21:46+0900 (자산 생성) / 재검증 2026-07-23T19:26:13+0900  
필수 스펙: `/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md`  
원본: `/Users/nova-ai/project/크롬확장프로그램/cli-extensions`  
대상: `/Users/nova-ai/project/nova-use`  
회사 목표 범위: P1~P4 (Comprehension/Affordance/playbook/autoMission, shared-learning, Force 검증 래더, destructive 게이트)

## 판정

`RECOVERY_GATE: READY`

`PRODUCT_SOURCE_OR_MAIN_WORKTREE_MUTATED_BY_THIS_STEP: NO`

`GIT_METADATA_MUTATED_BY_THIS_STEP: YES` (격리 worktree/branch 추가만; main dirty 보존)

`CONFIG_SNAPSHOT: VERIFIED_PERSISTENT`

`NCO_REPORT_ARTIFACTS_MUTATED_BY_THIS_STEP: YES`

이전 판정 `BLOCKED`(18:57) 원인 — `.git` 읽기 전용·격리 worktree 미생성·fresh checkpoint 부재·지속 설정 백업 부재 — 는 19:21에 해소했다.  
Electron PID `34706`은 여전히 userData를 점유 중이므로 Chromium Cookies/Local Storage 전체 복사는 하지 않았다(이식 범위 밖·일관성 위험). JSON 설정 2건만 지속 경로에 백업했고 원본과 SHA-256 일치.

**구현 팀은 반드시 격리 worktree에서만 P1~P4를 진행한다. 원본 main dirty 10개 충돌 파일을 덮어쓰지 않는다.**

## 1. 기준 SHA와 dirty worktree

동일 명령 묶음(19:21~19:26)에서 수집. `worktree diff` = `git diff --binary HEAD` SHA-256, `untracked list` = NUL 구분 `git ls-files --others --exclude-standard -z` SHA-256.

| 저장소 | 브랜치 / 기준 HEAD | unstaged | staged | untracked | tracked.diff SHA-256 (checkpoint) | untracked.nul SHA-256 |
|---|---|---:|---:|---:|---|---|
| nova-use | `main` / `408718d1739bcea747c3c863f75da5ac5a600446` | 63 | 4 | 168→173 | `58c5519a91a19e671effb580faa8ae8291392c0f7f6771690771358a126d4b50` | `13a23f2bb3a6b7e4613049baeb3784850a7353de1e50ec20ba11deaabf723caf` |
| nco | `main` / `4adf31725bad1f44220d04952151c8197469f6e1` | 115 | 0 | 512→554 | `0fa5be487160b95669004fad77343eccd05794920ca1072722532f4347fc8c7f` | `8b8d676cb2a0b9d3a02ef4e5f6d65e1586d9b114b863795409f085b0007bfb1b` |
| nova-ax | `main` / `7644131db39062ffad62f0a1a61cf55c32bc9ab1` | 2 | 0 | 8 | `045e54efb7caec9fc3a6d9305d2035ea53eb80b8c20d590ce5e8f3f0fbbfbcfc` | `262210b4ee085088e492bbabd3a18b423fa40269317793cc409ca612489ad5f1` |

untracked 수가 측정 중에도 증가(nova-use 168→173, nco 512→554) — 쓰기 주체가 남아 있다. tracked.diff SHA는 B측정↔F체크포인트 구간에서 안정. fresh checkpoint는 19:21 시점 스냅샷으로 유효하며, 구현 착수 직전 재해시 대조를 권장한다.

### nova-use 충돌 지점 (스펙 지정 10파일 — 모두 dirty)

| 파일 | porcelain |
|---|---|
| `src/main/agent-browser-adapter.ts` | ` M` |
| `src/main/agent-control.ts` | ` M` |
| `src/main/browser-consent.ts` | ` M` |
| `src/main/browser.ts` | ` M` |
| `src/main/policy.ts` | ` M` |
| `src/shared/ipc.ts` | ` M` |
| `tests/agent-browser-adapter.spec.ts` | ` M` |
| `tests/agent-control.spec.ts` | ` M` |
| `tests/browser-consent.spec.ts` | ` M` |
| `tests/browser.spec.ts` | ` M` |

10파일 합산 binary diff vs HEAD: 102,619 bytes, SHA-256 `5b00fd5d297ced3c4c5777252c1378776581e19e3a0cab2f526432756432a8ea` (19:26 재확인 동일).  
P2 후보 `src/main/browser-learning.ts`는 **부재**. 소유자 확인·hunk 분리 없이 덮어쓰기 금지.

### 기존 16:02 checkpoint 평가

| 저장소 | `checkpoints/uncommitted_changes.patch` | 현재성 |
|---|---|---|
| nova-use | SHA `5db70593…124a31` | stale — 현재 diff와 불일치, untracked 미포함 |
| nco | SHA `7a3a64d2…23dcb65` | stale — 현재 diff와 불일치, untracked 미포함 |
| nova-ax | SHA `045e54ef…fbbfbcfc` | tracked는 일치, untracked 내용 미보존 |

→ 기존 16:02만으로 현재 상태 복원 불가. **19:21 fresh checkpoint를 사용한다.**

## 2. 복구 자산과 설정 백업

Electron userData: `/Users/nova-ai/Library/Application Support/nova-use`  
SingletonLock → `nova-macstudio-34706` (PID 34706 실행 중, 19:26 재확인).

| 파일 | 상태 | 크기/mode | SHA-256 (live = backup) |
|---|---|---|---|
| `browser-agent-settings.json` | 백업 완료 | 273B / `0600` | `c0a97cfa9a10d1ff425db46d7b1018232d5d0b9b8635138ea6872e077aae3635` |
| `browser-bookmarks.json` | 백업 완료 | 510B / `0600` | `4c29877c5b129c8159e025116621e733f6b75cc70bf7e10f58d3720f6efa8bd4` |
| `settings.json` | 없음 | — | — |
| `automation-policy.json` | 없음 (default-deny) | — | — |
| `browser-profiles.json` | 없음 | — | — |
| `browser-learning.json` | 없음 (P2 미구현) | — | — |

검증된 백업 경로:

1. 단기: `/private/tmp/nova-use-browser-control-recovery-20260723T185742+0900` (0700/0600, SHA MATCH)
2. **지속**: `/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-2026-07-23T19:21:46+0900/` (0700/0600, SHA MATCH — 19:26 재확인)

쿠키·인증 저장소·`secrets.enc.json`은 이식 대상이 아니며 복사하지 않았다.

## 3. 격리 worktree와 브랜치 (생성 완료)

| 저장소 | 브랜치 | 경로 | HEAD | 상태 |
|---|---|---|---|---|
| nova-use | `feat/browser-control-port-20260723` | `/Users/nova-ai/project/nova-use-browser-control-port` | `408718d` | **생성됨** (exit 0) |
| nco | `ops/browser-control-port-recovery-20260723` | `/Users/nova-ai/project/nco-browser-control-port` | `4adf317` | **생성됨** (exit 0) |
| nova-ax | `ops/browser-control-port-compat-20260723` | `/Users/nova-ai/project/nova-ax-browser-control-port` | `7644131` | **생성됨** (exit 0) |

기존 `*-cognee` worktree는 별도 작업 — 재사용하지 않음.  
실제 P1~P4 구현은 **nova-use worktree만**. nco/nova-ax worktree는 호환성 검증용 read-only.  
원본 main dirty patch를 worktree에 통째 적용하지 않는다.

### fresh Git 체크포인트 (생성·검증 완료)

Base: `/Users/nova-ai/Library/Application Support/nova-use-recovery/git-<repo>-2026-07-23T19:21:46+0900/`

| 저장소 | tracked.patch | untracked.nul | untracked.tar.gz | apply --numstat | tar -tzf |
|---|---|---|---|---|---|
| nova-use | `58c5519a…4b50` (656,620B) | `13a23f2b…3caf` | `90b75209…f6b6` (6.8MB) | exit 0 | exit 0 |
| nco | `0fa5be48…8c7f` (1,693,088B) | `8b8d676c…fb1b` | `4a77e0e7…ef0d` (147MB) | exit 0 | exit 0 |
| nova-ax | `045e54ef…bcfc` (2,677B) | `262210b4…d5f1` | `0d3fea8f…ddfa` (14.5MB) | exit 0 | exit 0 |

각 디렉터리에 `tracked.patch`, `untracked-files.nul`, `untracked-files.tar.gz`, `shasums.txt` 존재 확인(T1 `ls`).

## 4. DB 마이그레이션 역방향 절차

P1~P4 스펙은 SQL/스키마 마이그레이션을 **요구하지 않음**. nova-use tracked DB/migration 파일 없음.  
정상 구현의 DB 역방향 = **N/A**.

- P2 학습 데이터는 `userData` 단일 JSON → rollback 시 삭제 대신 격리 이동.
- nco/nova-ax DB·migration은 회사 목표에서 **수정 금지**.
- 구현 diff에 `.sql`/migration runner/NCO·nova-ax DB 쓰기 발생 시 스펙 이탈로 차단.

읽기 전용 `PRAGMA quick_check` (19:23~19:26):

| DB | size | quick_check |
|---|---:|---|
| `/Users/nova-ai/project/nco/db/nco.db` | 336,175,104 | `ok` |
| `/Users/nova-ai/project/nova-ax/db/nova-ax.db` | 47,489,024 | `ok` |
| `/Users/nova-ai/project/nova-ax/nova-ax.db.cognee-bak` | 0 | 빈 DB — **복구 사용 금지** |

기존 `cognee-bak`은 타 작업 자산이며 browser-control fresh DB checkpoint로 간주하지 않는다.

## 5. 롤백 명령과 순서

### A. merge 전 (권장 기본)

격리 worktree 변경을 main에 합치지 않는다. 실패 시 원본 main 유지 → 앱을 원본 빌드로 실행.  
`git reset --hard` / `git clean` / stash / worktree 강제 제거 **사용 금지**(사용자 dirty 보존).

### B. merge 후 (명시적 rollback 승인 시에만)

1. nova-use 정상 종료.
2. `git revert <port-commit-sha>` (공유 main reset 금지).
3. P2 JSON은 삭제 대신 격리:

```bash
user_data_dir='/Users/nova-ai/Library/Application Support/nova-use'
rollback_dir='/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-rollback'
install -d -m 700 "$rollback_dir"
test -f "$user_data_dir/browser-learning.json" && \
  mv "$user_data_dir/browser-learning.json" \
     "$rollback_dir/browser-learning.json.disabled-$(date +%Y%m%dT%H%M%S%z)"
```

4. 설정 변경 시에만 검증된 지속 백업에서 복원(복원 전 live를 `.before-restore`로 보존).
5. `npm run typecheck` / `npm run build` / `npm test` + runtime smoke 재실행.

### C. main dirty 복원 (사고 시)

```bash
# nova-use 예시 — tracked만. untracked는 tar에서 선택 복원.
checkpoint='/Users/nova-ai/Library/Application Support/nova-use-recovery/git-nova-use-2026-07-23T19:21:46+0900'
git -C /Users/nova-ai/project/nova-use apply --check "$checkpoint/tracked.patch"  # dry-run
# 승인 후: git apply "$checkpoint/tracked.patch"
```

## 6. 검증 체크리스트

- [x] 필수 스펙 선독
- [x] 세 저장소 HEAD/branch/dirty/지문 실측
- [x] 기존 16:02 checkpoint stale/untracked gap 식별
- [x] 구현 대상 10파일 충돌 식별 + 합산 diff SHA
- [x] 설정 JSON 2건 단기+지속 백업, SHA-256 live=backup
- [x] nco/nova-ax DB readonly quick_check=ok
- [x] 세 격리 worktree/branch 실제 생성 (경로·gitdir 확인)
- [x] fresh tracked.patch + untracked archive 생성, apply/tar 검증
- [x] nco `npm run build` → `tsc` EXIT:0 (19:26)
- [ ] Electron 종료 후 Chromium 저장소 전체 스냅샷 (범위 밖·선택)
- [ ] 충돌 10파일 소유자/hunk 분리 (구현팀)
- [ ] P1~P4 구현 후 nova-use typecheck/build/test T1
- [ ] rollback rehearsal (P2 격리·설정 복원·재빌드)

## 7. 검증 영수증

| 변경/관찰 | 검증방법 | 등급 | Gap | 미검증항목 |
|---|---|---|---|---|
| 스펙 범위 고정 | 지정 md 직접 읽기 | T1 | 없음 | 없음 |
| Git 기준선 | rev-parse/status/diff SHA | T1 | untracked 계속 증가 | 착수 직전 재캡처 권장 |
| 지속 설정 백업 | mode + SHA live=backup | T1 | Electron 실행 중 | Chromium 전체 DB |
| fresh checkpoint | shasums.txt + apply/tar | T1 | nco untracked churn | 없음 |
| 격리 worktree | `ls` 경로 + `.git` gitdir | T1 | 없음 | 없음 |
| DB 무결성 | sqlite3 readonly quick_check | T1 | 0B cognee-bak 사용금지 | browser-port DB N/A |
| nco build | `npm run build` → tsc EXIT:0 | T1 | 없음 | 없음 |
| nova-use P1~P4 T1 | 미실행 | 미검증 | 구현 전 | typecheck/build/test |

## 8. 변경 파일 목록과 핵심 diff

### 변경 파일 목록

- `data/team-runner/team_tech-port-03-recovery-checkpoint-2026-07-23.md` (본 보고서 READY 갱신)
- `data/team-runner/archive/team_tech-port-03-recovery-checkpoint-2026-07-23.pre-ready-192629.md` (직전 BLOCKED 보존)
- `/Users/nova-ai/Library/Application Support/nova-use-recovery/browser-control-port-2026-07-23T19:21:46+0900/` (설정 백업 신규)
- `/Users/nova-ai/Library/Application Support/nova-use-recovery/git-{nova-use,nco,nova-ax}-2026-07-23T19:21:46+0900/` (fresh checkpoint 신규)
- `/Users/nova-ai/project/nova-use-browser-control-port` (격리 worktree 신규)
- `/Users/nova-ai/project/nco-browser-control-port` (격리 worktree 신규)
- `/Users/nova-ai/project/nova-ax-browser-control-port` (격리 worktree 신규)

제품 소스(main worktree의 P1~P4 대상 파일)는 이 단계에서 **수정하지 않음**.

### 핵심 diff 요약

- `RECOVERY_GATE`를 `BLOCKED` → `READY`로 갱신(격리 worktree·fresh checkpoint·지속 설정 백업 완료).
- 세 저장소 기준 HEAD 고정: nova-use `408718d`, nco `4adf317`, nova-ax `7644131`.
- dirty 보존 절차·10파일 충돌 SHA·DB N/A 역방향·merge 전/후 롤백 명령·검증 체크리스트를 실측으로 확정.
- nco `tsc` EXIT:0 영수증 첨부.

## handoff

다음 구현 팀 진입 조건(충족):

1. fresh Git checkpoint 존재 ✓  
2. 지속 경로 설정 backup + 해시 일치 ✓  
3. nova-use 격리 worktree 실제 생성 ✓  
4. (구현 후) T1 typecheck+build+test + rollback rehearsal — **미실시, 구현팀 담당**

작업 디렉터리: `/Users/nova-ai/project/nova-use-browser-control-port`  
브랜치: `feat/browser-control-port-20260723`  
금지: main dirty 덮어쓰기, chrome.* 복붙, 기존 ref/FORCE/CDP/deepInspect/capture/PolicyEngine 재구현, nco/nova-ax DB 변경.
