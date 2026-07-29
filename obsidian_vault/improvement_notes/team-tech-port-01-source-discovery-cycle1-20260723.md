---
created_at: 2026-07-23T22:40:04+09:00
updated_at: 2026-07-23T22:43:15+09:00
verified_at: 2026-07-23
tags:
  - improvement-note
  - category/team-quality
  - team/tech-port-01-source-discovery
  - agent/retired-provider
  - agent/codex
  - agent/opencode
  - evidence/T1
  - cycle/1
---

# Improvement Note: tech-port-01 source discovery cycle 1

## Scope and safety

- 대상: `team_tech-port-01-source-discovery`
- 지시 기준선과 lifecycle row: score `79.2`, completion `80%`, sample `48h/10`,
  improvement cycle `1/3`
- 팀은 `is_active=1`, lifecycle status는 `improving`, 구성원은 `codex`,
  `retired-provider`, `opencode`다.
- `team_goals`에는 이 팀의 row가 0건이다. 따라서 별도 목표값·목표 기한·목표 방향은
  미확인이고, 이번 개선에서 만들거나 추정하지 않는다.
- 팀 삭제·비활성화·retirement·lifecycle·score·task status는 변경하지 않는다.

## Ground-truth evidence

관측 시각은 2026-07-23T22:40:04+09:00이며, 출처는 `db/nco.db`,
`src/core/team-scorer.ts`,
`data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md`다.

### Team-owned 48-hour sample

scorer가 terminal로 세는 `completed`, `failed`, `timed_out`, `lease_expired`는
10건이며 `completed=8`, `failed=2`라 completion `80%`다. 별도 `cancelled` 1건은
scorer 표본에서 제외된다.

| Pattern | Observed evidence |
|---|---|
| 품질 반려와 완료 상태 분리 | completed 8건 중 3건의 metadata가 `qualityRejected=true`, `qualityHeuristics=["FORMAT_MISMATCH"]`지만 task status는 `completed` |
| 프로토콜 형식 | completed 8건 중 정확한 `done:` 시작은 1건, `<thinking>` 시작은 1건, 나머지 6건은 다른 형식 |
| 검증 증거 필드 | terminal 10건 모두 `evidence_json` 없음 |
| 도구 서술 응답 | `task_NKawqqiFpXLljVLL`, `task_0234WuBNjiGFESV4`, `task_vy2Ny2KU2cYiX0_G`, `task_3Rv3e25qX07enR1f`는 source dossier 대신 파일 생성·검색 함수 설명을 반환 |
| 출처 조작 위험 | `task_Jq0FLMM0vk5GUwK2`는 실제 확인 없이 가공된 GitHub, LICENSE, arXiv, benchmark URL을 제시 |
| 과도한 완료 주장 | `task_9uDxncTJy9zqEXTw`는 migration·통합·테스트가 모두 수행됐다고 주장하지만 `evidence_json`은 없음 |
| 생각 태그 노출 | `task_Fb04BOuy_oyxT5i5`는 `<thinking>`으로 시작해 `FORMAT_MISMATCH` 반려 |
| API schema 실패 | `task_zrtJeLH7fGDdUfiP`는 필수 필드 `title`, `direction`, `targetValue`, `unit`, `reflection`, `improvement`를 알 수 없다고 반환하고 실패 |
| 런타임 실패 | `task_whudc2vYe2g_1YHf`는 서버 재시작 뒤 orphan requeue 2회 소진으로 실패 |

현재의 정정된 Stage 01 보고서는 위 가공 출처를 제거하고 실제 repo/file/lockfile,
commit SHA와 파일 SHA-256, 공식 원문, 성공·실패가 함께 있는 검증 영수증을 기록한다.
보고서 첫 줄은 `done:`이며 저장소의 실제 response-quality checker로 통과한 기록이 있다.
이 검증된 산출물과 이전 저품질 task 원문을 같은 학습 성공 사례로 취급하면 안 된다.

### Member-wide 48-hour pattern

아래는 target-team 소유 task만이 아니라 각 구성원의 전체 NCO task를 같은 관측 시각에
집계한 운영 패턴이다. 팀 score 산식과 섞지 않는다.

| Agent | Status counts | completed 중 qualityRejected | completed 중 `done:` | 보수적 도구서술 탐지 |
|---|---|---:|---:|---:|
| codex | completed 268, failed 35, queued 3 | 118 | 144 | 0 |
| retired-provider | completed 51, failed 4, lease_expired 1, cancelled 1, queued 7 | 34 | 0 | 28 |
| opencode | completed 62, failed 17, lease_expired 1, timed_out 5, cancelled 3, queued 2 | 45 | 9 | 0 |

도구서술은 `The ... function is used`, `The output of the ... function`,
`This function call` 선두 문구만 센 보수적 값이다. `qualityRejected`는 metadata의
관측값이며 독립 성공률이나 전체 의미 품질로 해석하지 않는다.

## Root cause

1. 점수 `79.2`의 직접 원인은 source 품질이 아니라 status 기반 completion `80%`와
   상대 volume의 조합이다. scorer는 `qualityRejected`, `evidence_json`, 출처 정확성을
   점수에 반영하지 않는다.
2. retired-provider의 tool-call 결과가 최종 source dossier로 합성되지 않고 함수 설명으로
   반환되는 패턴이 반복됐다. build verifier는 NCO `tsc`만 확인하므로 의미 불일치를
   차단하지 못했다.
3. source-discovery 완료 계약이 장기기억에 증류되지 않아, 가공 URL·광범위 완료 주장과
   검증된 보고서가 모두 `completed` 성공 사례로 재검색될 수 있었다.
4. 성과·목표 입력 task는 API 요청 schema를 먼저 조회하지 않았고, 후속 task는 서버
   재시작 뒤 복구되지 않아 실패 2건을 만들었다.
5. 같은 회사 목표의 자가학습 task `task_zhhAHiGTt_LuWKiA`도 검색 함수 설명만 반환해
   `FORMAT_MISMATCH`로 반려됐고, 현재 retry `task_KpTI02FaiVMc8__a`가 생성됐다.

## Bounded fix

다음 규칙을 target-team 구성원 3명의 Mem0와 NCO `knowledge_base`에 고정 ID로
추가한다.

> Source Discovery의 성공 사례는 task status만으로 선정하지 않는다. 응답은 정확한
> `done:`으로 시작하고 내부 thinking·도구 함수 설명을 제외한다. 실제 file/HTTP/DB
> 본문, repo/commit/version/URL, 관측 시각, 대안, 실패와 미확인을 함께 기록한다.
> `qualityRejected=true`, `evidence_json` 없음, 검증되지 않은 URL·수치·완료 주장은
> 재사용 가능한 성공 지식에서 제외한다. 성과·목표 API는 POST 전에 실제 schema와
> 응답 body를 확인한다.

고정 ID:

- improvement note:
  `team-tech-port-01-source-discovery-cycle1-20260723`
- knowledge base:
  `kb-team-tech-port-01-source-discovery-cycle1-20260723`
- Mem0:
  `mem0-team-tech-port-01-cycle1-20260723-retired-provider`
- Mem0:
  `mem0-team-tech-port-01-cycle1-20260723-codex`
- Mem0:
  `mem0-team-tech-port-01-cycle1-20260723-opencode`

## Safety and rollback

- 파일 rollback은 이 노트 한 개만 제거한다.
- DB rollback은 위 고정 ID 5개만 제거한다.
- 기존 task, report, team goal, member, lifecycle, 기존 memory/knowledge row는
  수정하거나 삭제하지 않는다.
- 새 독립 terminal 표본이 생기기 전에는 score 향상이나 promotion 근거 완성을
  주장하지 않는다.

## Verification receipt

- `[file]` 이 노트를 직접 재조회했고 scope, task ID, 고정 rollback ID를 확인했다.
- `[database rows]` `improvement_notes` 1건, `knowledge_base` 1건,
  `mem0_memories` 3건을 위 고정 ID로 직접 조회했다.
- `[memory]` `NCO_MEM0_NO_EMBED=1`에서 build 산출물의 public `mem0Search`를
  retired-provider, codex, opencode 각각 호출했다.
  - mode: 세 agent 모두 `bm25`
  - 각 결과에 해당 agent의
    `mem0-team-tech-port-01-cycle1-20260723-*` ID 포함
- `[knowledge]` build 산출물의 public `knowledgeBase.query`를 team ID와
  `FORMAT_MISMATCH`로 호출해
  `kb-team-tech-port-01-source-discovery-cycle1-20260723`을 회수했다.
- `[quality gate]` 정정된 Stage 01 보고서를 실제
  `checkResponseQuality(..., { requireProtocolPrefix: true })`로 검사해
  `pass=true`, `heuristics=[]`를 확인했다.
- `[score]` build 산출물의 `computeTeamScores` 재조회 결과는 score `79.2`,
  grade `C`, completion `80`, `n=10`, sample `48h`다. 새 독립 task가 없으므로
  개선 전후 score가 그대로인 것이 정상이다.
- `[focused tests]`
  `npm run test:run -- src/core/team-scorer.test.ts tests/response-quality.test.ts
  src/agent/agent-manager.test.ts` → 3 files, 14 tests passed.
- `[build/typecheck]` `npm run build` → TypeScript `tsc`, exit 0.
- `[database integrity]` SQLite `quick_check` → `ok`;
  `foreign_key_check` → 위반 row 없음.
- `[lifecycle]` team `is_active=1`, lifecycle `status=improving`,
  `improvement_count=1`, `last_score=79.2`, `last_sample_size=10` 유지.
- 증거 등급: T1 (task/metadata/DB row, 파일 내용, public retrieval, 명령 출력 직접 확인).

## Remaining gaps

- 실제 새 source-discovery task가 위 기억을 검색해 증거 완결 산출물을 만드는지는
  다음 독립 표본 전까지 미검증이다.
- `team_goals` row가 없어 목표 대비 개선률은 미확인이다.
- 외부 Obsidian 원본 vault 동기화는 workspace 범위 밖이라 미확인이다.
- semantic embedding 가용성은 미확인이다. 이번 연동은 로컬 BM25/lexical 검색을
  검증 대상으로 한다.
