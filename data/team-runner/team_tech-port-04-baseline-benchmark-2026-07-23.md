done: [Evidence Tier 1] 48시간 task 행, 검증 게이트 행, Scrapling 기준선 원시 파일과 공식 출처를 대조해 저품질 대표 산출물을 교정했다.

# 04 Baseline Benchmark — 개선 사이클 1 검증 산출물

검증일: 2026-07-23
대상 팀: `team_tech-port-04-baseline-benchmark`
회사 대상: `D4Vinci/Scrapling` 0.4.11 NCO 이식
판정: `BASELINE_VERIFIED_WITH_GAPS`

## 실제 task 패턴

HR 지시의 score 77.1은 이번 작업에서 재계산하지 않았다. 지시의 `completion=80%`,
`sample=48h/5`는 `db/nco.db`에서 해당 팀의 48시간 task가 완료 4건, 실패 1건인
것으로 직접 재확인했다.

| task | DB 상태 | 직접 확인한 패턴 |
|---|---|---|
| `task_Hg8EAhPiofUYUoMn` | completed | 측정 없이 팀/에이전트 수치와 같은 제안을 반복 |
| `task_hdBl_7u7ln4fzhn0` | completed | 실제 결과 대신 `searchFiles` 함수 설명만 반환 |
| `task_e-_rSc9NAVSHcEc9` | completed | benchmark를 실행 중이라고만 하고 최종 결과를 남기지 않음 |
| `task_GgQ8CwfGz1FFiE3i` | failed | `orphaned: server restart (poison — requeued 2x)` |
| `task_Gsr7Rm5UgWq47f4u` | completed | `[thinking]`으로 시작하고 이전 단계 문구를 반복; 기준선 수치 없음 |

따라서 DB 완료율 80%는 사실이지만, 완료가 곧 사용 가능한 benchmark 산출물을
뜻하지는 않는다. 실패 task에는 L1 typecheck와 L3 change-ratio 통과 행도 있어,
저장소 검증 게이트 통과와 task 응답의 의미적 완결성도 분리해야 한다.

## 승격한 기준선 원시 증거

대표 산출물보다 나중에 생성된
`docs/technology-transfer/scrapling-baseline-2026-07-23/evidence-final/`을
권위 있는 기준선으로 승격한다.

| 항목 | 직접 확인 결과 |
|---|---:|
| 환경 | arm64, macOS 26.5.2, Node v25.9.0, TypeScript 6.0.2, Python 3.13.13 |
| 반복 조건 | 5회; 첫 실행 cold, 나머지 4회 warm |
| 명령 행 | 16개, 비정상 종료 0개 |
| Python 정책/추출 테스트 | 11/11 통과 |
| TypeScript 집중 테스트 | 48/48 통과 |
| TypeScript typecheck | 5/5 exit 0 |
| route contract | 총 5,000요청, unexpected 0, 성공률 100%, 오류율 0% |
| route cold | 147.281 ms, 6,789.742 req/s |
| route warm 중앙값 | wall 119.239229 ms, 8,650.3836595 req/s, mean 0.1177015 ms, p95 0.281771 ms |
| Node→Python capability | cold 406.263833 ms; warm 중앙값 387.4506245 ms |
| source drift | before/after SHA-256 snapshot 동일 |

중앙값은 warm 4개 값을 정렬한 뒤 가운데 두 값의 산술평균으로 계산했다. CPU와
RSS 원시는 scenario JSON에 있으나, command-level `max_rss_raw`는 `unknown`이므로
명령별 peak RSS를 완전 측정했다고 주장하지 않는다. 기존 기준선에는 배포 build
크기와 실제 외부 HTTP fetch가 없고, 격리된 Fastify injection/로컬 capability
경로만 측정했다.

## 기술 출처 교정

- 공식 `v0.4.11` 릴리스는 2026-07-12 공개됐고 릴리스 commit은
  `aba2b3a57f3009cb6607dba58bb51863ca48d00d`이다.
- 회사 프롬프트의 `07a548362ff904a2837f503ed9d9f6b9dcef0195`는 같은 버전
  메타데이터를 가진 별도 검토 commit이며, 공식 GitHub에서 sponsor 문서 변경
  commit으로 확인된다. 릴리스 provenance SHA와 같은 값으로 기록하지 않는다.
- 공식 Security 페이지에는 `SECURITY.md`와 공개 advisory가 없다. 이는 취약점이
  없다는 증거가 아니다.
- CAPTCHA, Cloudflare solving, 로그인·유료벽 우회는 측정·승인 범위에서 계속
  제외한다.

공식 출처:

- <https://github.com/D4Vinci/Scrapling/releases/tag/v0.4.11>
- <https://github.com/D4Vinci/Scrapling/commit/07a548362ff904a2837f503ed9d9f6b9dcef0195>
- <https://pypi.org/project/scrapling/0.4.11/>
- <https://github.com/D4Vinci/Scrapling/security>

## 근본 원인과 제한된 수정

근본 원인은 benchmark 실행 실패 하나가 아니라 다음 연결 단절이다.

1. 16:03 대표 산출물이 21:46에 생성된 최신 원시 증거로 갱신되지 않았다.
2. 도구 함수 설명, “실행 중” 서술, `[thinking]` 누출도 completed로 남아 완료율이
   산출물 품질을 과대 표시했다.
3. 기존 Mem0에는 실패·반려 원문이 다수 저장됐지만, 이 팀의 검증된 기준선 위치와
   승격 규칙은 증류돼 있지 않았다.
4. `knowledge_base`에도 이 팀을 재검색할 수 있는 검증 lesson이 없었다.

이번 사이클에서는 대표 산출물을 최신 원시 증거로 교체하고, 같은 내용을
`improvement_notes`, Mem0, `knowledge_base`에 중복 방지 식별자로 연결한다.
팀 삭제·비활성화·라이프사이클 상태 변경은 하지 않는다.

연결 영수증:

- improvement note: `team-tech-port-04-baseline-cycle1-20260723`
- Mem0: `mem0-1784812541836-kia31s` (`agent_id=nvidia`, BM25 조회 확인)
- knowledge base: `kb-team-tech-port-04-baseline-cycle1-20260723`
  (`category=bug_pattern`, lexical 조회 확인)

로컬 embedding 서비스가 응답하지 않아 두 기억의 embedding은 생성되지 않았다.
저장은 성공했고 Mem0 BM25와 knowledge-base lexical 조회는 각각 해당 단일 ID를
반환했다. 따라서 “semantic 최적화 완료”는 주장하지 않는다.

## 변경 파일 목록

- `data/team-runner/team_tech-port-04-baseline-benchmark-2026-07-23.md`
- `obsidian_vault/improvement_notes/team-tech-port-04-baseline-cycle1-20260723.md`

## 핵심 diff 요약

- 반복적인 일반론을 48시간 task 5건의 성공/실패 패턴과 실제 benchmark 수치로 교체.
- 최신 원시 evidence 경로, 통계 방식, 미측정 항목을 명시.
- 공식 릴리스 SHA와 별도 검토 SHA를 구분.
- 향후 검색용 improvement note/Mem0/knowledge-base 연결과 정확한 rollback 대상을 고정.

## 검증 영수증

- `npm run build` → `tsc`, exit 0.
- `npm run test:run -- src/core/company-orchestrator.test.ts
  src/services/webScrapingService.test.ts src/server/routes/web-scraping.test.ts
  tests/response-quality.test.ts` → 4 files, 58/58 tests 통과.
- Python adapter unit tests → 11/11 통과.
- baseline runner `bash -n`과 evidence before/after snapshot `cmp` → exit 0.
- `checkResponseQuality(..., { requireProtocolPrefix: true })` → 대표 산출물
  `pass=true`, heuristics 0.
- SQLite `quick_check` → `ok`; `foreign_key_check` → 위반 0건.
- Mem0 BM25와 knowledge-base lexical 조회 → 각각 위 연결 ID 반환.

## 미검증·잔여

- 외부 Obsidian 원본 vault로의 동기화는 이 workspace에서 확인하지 않았다.
- Mem0/knowledge-base semantic embedding은 미생성이고 BM25/lexical만 검증했다.
- command별 peak RSS, 배포 build 크기, 실제 허가 사이트 E2E는 미측정이다.
- HR score 77.1 자체의 산식은 이번 범위에서 재계산하지 않았다.
- 팀 성과 개선 여부는 다음 독립 표본에서 재측정해야 하며 이번 수정만으로 점수 상승을
  주장하지 않는다.
