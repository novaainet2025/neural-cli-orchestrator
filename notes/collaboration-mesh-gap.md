# Collaboration Mesh protocol gap

> Obsidian target: `03-RULES/collaboration-mesh-gap.md`
>
> This is a staging copy because the current workspace cannot write the vault
> original at `/Users/nova-ai/obsidian/mac-obsidian/03-RULES/`.

관찰 기준은 `db/nco.db`의 진단 task `task_2Wx61LMw8ayzLoIi` 생성 시각
`2026-07-27 06:37:25` 이전 최근 48시간 terminal 표본 5건이다. DB 시각은
저장값 그대로이며 시간대 변환을 가정하지 않는다.

## 관찰된 표본

| Task | Agent / 전달 | 상태 | 정확한 위반 또는 결과 |
|---|---|---|---|
| `task_e3jyQHHLBEqMBCCs` | `ollama` | `completed` | 도구 검증 없이 `항목별 100%/0% 정확성 검증`을 주장하고, prompt에 없는 `협업 규약 제1장 3.2항`을 출처 없이 인용했다. |
| `task_dzPRXYhaMk3AzhlQ` | `hermes` | `completed` | `도구/커맨드 사용 금지` prompt에서 주입 집계를 `[Evidence Tier 1]` 및 현재 API 상태처럼 취급하고 `done:`으로 응답했다. |
| `task_oa1quZNQZJqF1j3w` | `ollama` | `completed` | prompt가 주입 데이터만 사실로 쓰라고 했으나 prompt에 없는 `task_nYFMgk4lwKE6_Pr3`를 출처 없이 적용했다. ID 자체는 DB에 존재하므로 “가공 ID”로 분류하지 않는다. |
| `task_kJ9xKYxyAwN9unr1` | `claude-code` → `opencode` | `completed` | `claude-code` queue wait 1,800,000ms 후 재할당됐다. 최종 보고서의 44행 주장은 현재 파일과 일치해 거짓 보고 위반은 확인되지 않았다. |
| `task_vul5sMk4wNuu-aQB` | `claude-code` → `opencode` | `failed` | 같은 queue wait 후 응답은 공백 25자, 오류는 정확히 `silent-failure: empty output`이었다. |

표본은 완료 4건·실패 1건이므로 지시문에 주입된 `completion=80%`,
`sample=48h/5`와 일치한다. `score=75.7`의 과거 `maxN` 스냅샷은 task에
저장되지 않아 정확한 재계산은 미검증이다.

## 토론·합의·메시지 패턴

- 같은 cutoff 창의 `discussions` 54건 중 37건 완료, 9건 실패, 8건 active였다.
- 실패 9건은 모두 round 0에서 `discussion_no_valid_proposals`로 끝났다.
- `discussion_messages` 190건, `mesh_messages` 1,718건, `agent_messages` 0건이다.
- 현재 `mesh_messages`에는 delivery ack/read 필드가 없어 1,718건의 전달 성공이나
  실패를 메시지 행만으로 판정할 수 없다.
- `company-orchestrator`가 이전 단계 산출물의 첫 줄이 `done:` 또는 `status:`인
  프로토콜 응답 30건을 새 task prompt로 만들었다. 세부는 `done:` 11건,
  `status:` 19건이며 `spawned_by_cli`와 `qualityRetryOwner`가 모두
  `company-orchestrator`다.

## 루트코즈

정책 문구의 부재보다 상태·provenance 경계가 무너진 것이 직접 원인이다.

1. terminal `completed`가 응답의 증거 등급·출처 준수와 분리되어 있다.
2. `company-orchestrator`가 `done/status/error`를 stage 상태가 아닌 다음 task
   내용으로 소비한다.
3. failover가 장시간 queue wait 뒤 공백 응답까지 허용해 전달 실패를 만든다.
4. 메시지 레이어에 ack가 없어 전달 실패를 task 오류로만 관찰할 수 있다.

## 재발 방지 규칙

1. 이전 단계 첫 비어 있지 않은 줄이 `done:`, `status:`, `error:`이면 새 task로
   enqueue하지 않고 stage 상태로 소비한다.
2. no-tools prompt의 응답은 파일·DB·HTTP T1 검증을 주장할 수 없다.
3. 공백-only 출력은 즉시 명시적 전달 실패로 분류하고 provider/failover 원인을 보존한다.
4. 합의는 제안 1건 이상과 출처·책임자·결정시각이 없으면 승인하지 않는다.
5. 메시지 전달 완료 주장은 ack 또는 수신 본문이 있을 때만 허용한다.

## 적용 및 되돌리기

- Mem0 key/agent: `collaboration_protocol_violations`
- Memory ID: `mem0-1785136847254-bbktgs`
- BM25 재조회에서 같은 ID와 task-bound metadata를 확인했다.
- 되돌리기: 이 memory ID 한 건과 이 staging note만 제거한다. namespace 전체 clear 금지.
- 팀 lifecycle, 활성 상태, retirement 상태는 변경하지 않았다.

## 다음 개선팀 인계

`company-orchestrator` protocol-output guard, no-tools evidence gate,
whitespace-only output rejection, mesh delivery ack를 각각 독립 구현·테스트한다.
이번 cycle에서는 코드/스키마 수정 및 런타임 동작을 검증하지 않았다.
