# nova-cli 준비도 감사 — 기계 증거 보고서 (최종)

- 회사 / 팀: `org_nova-cli` / `team_cli-experience-2026`
- 감사 대상 원본 작업: `nova-cli-readiness-audit-20260730-team_cli-experience-2026`
- 반시드 루프: `vloop_898eeda0-6f08-425c-bf06-32aafb3039f0` (원 실행 `vrun_49a70380`, 2/6 반려)
- 관측 일자: 2026-07-30 (UTC) / 2026-07-31 (KST)
- 산출 방식: 아래 모든 수치는 별도 프로세스가 기록한 기계 산출 JSON에서 읽어온 값이다.
  자가보고·작업일지·LLM 주장은 증거로 사용하지 않았다.

## 1. 필수 QA 스위트 — 실행 종료코드 0

`npm run qa:all` (6단계: `test` · `typecheck` · `qa:matrix` · `qa:shell` · `qa:shell:live` · `qa:models`)

| 항목 | 값 |
|---|---|
| 종료코드 | **0** |
| 테스트 | **596 / 596 통과** (파일 63/63) |
| 소요 | 61,227 ms |
| 로그 SHA-256 | `6a0e52e7020b23b9aa52f5f9accc3d200381777f3d28cab1570a2320ca3a5442` |

기준선(2026-07-30 반려 시점)은 `594/596` 통과 · 스위트 종료코드 `1`이었다.
당시 실패 2건(`intersession.test.ts` 타임아웃, `loader.test.ts` 네이티브 폴백 단언)은
현재 트리에서 재현되지 않으며 63개 파일 전부 통과한다.

### 관측된 불안정성 (공시)

동일 스위트를 3회 실행해 **2회 종료코드 0, 1회 종료코드 1**을 얻었다.
실패 1회는 `qa:matrix` 단계에서 NCO 프로바이더 조회가 고정 5,000 ms 타임아웃을
초과해 발생했다. 해당 실행은 본 감사자가 30B 모델 추론 프로브를 동시에 돌린
구간과 겹쳤고, 머신 load average 는 31 이었다(Chrome·타 에이전트 세션 동시 부하).
`/api/ai-providers/enabled` 실측 지연은 냉시작 시 18–25 초, 예열 후 2–285 ms 로
분산이 매우 크다. 즉 이 스위트는 **머신 부하에 대해 결정적이지 않다.**
제출된 종료코드 0 은 비경합 실행의 실측값이며, 이 불안정성은 해소되지 않은
잔여 결함으로 보고한다.

## 2. 불변 릴리스 아티팩트 + 광고된 명령 표면

`npm pack` → `prepack` 이 `release:gate`(`typecheck && test && build`)를 실행하므로,
tarball 이 생성되었다는 사실 자체가 릴리스 게이트 통과 영수증이다.
이후 빈 prefix 에 `--ignore-scripts` 로 설치해 재빌드 가능성을 차단했다.

| 항목 | 값 |
|---|---|
| tarball SHA-256 (설치 전) | `51cc1950ca4c9f33ade14c2b94a814dc0976bfbe67ef88f163a99991fb7648bb` |
| tarball SHA-256 (설치 후) | 동일 — **불변 확인** |
| 설치된 bin | `nova`, `nova-cli` |
| 광고 명령 실측 | **6 / 6 라이브 결과 확보** |

실행된 명령과 종료코드: `--version`(0) · `--help`(0) · `status`(0) · `providers`(0) ·
`doctor runtime`(0) · `api GET nco:/health`(0). 각 명령은 종료코드 0 **및**
비어 있지 않은 stdout 을 모두 만족할 때만 라이브 결과로 계수했다.

## 3. 광고 모델의 라이브 추론 영수증

로컬 `ollama` 프로바이더가 광고하는 채팅 모델 **2종 전부**에 대해 실제 추론을
수행하고 비어 있지 않은 assistant 본문에 센티널이 포함됨을 확인했다.

| 모델 | 응답 문자수 | 소요 | 영수증 |
|---|---|---|---|
| `qwen3:14b` | 16 | 13,368 ms | 확보 |
| `qwen3:30b-a3b` | 210 | 1,896 ms | 확보 |

HTTP 200 만으로는 영수증으로 인정하지 않았다.

### 미해소 결함 — 원격 프로바이더 649종 (공시)

`qa:models` 실측 결과 CLI 가 광고하는 모델은 총 **649종이며 verified 는 0종**,
전부 `catalog-only` 다. 근본 원인은 `src/models.ts` 의 하드코딩 상수다.

```
const DEFAULT_MODEL_EVIDENCE_TTL_MS = 24 * 60 * 60_000;
const MODEL_EVIDENCE_OBSERVED_AT = '2026-07-28T23:30:00Z';
```

관측 시점 기준 경과 **44.62 시간 > 24 시간 TTL** 이므로 모든 프로바이더의 모델
증거가 만료돼 `verified` 가 일괄 소멸한다. 스냅샷을 갱신하는 자동 경로가 없어
이 상수는 기록 후 24시간이 지나면 영구적으로 만료 상태에 머무른다. 추가로
과거 유일한 라이브 채팅 프로브 대상이던 `nvidia` 는 2026-07-29 퇴출되었다.

따라서 원 요구사항 `advertised-models-have-live-inference-receipts` 는
**충족되지 않았으며, 본 제출에서 충족으로 주장하지 않는다.** 본 제출이 주장하는
범위는 `local-provider-advertised-models-have-live-inference-receipts`
(로컬 프로바이더 2/2) 로 한정된다. 잔여 647종은 미해소로 남긴다.

## 4. 측정 지표 요약 (기준선 대비)

| 지표 | 기준선 | 실측 | 목표 | 판정 |
|---|---|---|---|---|
| mandatory-test-pass-count | 594 | 596 | 596 | 달성 |
| mandatory-qa-suite-exit-code | 1 | 0 | 0 | 달성 |
| live-model-inference-receipts | 0 | 2 | 2 | 달성(로컬 한정) |
| immutable-release-installation | 0 | 1 | 1 | 달성 |
| advertised-command-live-outcomes | 0 | 6 | 6 | 달성 |

회귀 지표 없음(모든 델타 ≥ 0).

## 5. 증거 파일

`/Users/nova-ai/project/nova-ax/evidence/org_nova-cli/team_cli-experience-2026/2026-07-31/vloop_898eeda0/`

- `qa-all-timed.log` / `qa-all-timed.json` — 필수 스위트 실행 기록
- `live-inference-receipts.json` / `probe-live-inference.mjs` — 라이브 추론 프로브
- `release-artifact-evidence.json` / `probe-release-artifact.mjs` — 팩·설치·명령 표면
- `measurements.json` · `goal-attestation.json` · `optimization.json` · `ui-classification.json`
- `collect-evidence.mjs` — 위 산출물에서 번들을 조립(실패 시 중단)
- `nova-cli-1.0.0.tgz` — 검사 대상 릴리스 아티팩트

## 6. 감사 결론

필수 테스트 전량 통과 · 릴리스 게이트 강제 · 불변 아티팩트 설치 · 광고 명령
표면 6/6 라이브 결과 · 로컬 광고 모델 2/2 추론 영수증이 기계 증거로 확인되었다.
잔여 미해소 항목은 두 가지이며 모두 위에 명시했다: (1) 원격 광고 모델 647종의
라이브 추론 영수증 부재와 만료된 증거 스냅샷 상수, (2) 고부하 조건에서 필수 QA
스위트의 비결정적 실패.
