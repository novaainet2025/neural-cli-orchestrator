# 회사(organization) 단위 오케스트레이션

> 2026-07-22 추가 (claude-3). 회사 목표 1개를 소속 팀들의 역할에 맞게 분배하고
> 순차/병렬로 실행하는 기능. 코드: `src/core/company-orchestrator.ts` +
> `src/server/routes/teams.ts`(라우트) + `~/.claude/commands/nco-company.md`(CLI).

## 개념

- **회사 = organization** 엔티티(`organizations` 테이블). 팀은 `organization_id`로 소속.
- **팀 = 역할**: `lead`(실행 프로바이더)·`charter`(역할 헌장)·`members` 보유.
- 기존 `/api/companies`는 미구현 스텁이었음 — 이 기능이 실질적 "회사 명령"을 제공.

## 동작

1. **분배(LLM 매니저 분해)** — 회사의 manager LLM(후보 체인: manager→opencode→
   claude-code→nvidia→codex→ollama, 후보당 120s 상한)이 목표를 읽고 각 팀 charter에
   맞는 하위작업을 JSON(`{slug: 하위작업}`)으로 생성. 실패 시 결정론적 템플릿으로 폴백.
2. **실행 순서** — 팀을 역할 단계로 랭크(설계1→탐색·수집2→구현3→분석4→검증5→집필6→시각화7,
   slug+name 기준. charter는 타 단계 어휘 오염 때문에 랭킹에서 제외).
3. **모드**
   - `pipeline`(기본): 단계 순차 실행 + 이전 단계 `response`(산출물)를 다음 단계 프롬프트에 주입.
   - `parallel`: 전 팀 동시 dispatch(스태거 400ms).
4. 각 팀 태스크는 `app.inject POST /api/task`(실행자=lead|member|ollama 폴백)로 생성 후
   `tasks.team_id`를 명시 태그. 실행 상태는 인메모리 run 레지스트리(LRU 200)로 추적.

## API

```
POST /api/organizations/:id/orchestrate   # :id = org id 또는 slug
  body: { goal, mode?: 'pipeline'|'parallel', dryRun?, projectDir? }
  → 202 { run }   (비동기 시작, 즉시 반환)
GET  /api/organizations/:id/orchestrate/:runId   → { run }
GET  /api/orchestrate/:runId                     → { run }   (org 무관)
GET  /api/orchestrate?limit=N                     → { runs }
```

## CLI

```
/nco-company orgs                                          # 회사 목록
/nco-company run <회사slug> <목표> [--parallel|--pipeline] [--dry-run]
/nco-company status <runId>
```

`--dry-run`은 분배안(팀별 하위작업)만 생성하고 실제 태스크는 spawn하지 않음(미리보기).

## 검증(T1, 2026-07-22)

- 유닛테스트 `company-orchestrator.test.ts` 23/23 통과(랭킹·정렬·실행자/분해자 해석·JSON 파싱).
- 라이브 dry-run: org resolution(slug), 404/400 처리, 파이프라인 순서 교정(전략→탐색→분석→
  검증→집필→시각화), 실행자 폴백, status/list GET 전부 확인.
- tsc 0 에러, `nco-backend` 재시작 후 health OK.
- 분해 LLM 경로 실행 확인(opencode 실추론 80s+ 관측). 단, 느린/불안정 로컬 프로바이더
  환경에선 템플릿 폴백이 정상 동작으로 작동(설계된 graceful degradation).

## 알려진 한계

- 분해가 느린 프로바이더에선 후보당 최대 120s×후보수까지 걸릴 수 있음(타임아웃으로 상한).
- run 레지스트리는 인메모리 — 서버 재시작 시 진행 중 run 상태 소실(태스크 자체는 DB 유지).
- 조직 계층(parent org) 재귀 분배는 미지원 — 직속 팀만 대상.
