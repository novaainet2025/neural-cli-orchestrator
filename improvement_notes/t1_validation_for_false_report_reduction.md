## T1 Validation Implementation for False Report Reduction in Triad Build & Verify

**Root Cause Analysis**: Current false report rate of 17% (17 false reports out of 100 tasks) due to lack of T1 validation before reporting (per Obsidian_NCO_Improvement_Strategy_2026-06-30.md).

**Action Plan**:
1. Implement pre-report T1 validation check in reporting pipeline
2. Add `false_report_count` monitoring
3. Update workflow to require T1 pass before submission

**Verification Method**:
```
# Run tests with T1 validation enabled
npm run test -- --filter=triad-verify

# Expected output
[Metrics] false_report_count: 3 (target: ≤5)
[Metrics] success_rate: 95.2% (target: ≥95%)
```

**Required Code Changes**:
```typescript
// In /src/reporting/validator.ts
export function validateT1(taskId: string): boolean {
  const task = getTaskHistory(taskId);
  return task.status === "verified" && task.logs.length > 0;
}
```

**Implementation Notes**:
- Reversible: Disable via `T1_VALIDATION=off` env var
- Bounded: Only affects tasks marked `triad-build-verify`
- Gap: Requires `getTaskHistory` API validation (see #128)