# NCO Triad Ultra 운영 설계·설정 보고서

작성일: 2026-07-23 KST

## 결론

Claude, Codex, AGY를 같은 일에 중복 투입하지 않는다. 권한이 다른 비대칭 Triad로 운영하고, 기계 증거가 통과한 결과만 승인한다.

- Claude (`claude-code`, inter-session `nova-macstudio-claude-4`): Commander/Judge. 요구사항, 아키텍처, 위험, 순차 머지, 최종 판정. 구현 파일은 수정하지 않는다.
- Codex (`codex`, inter-session `codex-triad`): Builder/Verifier. 선언된 `plannedPaths` 안에서 구현·테스트·리팩터링·통합한다.
- AGY (`agy`, inter-session `antigravity`): Experience Architect/Adversarial Reviewer. UI·UX·접근성·화면 상태·사용자 경로 변경에만 reactive 참여한다.

표준 흐름은 `Plan → Build → Challenge → Fix → Prove → Approve`다. Fix는 최대 3회이며, 실패 집합이 줄지 않거나 새 회귀가 생기면 즉시 중단하고 사람에게 에스컬레이션한다.

## 회사와 팀

- 회사: `org_nco-triad-ultra`
- 지휘·판정팀: `team_triad-command-judge`
- 구현·검증팀: `team_triad-build-verify`
- 경험 반대심문팀: `team_triad-experience-challenge`
- 목표: `goal_triad_5x_2026_07`

DB에는 3개 팀과 provider/inter-session 멤버 6개가 등록돼 있다.
회사와 팀의 `is_always_on`은 0이다. 일반 team-runner가 주기적으로 세 provider를 깨우지 않고 Triad API의 task trigger에만 반응한다.

## 동시성·격리 계약

- Claude 1 lane
- Codex 최대 2 lane
- AGY 1 lane
- 전체 유료 CLI 최대 4 lane

Codex 2개 lane은 `plannedPaths`가 서로 겹치지 않을 때만 허용한다. 물리적으로 가능한 작업은 subtask별 git worktree를 우선 사용한다. 공유 working tree에서는 파일 소유권과 Redis lock을 fallback으로 사용하며, 충돌 시 lock을 빼앗지 않고 해당 실행을 중단·재계획한다. DB, HNSW index, `team-runner/*.last`, `node_modules`는 공유 쓰기 소유 대상에서 제외한다.

Redis가 연결되지 않은 공유 working tree의 실제 쓰기 요청은 fail-closed로 거절한다. UI 작업에서 AGY가 불가용한 경우에도 대체 리뷰어가 접근성 계약을 자동 면제하지 않으며, 실행을 `blocked-human-escalation`으로 전환한다.

## 증거 게이트

모든 코드 작업:

1. verifier exit code 0
2. 행동 검증 테스트/probe
3. 실행 중 변경 파일이 선언된 `ownedFiles` 안에만 존재

UI/UX 작업은 위 증거에 더해 아래 3개를 모두 요구한다.

1. visual regression 또는 DOM 무결성
2. a11y 검사
3. 실제 user-path 검사

작성자의 자연어 “완료” 보고는 증거가 아니다. NCO가 명령을 별도로 재실행하고 stdout, exit code, diff scope를 영수증으로 보관한다. 태스크별 verifier는 해당 태스크의 `metadata.projectDir`에서 실행된다.

## 실행 API

정책 조회:

```bash
curl http://127.0.0.1:6200/api/triad/policy
```

비용 없이 계획 확인:

```bash
curl -X POST http://127.0.0.1:6200/api/triad/run \
  -H 'content-type: application/json' \
  -d '{"goal":"백엔드 SQLite 버그 수정","projectDir":"/Users/nova-ai/project/nco","dryRun":true}'
```

실제 코드 실행은 `ownedFiles`와 최소 두 증거 명령을 선언한다.

```json
{
  "goal": "백엔드 버그를 수정하고 회귀 테스트를 추가",
  "projectDir": "/path/to/isolated-worktree",
  "profile": "standard",
  "ownedFiles": ["src/core/example.ts", "src/core/example.test.ts"],
  "proofCommands": [
    {"name": "build", "command": "npm run build", "kind": "verifier_exit_0"},
    {"name": "focused-test", "command": "npx vitest run src/core/example.test.ts", "kind": "behavior_probe"}
  ]
}
```

UI 작업에는 `visual_or_dom`, `a11y`, `user_path` 종류의 proof command를 각각 하나 이상 추가해야 한다. 하나라도 빠지면 provider를 호출하기 전에 요청을 거절한다.

## 500% 인증 규칙

500%는 설정 목표이며 아직 달성 주장으로 인증되지 않았다. 동일 task class와 동일 host에서 baseline/Triad를 최소 3회씩 짝지어 측정한다.

- 1차 지표: `verified subtasks / wall-clock hour`
- 통과: 중앙값 throughput 배수 `>= 5.0`
- 품질 가드: false-pass rate와 post-merge defects가 baseline보다 증가하지 않음
- 병렬 효율: 중앙값 `(baseline wall time / candidate wall time) / average workers > 0.7`
- 표본: paired T1 receipts `r >= 3`

빌드 후 다음 명령으로 receipt JSON을 인증한다.

```bash
npm run build
node scripts/triad-certify.mjs /path/to/paired-receipts.json
```

한 조건이라도 실패하면 exit code 1과 함께 `certified: false`를 반환한다.

## 인터세션 메뉴

Codex 커스텀 메뉴는 `~/.codex/prompts/inter-session.md`에 설치됐다. 새 Codex 대화에서 다음처럼 사용한다.

```text
/prompts:inter-session ACTION=connect NAME=codex-triad
```

현재 설계 세션에서는 `codex-triad`, `nova-macstudio-claude-4`, `antigravity`가 실제 인터세션 메시지를 교환했고, 구현 후 독립 재검토도 요청했다.

## 검증 현황

- 관련 집중 테스트: 7개 파일, 36개 테스트 통과
- Claude-4 독립 재실행: 7개 파일, 72개 테스트 통과 및 기술 `APPROVE`
- 저장소 전체 테스트: 429/431 통과. 기존 날짜 고정 테스트 1건과 untracked fleet timer cleanup 테스트 1건은 단독 재현되는 범위 밖 실패
- TypeScript 전체 빌드: 통과
- JSON 및 diff whitespace 검사: 통과
- DB migration: 복제 DB와 live DB 모두 통과
- live 회사 확인: 1개 회사, 3개 팀, 6개 멤버, `is_always_on=0`
- PM2 재시작 후 queue log: Claude 1, Codex 2, AGY 1
- live `/api/triad/policy`, backend dry-run, UI experience plan: 통과
- live negative probe: UI proof 2종 누락 요청은 HTTP 400, 생성된 provider task 0건
- live KPI negative probe: 계산상 25×인 단일 표본도 `r<3` 때문에 `certified: false`
- 재시작 후 drain 해제 및 in-flight 0 확인
