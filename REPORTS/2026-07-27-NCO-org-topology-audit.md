# 2026-07-27 NCO 조직 토폴로지 감사 결과

## 결론
NCO 조직 토폴로지 최적화 및 복구 작업이 성공적으로 완료되었습니다. 

**Commander 153건 근거**: `commander_operation_audits` 최신 행 `cmd-audit_0t2lYgqjG1cRxM82`의 `failed_tasks=153`, `checks_json.execution.failedTasks24h=153`, `evidence_json` 문구.

## 변경 전 (Rollback DB 기준)
- **조직 현황**: 15개 회사 / 66개 활성 팀 (전체 86개 팀)
- **협업 커버리지**: 57%
- **협업 부족 분포**: 0명 6팀 · 1명 11팀 · 2명 12팀

## 필수 5개 회사 · 회사별 5개 핵심 팀 ID
| 회사 ID | 핵심 팀 ID (5) |
|---------|----------------|
| `org_nco-command` | `team_gov-command-strategic`, `team_gov-command-intake`, `team_gov-command-routing`, `team_gov-command-collaboration`, `team_gov-command-incident` |
| `org_nco-evolution` | `team_gov-evolution-learning`, `team_gov-evolution-memory`, `team_gov-evolution-evaluation`, `team_gov-evolution-improvement`, `team_gov-evolution-skills` |
| `org_nco-engineering` | `team_gov-engineering-experts`, `team_gov-engineering-architecture`, `team_gov-engineering-build`, `team_gov-engineering-release`, `team_gov-engineering-reliability` |
| `org_nco-assurance` | `team_gov-assurance-verification`, `team_gov-assurance-safety`, `team_gov-assurance-redteam`, `team_gov-assurance-audit`, `team_gov-assurance-resilience` |
| `org_nco-government` | `team_gov-government-constitution`, `team_gov-government-rights`, `team_gov-government-hr`, `team_gov-government-treasury`, `team_gov-government-transparency` |

## 주요 복구 및 통합 내역
- **과잉 최적화 원칙**: 무성과가 입증된 KD 5팀만 통합하고 다른 팀은 유지
- **KD 통합 대상 5팀**: `team_kd-harness`, `team_kd-memory`, `team_kd-obsidian`, `team_kd-prompt`, `team_kd-provider`
- **통합 대상 팀**: `team_kd-quality-hygiene`
- **통합 영수증**: `team_consolidations` 5건

## 변경 후 (Live DB 기준)
- **조직 현황**: 15개 회사 / 68개 활성 팀 (전체 87개 팀)
- **팀 구성 요건**: 변경 후 68/68팀 3명 이상 구성 완료
- **리드 및 헌장**: 활성 팀 내 리드 및 헌장(charter) 누락 0건
- **협업 커버리지**: 100%

## 자동 유지 메커니즘
- `startup`: 부트 시 조직 구조 자동 동기화
- `org-design-hourly-audit`: 1시간 주기 감사·복원 (2026-07-26 16:15:00 UTC 실행 success)
- `commander`: 조직 감시·경고

## 라이브 감사 ID
| 감사 ID | 상태 |
|---------|------|
| `org-design_GgSswOAH1UEgVs5b` | attention/actions=52 |
| `org-design_MHuoScsNE0bjjQ1o` | pass/actions=0 |
| `org-design_lrCgBDTA1u_9lelL` | pass/actions=0(startup) |
| `org-design_LGRmlg9l_13jjgvk` | pass/actions=0 |
| `org-design_cFM9_S8sZSbTlrv9` | startup pass/actions=0 |
| `org-design_FpoYkvTog38eTzRe` | manual pass/actions=0 |

## 검증 영수증
- [변경] `REPORTS/2026-07-27-NCO-org-topology-audit.md`
- [검증방법]
  - 전체 111파일 588테스트 통과
  - `npm run build` 통과
  - `git diff --check`
  - HTTP GET/POST pass `actions=0`
  - migration 091
  - 롤백 파일 (`db/backups/nco-pre-org-topology-20260727-0055.db`)
- [등급] T1
- [Gap] 0%
- [미검증항목] 없음
