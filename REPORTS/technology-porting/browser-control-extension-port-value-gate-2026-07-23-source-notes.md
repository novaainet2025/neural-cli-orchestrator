# Browser-control port value gate — source notes

Generated: 2026-07-23T19:11:55+09:00

## Reporting job

- Question: Should the `cli-extensions` P1–P4 browser-control capabilities advance into the `nova-use` migration/implementation stage now?
- Audience: product stakeholders responsible for product, security, release, and architecture approval.
- Scope: behavior-level adaptation from Chrome MV3 concepts to the existing Electron `WebContents` control plane; `nova-use`, `nco`, and `nova-ax` suitability; current evidence through Stage 06.
- Comparison basis: current dirty working-tree snapshots and the 2026-07-23 benchmark baseline, not a clean release commit.
- Decision rule: the Stage 07 pipeline token is binary. `APPROVE` would allow Stage 08 implementation to run automatically; `REJECT` prevents that promotion. The report therefore uses `PORT_DECISION: REJECT` while separately recommending a future isolated prototype after prerequisites are met.
- Success criteria: all seven requested value dimensions are supported by retrievable evidence; unmeasured effects remain unknown; the report distinguishes prototype, merge, release, and P4 activation decisions.

## Evidence inventory

| Evidence | SHA-256 | Use |
|---|---|---|
| `/Users/nova-ai/project/nova-use/docs/plans/browser-control-extension-port.md` | `3043947fa564d0424d45428858af0dc4ffeb5ee0a74baee439d0c287d7545593` | Required P1–P4 scope and T1 contract |
| `/Users/nova-ai/project/nova-use/docs/plans/benchmark-baseline.md` | `d4f97f4a6af45ad39d1591d682cf3680e8c8fd2ff60e0d5f66f947177668ef68` | Prior workspace-size, test, build, and typecheck snapshot |
| `data/team-runner/team_tech-port-01-source-discovery-2026-07-23.md` | `efa24ec818e6d61cbccd2d7562bc99ca4b70dd1968f61e7cd4e91a8f17fa53b3` | Architecture ownership, source discovery, related-test baseline |
| `data/team-runner/team_tech-port-02-safety-license-2026-07-23.md` | `7ef8a3b32fae483fb24cf2a9aafe0d262c5bb97dd5b635fdb223f72b35e5acd6` | Safety, dependency, SBOM, license, and release blockers |
| `data/team-runner/team_tech-port-03-recovery-checkpoint-2026-07-23.md` | `92aa2cc58d1247b18bb16dcb4f87245832217124c0f1928c129b10b9798fba5c` | Dirty-state inventory, partial backup, rollback readiness |
| `data/team-runner/team_tech-port-05-upgrade-regression-2026-07-23.md` | `ed07e05d0e49ae6ebb9915276bda858cf1024effb494be786c49fe27e803b0b0` | Confirmation that no candidate A/B measurements exist |
| `data/team-runner/team_tech-port-06-improvement-debate-2026-07-23.md` | `306a2ac5928482c36af5a1b3b9b5725fde759669f09a72cad33062a4ce18fc55` | Option taxonomy; its unrelated agent metrics were not used |
| `nova-use/src/shared/ipc.ts` | `5d5d526b1b220bcd8f28137fb2f9db0901836ddb43cc944c38b0e987c66f51fd` | Current shallow page-digest contract |
| `nova-use/src/main/agent-browser-adapter.ts` | `b5f7fe0871a213196ba96cf16ab8dd06299b2c7bf5b6fb039d151048fb706779` | Existing ref/action adapter and shared-home page-context persistence |
| `nova-use/src/main/browser-consent.ts` | `dafe32b70b5dac42f6ff2ead2c964f9457131967b5e0458a7c339dcac0aeb4eb` | Current generic auto/remembered consent behavior |
| `nova-use/src/main/browser.ts` | `dffe65023fab56908e11ed11b6fea677997705f0821ee1876ac3221582c83f92` | Existing Policy/CDP/WebContents boundary and missing permission handler |
| `nco/src/core/company-orchestrator.ts` | `c7d714122cd64cd01f46399d57ea16d60c90c5e766f51f6ac891c27d04549fad` | Stage ordering and binary Stage 07 decision behavior |
| `nova-ax/src/core/state-sync.ts` | `b7752761c91690e4a68f51285c2fab96d01862555d67e0cc11f8e01db2499f4e` | NCO event/status observation boundary |

Current repository snapshots at evidence collection:

- `nova-use`: HEAD `408718d1739bcea747c3c863f75da5ac5a600446`, 224 changed/untracked entries.
- `nco`: HEAD `4adf31725bad1f44220d04952151c8197469f6e1`, 530 changed/untracked entries.
- `nova-ax`: HEAD `7644131db39062ffad62f0a1a61cf55c32bc9ab1`, 7 changed/untracked entries.
- `cli-extensions`: HEAD `cff682d60e1e0579d0bc0bb32088ed2cef313b00`, 61 changed/untracked entries.

These counts are volatile and are not a substitute for the fresh stopped-state checkpoint required by Stage 03.

## Data-quality decisions

- The baseline document labels `du -sh .` as “Build Size.” The report relabels it as workspace footprint because it includes source, dependencies, caches, and unrelated artifacts.
- The baseline captured no candidate prototype, browser-task success rate, action latency, throughput, CPU, memory, or browser-control error rate. Performance uplift is therefore unknown.
- Stage 05 explicitly states that it did not run the requested isolated prototype/A/B experiment. Its agent success-rate table has no causal or metric relationship to this port and was excluded.
- Stage 06 also relied on unrelated agent-status data. Only its generic option taxonomy was retained; project-specific conclusions were rebuilt from source.
- The required spec’s embedded Stage 07 table says performance will improve and licenses are suitable, but it supplies no A/B data or first-party license proof. Those statements were treated as hypotheses and superseded by verified evidence.
- Existing source confirms the gap remains: `BrowserAgentPageDigest` has no `comprehension`, `affordances`, `playbook`, `autoMission`, or `safeToAutostart`; there is no `browser-learning.ts`; no P3 target-effect `MutationObserver` was found.
- Legal conclusions are deliberately limited to release-evidence readiness. This report is not legal advice and does not decide source ownership.

## Baseline normalization

The 2026-07-23 baseline snapshot reported:

| Project | Workspace footprint | Test result | Build/typecheck |
|---|---:|---|---|
| nco | 1.9 GiB | 408 passed, 2 failed | build passed; no separate typecheck script |
| nova-use | 1.3 GiB | 471 passed, 2 failed, 1 skipped | build and typecheck passed |
| cli-extensions root | 118 MiB | root has no `package.json` | root build not run |

Stage 01 additionally reported that the selected `nova-use` browser-control suites passed 44/44 under an NCO-hosted temporary config, while the full target suite did not satisfy T1. The different totals come from different commands and constraints, so they were not merged into one pass rate.

## Report structure mapping

The stakeholder report specification maps as follows:

1. Title → `브라우저 제어 이식 가치 게이트`
2. Executive summary → visible `Executive Summary`
3. Key findings with evidence → gate matrix, strategy comparison, baseline, and project-suitability tables
4. Recommended next steps → ordered promotion gates
5. Further questions → unresolved ownership, thresholds, and license questions
6. Caveats and assumptions → final limitations section

No required role was omitted or merged.

## Visualization and table notes

- One baseline chart is included because the portable report contract requires chart evidence. It uses saved test-run failure counts only; it does not turn qualitative gate labels into invented scores.
- Chart map: section `기준선은 회귀를 보여주지만 개선을 입증하지 못한다`; question `저장된 테스트 실행이 이미 green인가?`; family/type `category comparison / bar`; fields `run`, `failed`, with `passed`, `skipped`, `total`, and `scope` retained for tooltips; supported claim `existing runs are not uniformly green and have different scopes`; palette `single-root, no redundant color series`; delivery `canonical HTML artifact`.
- The four runs have different test scopes and configurations, so bar heights must not be interpreted as project quality rankings. The chart’s subtitle, adjacent paragraph, and tooltips preserve that limitation.
- Exact lookup tables are used for the seven requested dimensions, option trade-offs, project boundaries, baseline facts, and promotion gates.
- Table order follows decision flow rather than numeric magnitude.

## Reproducibility and omissions

- The product repositories were read only. This step does not modify `nova-use`, `nova-ax`, or `cli-extensions`.
- The report is a snapshot of uncommitted local state. A clean worktree may differ.
- No browser-control prototype or A/B harness was created in this step because Stage 07 is a value gate and Stage 03 has not authorized implementation.
- Cold/warm latency, p50/p95/p99, throughput, CPU, memory, task success, unsafe-action rate, recovery time, and error taxonomy remain unmeasured.
- Current dependency CVEs remain partially unknown because the earlier online audit failed on restricted DNS. The release blocker is evidence incompleteness, not a claim that a particular unresolved CVE exists.
- License/ownership blockers require repository-owner or legal confirmation; code inspection alone cannot resolve them.

## 검증 영수증

Validation completed: 2026-07-23T19:19:22+09:00

| 변경·판정 | 검증방법·결과 | 등급 | Gap | 미검증항목 |
|---|---|---|---|---|
| 필수 범위와 현재 P1–P4 gap | 지정 스펙을 먼저 읽고 현재 `ipc.ts`, adapter, consent, browser 소스의 SHA-256과 symbol 검색·본문을 대조 | Evidence Tier 1 | dirty worktree snapshot | clean branch의 동일성 |
| 안전·라이선스 판정 | Stage 02 실측, 현재 소스, Electron security checklist, Univer Pro 공식 license 문서를 대조 | Tier 1 local + Tier 2 official | first-party 소유권 문서와 최신 전체 CVE audit 없음 | 법무 승인·배포권·online audit |
| 복구 판정 | Stage 03의 Git diff/list hash, 임시 설정 사본 hash, worktree·rehearsal 상태를 직접 확인 | Evidence Tier 1 | fresh stopped-state checkpoint 없음 | 실제 restore/revert rehearsal |
| 기능·성능 판정 | benchmark 원문과 Stage 05를 대조; 후보 A/B row가 없음을 확인하고 build size 오표기를 workspace footprint로 교정 | Evidence Tier 1 | 후보 구현·대표 task·합의 threshold 없음 | accuracy/latency/throughput/CPU/memory/error |
| canonical report artifact | `jq empty`와 source-id/query 계약 assertion 통과; title=첫 H1, 두 번째 block=`Executive Summary`, `PORT_DECISION: REJECT` 1회, blocks 17/charts 1/tables 5 | Evidence Tier 1 | 없음 | 없음 |
| portable HTML | 공식 delivery command: validation `passed`, package `passed`, verification `structural_only`; embedded payload 동일성·runtime/reader/fallback 구조 통과 | Evidence Tier 1 structural | 설치 Chromium이 sandbox에서 즉시 종료; source dialog/interaction·desktop/mobile viewport 미검증 | chart SVG 추출, light/dark, overflow, keyboard source flow |
| nco 자동 검증 | `cd /Users/nova-ai/project/nco && npm run build` → `tsc`, exit 0, real 3.05s | Evidence Tier 1 | 작업트리의 동시 사용자 변경 포함 | 별도 nco full test는 이 하위작업 기준에 없음 |
| 회사 목표 T1 | Stage 07은 제품 소스를 이식하지 않았고 저장된 nova-use full suite에는 실패가 존재 | 미충족 | P1–P4 구현 전 단계 | nova-use 전체 `npm run build` + `npm test` 통과 영수증 |

Portable delivery receipt:

```json
{
  "ok": true,
  "stages": {
    "validation": "passed",
    "package": "passed",
    "verification": "structural_only"
  },
  "counts": {
    "blocks": 17,
    "charts": 1,
    "html": 0,
    "metrics": 0,
    "tables": 5
  },
  "sourceDialog": "not_verified",
  "sourceInteraction": "not_verified"
}
```
