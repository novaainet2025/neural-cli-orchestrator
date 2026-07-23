# Cognee 기술 이식 검증 보고서

검증일: 2026-07-23  
대상: Cognee `1.4.0`, commit `90b4acaac937dc1c0aeffaead8b707c896ebf3db`  
대상 시스템: nova-use, NCO, nova-ax, Obsidian vault

## 기술 요약

**현재 Cognee를 활성화하지 않는다.** 자동 shadow, production augment,
전면 migration을 모두 기각하고 격리 연구 산출물만 보존한다.

- 표준 Cognee 전체 파이프라인은 합성 12문서 준비가 `20분` 상한을
  넘겨 강제 중단됐다. 완료 산출물이 없고 DB에는
  `DATASET_PROCESSING_STARTED`와 stale migration lock이 남았다.
- LLM 그래프 추출을 뺀 청크 전용 부분 후보는 12문서를 `5.363초`에
  인덱싱했지만, 120개 라벨 질의 Recall@3가 `92.50%`로 기존 토큰
  검색 `96.67%`보다 `4.17%p` 낮았다. 요구한 개선은 `+10%p`다.
- 청크 전용 cache-miss p95는 `2,964.40ms`로 목표 `500ms`의
  `5.93배`였다. cache-hit p95 `0.73ms`, 240회 요청 오류 0건,
  캐시 결과 불일치 0건은 통과했지만 필수 품질·지연 게이트를
  상쇄하지 못한다.
- Cognee Recall@1은 `88.33%`로 기존 `76.67%`보다 높았지만,
  Recall@10도 `98.33%`로 기존 `100%`보다 낮았고 rollback 질의
  Recall@3는 `25%`에 그쳤다.
- 전체 vault는 ingest하지 않았다. 검증 중 18:00 정기 작업으로 보이는
  외부 쓰기가 vault와 원본 nova-use worktree에 동시에 발생해,
  변경 중인 원본에 자동 병합·인덱싱할 운영 조건도 충족하지 못했다.
- sidecar와 runtime lock은 작업 종료 시 회수됐으며 현재 포트와
  Cognee 제어 프로세스는 남아 있지 않다.

PORT_DECISION: DO_NOT_ACTIVATE

PORT_SCOPE: RETAIN_ISOLATED_RESEARCH_ONLY

SHADOW_READINESS: NOT_READY

AUGMENT_DECISION: NOT_APPROVED

FULL_MIGRATION_DECISION: REJECTED

## 120질의 활성화 게이트 결과

비교 모집단은 합성 12문서와 고유 라벨 질의 120개다. 질의는
dependency, identifier, metric, purpose, request-owner, rollback,
safeguard, scenario, semantic-owner, semantic-purpose의 10개 범주에
각 12개씩 균형 배치했다. 모든 기대 문서·질의 ID·질의 문자열·제어
코드가 중복되지 않는지 사전 검사했다.

| 지표 | 기존 토큰 검색 | Cognee 청크 후보 | 필수 기준 | 판정 |
|---|---:|---:|---:|---|
| Recall@1 | 76.67% | 88.33% | 참고 지표 | 개선 |
| Recall@3 | 96.67% | 92.50% | 기존 대비 +10%p | **실패 (-4.17%p)** |
| Recall@10 | 100.00% | 98.33% | 비열화 | **실패** |
| MRR | 0.8607 | 0.9119 | 참고 지표 | 개선 |
| cache-miss p50 | 로컬 함수 내 처리 | 2,914.47ms | — | 회귀 |
| cache-miss p95 | 로컬 함수 내 처리 | 2,964.40ms | ≤500ms | **실패** |
| cache-miss max | 로컬 함수 내 처리 | 3,917.94ms | — | 회귀 |
| cache-hit p95 | 해당 없음 | 0.73ms | ≤500ms | 통과 |
| 1차 요청 오류 | 해당 없음 | 0/120 | <1% | 통과 |
| 캐시 요청 오류/불일치 | 해당 없음 | 0/120 / 0/120 | 0 불일치 | 통과 |

정확도와 지연은 모두 같은 120개 질의의 1차 요청으로 계산했다. 2차
요청은 sidecar 프로세스 메모리 캐시만 검증하며 unseen-query 성능이나
일반 검색 품질 증거로 사용하지 않았다.

### 실행 모드별 결정

| 모드 | 결정 | 이유 |
|---|---|---|
| 격리 연구 코드 보존 | 유지 | 재현과 개선 실험에 필요하며 런타임 활성화가 아님 |
| 자동 shadow | 기각 | 전체 준비 timeout, Recall@3·miss p95 실패, 원본 동시 변경 |
| production augment | 기각 | 사용자 경로 품질·지연 필수 게이트 실패 |
| 기존 검색 전면 교체 | 기각 | 실제 vault·NCO·nova-ax 무손실 migration 증거 없음 |

## 자동 회사 실행 결과와 안전 게이트

실행 ID `corun_e7fVGLa0dE_tPuE3`는 pipeline 모드로 실행됐다.

| 단계 | 결과 | 독립 검증 |
|---|---:|---|
| 기술 탐색 | 완료 | 공식 GitHub 커밋과 로컬 checkout 대조 |
| 안전·라이선스 | 완료 | Apache-2.0 및 알려진 CVE 별도 대조 |
| 복구 지점 | 보정 후 완료 | NCO 백업 확인, 잘못된 nova-ax 0B 백업 발견 후 실제 47MB DB 온라인 백업 |
| 기준선·회귀·토론 | 완료 | 회사 텍스트는 저품질이어서 수치 재측정 |
| 가치판단 게이트 | 실패 | 5회 모두 정확한 단일 결정문 형식 미준수 |
| 이식·사후 릴리스 | 미실행 | 게이트가 구현을 차단함 |

자동 실행 최종 상태는 `partial`, 결정은 `undetermined`였다. 이는 실패한
가치판단을 근거로 구현을 강행하지 않는 안전 동작이다. 이후 이 보고서의
초기 독립 실측으로 격리된 `nova-use-cognee` worktree에 부분 이식을
구현했다. 이번 12문서·120질의 재검증에서 필수 게이트가 실패했으므로
최종 결정은 `DO_NOT_ACTIVATE`로 변경했다. 원본 dirty worktree에는
병합하지 않았다.

실행 중 발견해 NCO에 보정한 오케스트레이션 결함:

1. LLM 분해 결과가 회사 원래 목표를 누락할 수 있었다. 모든 하위작업
   앞에 원래 목표를 강제로 포함하도록 변경했다.
2. 지정 실행자 실패 시 기술 이식 팀 밖의 저신뢰 실행자로 재위임될 수
   있었다. 기술 이식 회사에서는 큐 내부 fallback을 끄고 팀 체인만
   사용하도록 변경했다.
3. 최초 오작동으로 생성된 `/Users/nova-ai/nova-cli/test.txt`는 삭제하지
   않고 `/tmp/nco-quarantine-20260723-065650/test.txt`로 격리했다.

## 무엇을 측정했는가

### 비교 기준

- 현재 nova-use: 실제 Obsidian vault를 읽는 기존 로컬 index/search.
- Cognee 파일럿: 격리된 `/tmp` 데이터 볼륨, SQLite + Kuzu + LanceDB,
  Ollama `qwen3:14b`, `nomic-embed-text`, 6개 합성 Markdown 문서.
- sidecar 종단 시험: 2개 합성 Markdown 문서를 읽기 전용 ingest한 뒤
  bearer 인증 loopback HTTP로 검색.

두 검색의 의미는 동일하지 않다. nova-use 기준선은 빠른 로컬 검색이고,
Cognee는 그래프·벡터 처리 경로다. 따라서 이 수치는 “정확도 우열”이
아니라 전면 교체 시 발생하는 지연·자원 위험을 판단하는 회귀 측정이다.

### 실측 결과

| 지표 | 현재 nova-use | Cognee 파일럿 | 판단 |
|---|---:|---:|---|
| 대상 문서 | 15,229 | 6 합성 문서 | 규모 직접 비교 불가 |
| 준비/그래프 | graph 약 1.17–1.23초 | cognify 364.14초 | 대화형 재구축 불가 |
| 검색 p50 | 약 24.85–25.02ms | 15,704.21ms | 약 628배 느림 |
| 검색 p95 | 약 62.93–82.06ms | 34,556.71ms | 약 421–549배 느림 |
| 회수 확인 | 기존 recall p50 28.35–28.71ms | 식별 토큰 6/6 | 작은 합성셋에서 기능 확인 |
| 프로세스 RSS | graph 후 약 288–290MiB | 최대 544.91MiB | 약 +88% |
| LLM 메모리 | 없음 | Ollama VRAM 약 14.84GB | 별도 대형 비용 |
| 설치 | 기존 Node 앱 | Python 의존성 129개 | 공급망·운영면 증가 |

추가 측정:

- Cognee import: `12.063초`
- `add`: `5.238초`
- `cognify`: `364.139초`
- 6회 검색: 최소 `10.17초`, p50 `15.70초`, p95/최대 `34.56초`
- sidecar 2문서 ingest + cognify: `86.01초`
- sidecar 검색: `10.759초`, `atlas.md`와 `beacon.md` 경로 반환
- shadow cache 측정: 첫 검색 `22.033초`, 재검색 `1.302ms`와
  `0.853ms`; 세 응답의 상대경로 결과 동일
- 무토큰 health: HTTP `401`
- 올바른 토큰 health: HTTP `200`, `query-only`

## Obsidian 연동 가능성

연동은 가능하며, 다음 경계가 필요하다.

1. `/Users/nova-ai/obsidian/mac-obsidian`은 읽기 전용 원본이다.
2. sidecar의 one-shot importer만 `.md`를 읽는다. `.obsidian`, `.git`,
   `.trash`, `node_modules`, 1MiB 초과 문서, 비 UTF-8 문서는 제외한다.
3. Cognee 데이터·시스템·캐시는 vault 밖 별도 볼륨에 저장한다.
4. 각 문서에 `NOVA_REL_ID:<vault-relative-path>` 마커를 넣어 검색
   결과를 기존 vault ID로 되돌린다.
5. HTTP에는 ingest 경로를 제공하지 않는다. 서비스는 검색만 허용한다.
6. nova-use가 원격 결과의 절대 경로를 신뢰하지 않고, 검증된 상대
   `.md` 경로를 vault root 아래에서 다시 계산한다.

전체 vault는 이전 스캔 16,273개, 이번 시험 직전 16,304개
Markdown/27,842,295바이트였지만 Cognee에 넣지 않았다. 검증 중 외부
정기 작업으로 보이는 18:00 쓰기 후에는 16,316개/27,871,438바이트가
됐다. 합성 benchmark와 sidecar는 `--ingest-vault` 없이 실행됐으며
vault 경로를 입력으로 받지 않았다. 6문서 처리시간을 단순 선형
외삽하는 것도 타당하지 않지만, 현재 성능과 동시 작성 환경으로 전체
vault를 즉시 cognify하는 것은 운영 안전 기준을 충족하지 못한다.

## 안전·라이선스·공급망

- 라이선스: Apache-2.0. 사용·수정·배포는 가능하나 저작권·NOTICE 등
  Apache 의무를 유지해야 한다.
- `CVE-2026-58473`: Cognee `<1.2.0`의 settings 접근제어 결함으로,
  비인증 사용자가 전역 LLM endpoint를 바꿔 데이터 유출을 유발할 수
  있다. 대상 `1.4.0`은 영향 버전 범위 밖이지만, 다중 사용자 설정 API를
  외부에 노출하지 않아야 한다.
- 회사 초안이 언급한 `CVE-2026-31231`은 Cognee와의 연관을 확인할 수
  없어 근거에서 제거했다.
- 감사 커밋은 Cognee MCP `0.5.5` 버전 상승이다. 커밋 설명상 PyPI
  배포가 수동이며 fix가 dev 브랜치에 역이식되지 않으면 다음 릴리스에서
  되돌아갈 수 있다. 따라서 `latest` 설치와 Cognee MCP의 전
  프로바이더 노출을 금지한다.
- 실제 설치는 `/tmp/cognee-pilot-venv-20260723`에만 수행했다. 129개
  Python 패키지가 설치돼 SBOM·lockfile·해시 고정이 필요하다.
- 초기 Cognee 프로세스 종료 시 미정리 `aiohttp ClientSession`
  경고가 반복됐다. sidecar가 Cognee telemetry를 import 전에 끄고
  graceful shutdown에서 비동기 HTTP client를 정리하도록 보정한 뒤,
  실제 검색 후 종료 시험에서 경고가 재현되지 않았다. 장기 메모리
  안정성은 별도 운영 표본이 필요하다.
- Cognee 1.4.0의 `CHUNKS` 검색은 문서상 순수 벡터 검색이지만 기본
  호출에서는 session-turn 전처리가 LLM을 호출했다. 격리 sidecar를
  `only_context=True`, `verbose=True`로 바꾸고 object payload parser
  계약 테스트 3개를 추가했다. 수정 후에도 cache-miss p95는
  2,964.40ms로 필수 기준을 실패했다.
- 전체 `cognify` 중단에는 신호가 두 번 필요했고, 격리 DB의 실행
  상태와 migration lock이 자동 정리되지 않았다. 불완전 데이터셋은
  검색 품질 증거에서 제외하고 격리 보존했다.

## 구현한 부분 이식

격리 위치: `/Users/nova-ai/project/nova-use-cognee`  
브랜치: `cognee-migration-20260723`

| 파일 | 역할 |
|---|---|
| `src/main/knowledge-broker.ts` | `off/shadow/augment`, loopback·token·timeout·경로 검증, 로컬 fallback, 비식별 shadow 관측 |
| `src/main/knowledge-broker-observability.ts` | 사용자 데이터 디렉터리의 0600 JSONL, 10MiB 회전 |
| `src/main/vault.ts` | 기존 vault search 뒤에 optional broker 연결 |
| `tests/knowledge-broker.spec.ts` | 외부 endpoint·무토큰·traversal·정보 노출 차단 및 live/fallback 검증 |
| `tools/cognee-sidecar/server.py` | query-only FastAPI, one-shot importer, bounded memory cache, graceful cleanup |
| `tools/cognee-sidecar/run-shadow-pilot.sh` | shadow 전용 local-provider 강제, 단일 runtime lock, 작업 종료 회수 |
| `tools/cognee-sidecar/evaluate_shadow.py` | JSONL에서 오류율·p50/p95·승격 게이트 계산 |
| `docs/cognee-partial-pilot.md` | 설정·운영·rollback 절차 |

안전 기본값:

- `NOVA_COGNEE_MODE=off`
- `shadow`는 sidecar 요청을 비동기로 보내고 사용자 검색 결과를 바꾸지 않음
- shadow 로그는 프로세스별 keyed hash와 건수·지연만 기록하고 원문
  query, note 이름, snippet, 절대경로, token, 오류 상세를 기록하지 않음
- `augment`도 오류·timeout·잘못된 payload 시 즉시 기존 로컬 결과 사용
- endpoint는 `http://127.0.0.1`, `localhost`, `[::1]`만 허용
- redirect, URL credential, 절대경로, `..`, 비 Markdown 결과 차단
- bearer token 필수
- Cognee telemetry, 외부 LLM/embedding endpoint, 온라인 tokenizer
  다운로드 차단
- runtime lock으로 Mac당 sidecar 1개만 허용하며 중복 실행은 status
  `75`로 거부·대기 보고 가능
- Cognee를 모든 MCP/프로바이더에 직접 노출하지 않음

NCO와 nova-ax에는 직접 Cognee 의존성을 추가하지 않았다. 다음 단계에서
필요할 경우 두 시스템은 같은 nova-use Knowledge Broker의 제한된
query API만 사용해야 한다.

## 검증 결과

### NCO 오케스트레이션

- `src/core/company-orchestrator.test.ts`: 38 tests passed
- `npm run build`: passed
- NCO health: healthy

### nova-use 격리 worktree

- `tests/knowledge-broker.spec.ts` + `tests/vault.spec.ts`:
  27 passed, 3 환경-gated live 테스트 skipped
- 실제 sidecar 연결 shadow smoke: 9 passed, 1 stopped-sidecar 테스트 skipped
- 실제 sidecar 중단 fallback smoke: 9 passed, 1 live-sidecar 테스트 skipped
- `npm run typecheck`: passed
- `npm run build`: passed
- Python sidecar `py_compile`: passed
- HTTP 인증: 401/200 기대값 일치
- 종단 ingest/search: 200, 두 상대경로 반환
- cache: 첫 검색 22.033초, 동일 검색 재실행 1.302ms/0.853ms,
  결과 동일
- sidecar 중단: 로컬 결과 100% 유지, 비식별 `error` 관측 생성
- 종료 정리: 실제 검색 후 graceful shutdown에서 미정리 session 경고 없음
- 중복 launcher: 두 번째 실행 status 75로 거부
- 최신 Python sidecar 계약: 3 passed
- 최신 12문서·120질의 benchmark: 1차 120/120, 캐시 120/120 응답;
  오류 0, 결과 불일치 0
- 최신 focused Knowledge Broker: 8 passed, 2 environment-gated skipped
- 최신 launcher 회수 재검증: 두 번째 status 75, 종료 후 lock 없음,
  포트 없음

빌드의 기존 Vite dynamic/static import 경고는 있었으나 실패는 없었다.
격리 worktree 자체 `node_modules`가 외부 작업 중 사라져 최초 재실행은
Vitest 모듈 해석 단계에서 실패했으나, 원본 저장소의 기존 Vitest를
격리 root에 지정한 재실행은 통과했다. 소스 테스트 실패로 계산하지
않되, 의존성 환경이 동시 변경된 사실은 활성화 차단 운영 위험으로 남긴다.

## 전면 이식을 기각한 이유

전면 이식은 다음을 동시에 교체한다: nova-use의 빠른 로컬 검색, NCO의
기존 지식·semantic memory, nova-ax의 mem0 경로. 현재 증거는 그래프
기반 회수 가능성만 보여주며 다음을 입증하지 못했다.

- 15,229개 실제 문서에서 현재보다 나은 정답률
- 기존 p95 검색 지연과 비슷한 사용자 체감
- 전체 vault 증분 갱신·삭제·rename 정합성
- 장기 sidecar 안정성과 세션 누수 없음
- NCO/nova-ax tenant·dataset 격리
- 현재 memory 데이터의 무손실 이전

반면 지연과 자원 회귀는 직접 관찰됐다. 그러므로 전면 교체의 기대효과보다
운영 위험이 크다.

## 개선 방향과 승격 게이트

1. 자동 shadow를 켜지 말고 합성/비식별 격리 실험에서만 개선한다.
2. 이번 120개 라벨셋에 실제 어려운 비식별 질의를 추가한다. wiki-link
   다중 hop, 동의어, 시간 관계, 프로젝트-사람-결정 연결을 포함한다.
3. full `cognify`의 bounded cancellation, 실행 상태 rollback, stale
   lock 회수를 먼저 구현하고 20분 준비 제한을 통과시킨다.
4. 비동기 증분 ingest와 precomputed graph를 적용해 **cache miss를
   포함한** sidecar p95를 `500ms` 이하로 낮춘다. 반복 cache hit만으로
   이 게이트를 통과시키지 않는다.
5. 어려운 질의 Recall@3가 기존 대비 최소 `+10%p` 개선되고 Recall@10이
   비열화되지 않아야
   한다.
6. sidecar 오류율 `<1%`, 기존 검색 fallback 성공률 `100%`, vault
   write `0건`, 외부 네트워크 전송 `0건`을 확인한다.
7. 위 오프라인 게이트 통과 후에만 명시적 승인으로 제한 shadow를
   7–14일 실행하고 장기 메모리 증가를
   측정한다.
8. 정확한 버전·lockfile·SBOM·취약점 스캔을 릴리스마다 고정한다.

위 게이트를 모두 통과해도 권장 범위는 “검색 보강”이다. 기존 저장소를
제거하거나 NCO/nova-ax 메모리를 일괄 이전하는 전면 이식은 별도 승인과
실데이터 migration rehearsal이 필요하다.

## 롤백

즉시 롤백:

1. `NOVA_COGNEE_MODE=off`
2. nova-use 재시작
3. sidecar 중지
4. Cognee 전용 데이터 볼륨만 보관 또는 제거

코드는 원본과 분리된 worktree에 있어, 채택하지 않으면 해당 worktree와
브랜치를 제거하면 된다. Obsidian 원본과 기존 NCO/nova-ax DB는 수정하지
않는다.

회사 실행 전 복구 자산:

- NCO DB: `/Users/nova-ai/project/nco/db/nco.db.cognee-bak`
- nova-ax 실제 DB의 보정 백업:
  `/Users/nova-ai/project/nova-ax/db/nova-ax.db.cognee-bak-20260723T1803+0900`
  (`47,423,488`바이트, 60 tables, `quick_check=ok`, mode `0600`)
- 기존 `/Users/nova-ai/project/nova-ax/nova-ax.db.cognee-bak`는
  0바이트 최상위 DB를 복사한 잘못된 복구 지점이므로 사용하지 않는다.
- 세 저장소의 `checkpoints/git_status.txt`
- 세 저장소의 `checkpoints/uncommitted_changes.patch`

## 한계와 추가 질문

- 최종 활성화 표본은 합성 12문서·120질의로 확대했지만 실제 vault
  검색 품질로 일반화할 수 없다.
- 초기 자원 비교는 6문서·6질의, sidecar 종단 표본은 2문서·1질의다.
- 최종 cache 지연은 120개 고유 질의의 최초 실행과 같은 120개 질의의
  재실행을 분리해 계산했다. cache hit는 캐시 기능 증거일 뿐 신규 질의
  성능이나 품질 개선 증거가 아니다.
- 실제 Obsidian 전체 cognify는 개인정보·시간·자원 위험 때문에 하지 않았다.
- 회사의 4–6단계 텍스트 산출물은 도구 설명 수준이라 의사결정 근거에서
  제외했다.
- 기존 검색과 Cognee 검색은 기능 범위가 달라 단순 latency 비교만으로
  품질 우열을 말할 수 없다.

다음 결정 질문은 “Cognee가 빠른 검색을 대체하는가?”가 아니라,
“기존 검색이 놓치는 다중-hop 질의에서 비동기 비용을 감수할 만큼
정확도를 개선하는가?”다.

현재 단계 판정은 `자동 shadow 미승인`, `augment 미승인`, `전면 이식
기각`이다. 원본 `nova-use` HEAD는 유지됐지만 검증 종료 시 working-tree
항목이 207개로 외부 변경 중이어서 구현을 병합·활성화하지 않았다. 전체
vault ingest도 수행하지 않았고 sidecar는 종료했다.

## 출처

- Cognee 저장소: https://github.com/topoteretes/cognee
- 감사 커밋: https://github.com/topoteretes/cognee/commit/90b4acaac937dc1c0aeffaead8b707c896ebf3db
- 한국어 README: https://github.com/topoteretes/cognee/blob/90b4acaac937dc1c0aeffaead8b707c896ebf3db/README_ko.md
- Apache-2.0 라이선스: https://github.com/topoteretes/cognee/blob/90b4acaac937dc1c0aeffaead8b707c896ebf3db/LICENSE
- CVE-2026-58473: https://nvd.nist.gov/vuln/detail/CVE-2026-58473
