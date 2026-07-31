[Nova-AX Verification Policy Update]

**Top Priority Mission**:
All active company/team work reports must be received, mandatory audits are required, and 6/6 audit pass is the absolute top priority. Completion and score cannot be reflected before audit passage.

**Critical Rules**:
- All reports must be received before audit initiation
- Audit required task (`audit_required`) has priority=10
- Remediation task (`remediation`) has priority=10 but is processed first
- Public announcement is pinned to highest priority
- API endpoint `/api/verification/policies` exposes topPriority field