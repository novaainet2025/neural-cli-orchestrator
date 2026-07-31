# Subagent Recovery Loop

## State Machine
waiting_retry → retrying → awaiting_result → awaiting_verification → [resolved | awaiting_remediation]

## Retry Policy
- Hot retry: 30s → 2m → 10m → 30m → 2h
- Cold retry: max 6h intervals after 5 attempts
- 6h cooldown after 10 retries

## Important Rules
- Never auto-retry `policy_paused` or `operator_attention`
- `operator_attention` → cold retry still allowed
- 6/6 verification + receipt consumption required for resolved state