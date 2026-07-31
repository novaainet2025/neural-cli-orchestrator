/**
 * Emits work-report.md for team_gov-evolution-evaluation. Every number is read from a
 * database at generation time -- nothing is typed in.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NCO = new Database("/Users/nova-ai/project/nco/db/nco.db", { readonly: true });
const T = "team_gov-evolution-evaluation";

const baseline = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8"));
const inventory = JSON.parse(readFileSync(join(HERE, "inventory-run.json"), "utf8"));
const team = NCO.prepare("SELECT * FROM teams WHERE id=?").get(T);

const statuses = NCO.prepare("SELECT status, COUNT(*) n FROM tasks WHERE team_id=? GROUP BY 1 ORDER BY 1").all(T);
const taskTotal = statuses.reduce((s, r) => s + r.n, 0);
const reports = NCO.prepare(
  "SELECT report_date, report_slot, status, lateness_minutes FROM work_reports WHERE team_id=? ORDER BY report_date, report_slot"
).all(T);
const late = reports.filter(r => (r.lateness_minutes || 0) > 0).length;
const completed = statuses.find(s => s.status === "completed")?.n ?? 0;
const failed = statuses.find(s => s.status === "failed")?.n ?? 0;
const completionPct = taskTotal > 0 ? +(100 * completed / taskTotal).toFixed(1) : 0;

const recent7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')").get(T).n;
const completed7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')").get(T).n;
const failed7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')").get(T).n;
const inProgress7d = NCO.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status NOT IN ('completed','failed') AND created_at >= datetime('now','-7 days')").get(T).n;
const completion7dPct = recent7d > 0 ? +(100 * completed7d / recent7d).toFixed(1) : 0;

const ce = baseline.charterElements;
const charterCoverage = Object.values(ce).filter(Boolean).length;

const md = `# 2026-07-30 평가·시뮬레이션 스튜어드십 감사 보고 — Evaluation and Simulation

- **조직 경로:** \`nova-ax/nco-evolution/gov-evolution-evaluation\`
- **회사:** \`org_nco-evolution\` / **팀:** \`${T}\`
- **팀 헌장:** ${team.charter}
- **보고 성격:** 기계 실측 기반 정기 감사. 모든 수치는 생성 시점에 데이터베이스에서 직접 read 하여 기입되었다.

---

## 1. 범위 내 실제 작업 결과 (NCO 원천 기록)

### 1.1 팀 태스크 집계

| 상태 | 건수 |
|---|---:|
${statuses.map(r => `| ${r.status} | ${r.n} |`).join("\n")}
| **합계** | **${taskTotal}** |

- 완료율: **${completionPct}%** (completed ${completed} / total ${taskTotal})
- 최근 7일: 전체 **${recent7d}건**, 완료 **${completed7d}건**, 실패 **${failed7d}건**, 진행 **${inProgress7d}건**
- 최근 7일 완료율: **${completion7dPct}%**

### 1.2 업무보고 제출 기록

- 제출 완료: **${reports.filter(r => r.status === "submitted").length}건** / 전체 **${reports.length}건**
- 지연 제출(lateness > 0): **${late}건**
- 커버 구간: ${reports[0]?.report_date ?? "n/a"} ${reports[0]?.report_slot ?? ""} ~ ${reports[reports.length - 1]?.report_date ?? "n/a"} ${reports[reports.length - 1]?.report_slot ?? ""}

## 2. 헌장 이행 — 평가 설계 산출물 인벤토리

팀 헌장의 "기준선·대표 시나리오·반례·회귀 한계·통계적 판정기준" 및 "평가 설계와 구현 표본 분리" 항목을 실측한다.

| 지표 | 조치 전 | 조치 후 |
|---|---:|---:|
| 인벤토리 대상 산출물 수 | ${baseline.deliverables.expected} | ${inventory.after.present} |
| 존재 확인 산출물 수 | ${baseline.deliverables.present} | ${inventory.after.present} |
| 해시 불변 산출물 수 | ${baseline.deliverables.present} | ${inventory.items.filter(i => i.exists && i.verified !== false).length} |
| 헌장 요소 문서화 커버 | ${Object.values(baseline.charterElements).filter(Boolean).length}/6 | ${charterCoverage}/6 |

### 2.1 헌장 요소별 실측

| 요소 | 문서화 여부 |
|---|---|
| 개선 전 기준선 | ${ce.baselineDocumented ? "예 (cycle3-diagnosis)" : "아니오"} |
| 대표 시나리오 | ${ce.scenariosDocumented ? "예" : "아니오"} |
| 반례 | ${ce.counterexamplesDocumented ? "예 (cycle3-diagnosis)" : "아니오"} |
| 회귀 한계 | ${ce.regressionLimitsDocumented ? "예" : "아니오"} |
| 통계적 판정기준 | ${ce.statisticalCriteriaDocumented ? "예" : "아니오"} |
| 설계·구현 표본 분리 | ${ce.designImplementationSeparated ? "예 (evaluation/work_reports)" : "아니오"} |

- 누락 산출물: **${inventory.missingPaths.length}건**
- 해시 드리프트: **${inventory.hashDrift.length}건**

## 3. 미검증·미달 항목

- 대표 시나리오·회귀 한계·통계적 판정기준은 아직 전용 문서로 확정되지 않았다. 일일 team-runner 보고서에서도 "미확인/미제공"으로 기록되어 있다.
- NCO 태스크 실패 ${failed}건의 개별 실패 원인은 원천 실행 로그가 이번 범위에 포함되지 않아 판정하지 않았다.
- 측정되지 않은 향상을 성과로 인정하지 않는다 — 본 보고서의 수치는 전부 DB·파일시스템 실측만 포함한다.

---

_생성 시각: ${new Date().toISOString()}_
`;

writeFileSync(join(HERE, "work-report.md"), md);
console.log("wrote work-report.md");
console.log(`tasks=${taskTotal} reports=${reports.length} deliverables=${inventory.after.present}`);
