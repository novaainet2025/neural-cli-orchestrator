---
created_at: 2026-07-23T22:32:10+09:00
updated_at: 2026-07-23T22:35:28+09:00
verified_at: 2026-07-23
tags:
  - improvement-note
  - category/team-quality
  - team/web-scrape-02-source-discovery
  - agent/nvidia
  - agent/opencode
  - evidence/T1
  - cycle/1
---

# Improvement Note: web-scrape-02 source discovery cycle 1

## Problem

`team_web-scrape-02-source-discovery`의 팀 점수 표본은 전체 기간 terminal task
1건뿐이다. 이 task는 `completed`지만 실제 source URL, API 응답, sitemap 또는 HTML
표본이 주입되지 않아 페이지 유형, 필드 스키마, selector, pagination 및 변경 위험을
매핑하지 못했다. 따라서 현재 90점은 검증된 source-discovery 품질 저하의 증거가
아니라 `all/1` 저표본 상태다.

동일 개선 run의 self-learning task 2건은 `nvidia`가 CSS 파일 검색 함수 설명 한 줄을
반환한 뒤 `completed`로 저장됐다. 두 task 모두 품질 메타데이터에서
`FORMAT_MISMATCH`로 반려됐고 후속 retry가 생성됐다.

## Ground-truth evidence

- lifecycle profile:
  - team: `team_web-scrape-02-source-discovery`
  - status: `improving` (본 작업에서 변경하지 않음)
  - last score: `90`
  - sample size: `1`
  - improvement cycle: `1`
- target task: `task_H5o1otzVnelFTeJS`
  - 최초 `nvidia` 실행: `empty completion from provider 'nvidia' after 1 iteration(s)`
  - failover `ollama` 실행: DB status `completed`, 약 47초
  - `evidence_json`: 없음
  - 응답은 실제 source 데이터가 없음을 주로 보고했지만, 실재 여부를 확인하지 않은
    `https://api.nco.com/api/agents` 예시를 다음 action으로 제시했다.
- self-learning tasks:
  - `task_mBGEv_-IUC7CAdU0`
  - `task_4UDyB-vvGsC4F4KV`
  - 두 응답 모두
    `This function call will search for all CSS files in the current directory and its subdirectories.`
  - 두 row 모두 `qualityRejected=true`,
    `qualityHeuristics=["FORMAT_MISMATCH"]`
  - 두 build verifier는 `npm run build` exit 0이지만, 이는 응답 의미 품질의 증거가 아니다.
- 최근 48시간 `tasks` 집계:

| Agent | 전체 | completed | unsuccessful | queued | qualityRejected | 도구서술 completed |
|---|---:|---:|---:|---:|---:|---:|
| nvidia | 64 | 51 | 6 | 7 | 34 | 3 |
| opencode | 90 | 62 | 26 | 2 | 45 | 0 |
| ollama | 117 | 94 | 22 | 1 | 53 | 0 |

`unsuccessful`은 `failed`, `timed_out`, `lease_expired`, `cancelled`의 합이다.
도구서술 수는 정해진 영문 선두 문구만 센 보수적 탐지값이며 전체 저품질 응답 수로
해석하지 않는다. `qualityRejected`는 task metadata의 관측값이고 독립 성공률이 아니다.

## Root cause

1. 점수 90의 직접 원인은 완료율 100%에 비해 terminal 표본이 1건뿐인 것이다.
   현재 scorer는 completion 90%, 상대 volume 10%를 사용하고 `n=1`의 volume 기여는
   0이므로 90점이 된다.
2. source-discovery charter를 수행할 source URL/응답/문서가 주입되지 않아 실제 mapping
   계약을 만들 수 없었다. 에이전트 성능 집계는 수집 대상의 source evidence가 아니다.
3. task status와 build verifier가 응답 의미 품질과 분리돼 있다. 품질 게이트는
   `FORMAT_MISMATCH`를 탐지했지만 원 task row는 `completed`로 남아 후속 학습 시
   성공 사례처럼 보일 수 있다.
4. 낮은 품질 원문은 Mem0에 자동 축적됐지만, 저표본 해석·source evidence 최소요건·
   반려 응답 배제 규칙이 target team 구성원 기억과 knowledge base에 증류되지 않았다.

## Fix action

- 다음 검증 규칙을 target team 구성원 `nvidia`, `opencode`의 Mem0와 NCO
  `knowledge_base`에 저장한다.
  - `all/1`, score 90은 품질 저하로 단정하지 않고 저표본으로 표시한다.
  - source mapping을 완료하려면 허용된 실제 URL 또는 API/피드/sitemap/HTML 응답
    표본과 관측 시각이 필요하다.
  - 결과에는 page type, static/dynamic 판단 근거, field schema, stable selector 또는
    official API field, pagination, change risk, 미확인 항목을 포함한다.
  - 실재를 검증하지 않은 도메인·endpoint·수치·테스트 결과를 예시로 만들지 않는다.
  - `qualityRejected=true`, `FORMAT_MISMATCH`, 도구 함수 설명, `evidence_json` 부재는
    검증된 성공 사례로 승격하지 않는다.
- 팀 lifecycle 상태, score, active flag, lead/member 구성은 변경하지 않는다.
- 새 독립 terminal 표본 전에는 score 향상을 주장하지 않는다.

## Safety and rollback

- 팀 삭제·비활성화·retirement·lifecycle 변경 없음.
- 파일 rollback은 이 노트만 제거한다.
- DB rollback은 다음 정확한 ID만 제거한다.
  - improvement note:
    `team-web-scrape-02-source-discovery-cycle1-20260723`
  - knowledge base:
    `kb-team-web-scrape-02-source-discovery-cycle1-20260723`
  - Mem0:
    `mem0-team-web-scrape-02-cycle1-20260723-nvidia`
  - Mem0:
    `mem0-team-web-scrape-02-cycle1-20260723-opencode`

## Verification receipt

- 변경 파일을 직접 재조회했고 개선노트 DB row의 category, 원인, fix, agent, tag를
  고정 ID로 확인했다.
- `NCO_MEM0_NO_EMBED=1`에서 build 산출물의 public `mem0Search`를 호출했다.
  - mode: `bm25`
  - nvidia result:
    `mem0-team-web-scrape-02-cycle1-20260723-nvidia`
  - opencode result:
    `mem0-team-web-scrape-02-cycle1-20260723-opencode`
- build 산출물의 public `knowledgeBase.query`를 team ID와 `FORMAT_MISMATCH`로
  호출해 `kb-team-web-scrape-02-source-discovery-cycle1-20260723`을 확인했다.
- SQLite `quick_check`: `ok`
- SQLite `foreign_key_check`: 위반 row 없음
- `npm run test:run -- src/core/team-scorer.test.ts src/agent/agent-manager.test.ts`:
  2 files, 4 tests passed
- `npm run build`: `tsc`, exit 0
- 재조회 시 team은 `is_active=1`, lifecycle `status=improving`,
  `improvement_count=1`, `last_score=90`, `last_sample_size=1`로 유지됐다.
- 증거 등급: T1 (task/metadata/DB row, 파일 내용, 명령 출력 직접 확인)

## Remaining gaps

- 외부 Obsidian 원본 vault 동기화는 이 workspace 변경 범위 밖이라 미확인이다.
- 실제 source가 제공되지 않아 source contract E2E는 미검증이다.
- 새 terminal 표본이 없으므로 score 변화는 미확인이다.
- embedding 서비스 가용성은 미확인이다. 이번 기억 연결은 로컬 FTS/lexical 조회를
  검증 대상으로 삼는다.
- source TypeScript를 직접 실행하는 `tsx -e`는 sandbox IPC pipe 생성이 `EPERM`으로
  차단됐다. 동일 public API를 방금 생성된 `dist`에서 Node로 호출한 검증은 통과했다.
