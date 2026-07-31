#!/usr/bin/env node
/**
 * Independent content-quality checker for ax-docs work reports.
 * Producer: content-metrics-collector (independent of actor "ax-docs-agent").
 *
 * Replicates DirectArtifactObserver's visible-character algorithm so the
 * measured char count is the same number the inspection institution sees.
 */
import { readFileSync } from "fs";

export function visibleCharacters(raw) {
  const primary =
    raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    raw;
  return primary
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function runChecks(path) {
  const raw = readFileSync(path, "utf8");
  const visible = visibleCharacters(raw);
  const checks = [
    { id: "content-floor-1200", pass: visible.length >= 1200 },
    { id: "no-english-draft-marker", pass: !/\b(?:draft|placeholder|lorem ipsum|coming soon)\b/i.test(raw) },
    { id: "no-korean-draft-marker", pass: !/(?:임시\s*저장|작성\s*중|준비\s*중)/.test(raw) },
    { id: "section-core-work", pass: /핵심\s*업무/.test(raw) },
    { id: "section-issues", pass: /이슈/.test(raw) },
    { id: "section-next-actions", pass: /다음\s*액션/.test(raw) },
    { id: "section-data-availability", pass: /확인\s*불가/.test(raw) && /가용/.test(raw) },
    { id: "korean-only-body", pass: !/(?:\b[A-Za-z]+\b[ ,.]+){4,}/.test(raw.replace(/`[^`]*`/g, "")) },
    { id: "section-spec-tracking", pass: /스펙\s*추적/.test(raw) },
    {
      id: "real-kpis-present",
      pass: ["106", "81", "80.8", "68.47", "33,154"].every(n => raw.includes(n)),
    },
  ];
  return {
    path,
    byteSize: Buffer.byteLength(raw),
    visibleCharacters: visible.length,
    checks,
    passedChecks: checks.filter(c => c.pass).length,
    totalChecks: checks.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = runChecks(process.argv[2]);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
