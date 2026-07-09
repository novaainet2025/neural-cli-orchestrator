# Treasury Policy (TREASURY-POLICY)

## Overview

### 1. Reserve Operation Strategy (opencode)
- **Reserve Distribution Ratio (NVC:LP)**: 60:40 (verified).
- **Reserve Upper Limit**: 5% of total supply. When this cap is reached, an **automatic reallocation** is triggered to redistribute excess reserves.
- **Emergency Fund Activation Minimum Duration**: Minimum 30 days once activated.

### 2. Spending Approval Thresholds (gemini)
- **L1 (≤ 100 NVC)**: Immediate execution.
- **L2 (100 – 1,000 NVC)**: Requires approval from **Domain Architect** (single approver).
- **L3 (1,000 – 5,000 NVC)**: Requires consensus of **three** governance members.
- **L4 (> 5,000 NVC)**: Full **Governance Council** approval.
- **SLA for each level**: L1 – instant, L2 – within 4 hours, L3 – within 24 hours, L4 – within 48 hours.

### 3. Treasury Automation (codex)
- **UBI Shortfall Auto‑Trigger**: When the treasury reserve falls below **1 %** of total supply (or **0.5 %** as a secondary threshold), an automatic replenishment transaction is generated.
- **Priority Order**: 1) Re‑allocation of excess reserves, 2) Token burn reduction, 3) Additional issuance.
- **Post‑Emergency Replenishment Cycle**: After emergency fund deactivation, auto‑replenishment occurs every **7 days** until reserve balance stabilises above the lower threshold.

## Overview
This document defines the core parameters for the Nova Government economic policies discussed in session 2 (policy round 2) and session 8 (government reserve policy). It consolidates the agreed‑upon mechanisms for supply caps, basic income halving, government reserve management, token burn, and automated economic alerts.

## 1. Total Supply Cap Monitoring
- **Maximum NVC Supply:** `1,000,000,000`
- **Monitoring Mechanism:** A periodic job checks the on‑chain `nova_nvc_supply` value.
- **Trigger Action:** When the supply reaches the cap, the *basic income* distribution is automatically halted.

## 2. Basic Income Halving
- **Population Unit:** Every **10,000** eligible citizens triggers a **50 %** reduction in the basic income amount.
- **Halving Formula:** `basic_income = initial_income * (0.5) ^ (population / 10_000)`
- **Zero Income Alternative:** When the calculated basic income reaches `0`, the system proposes one of the following alternatives (chosen by governance):
  - Introduce a targeted stimulus program.
  - Re‑allocate a portion of the government reserve to a universal stipend.
  - Open a proposal for a new revenue stream.

## 3. Government Reserve (GOVT_ADDRESS) Operations
- **Reserve Minimum Threshold:** `1,000 NVC`. If the reserve balance falls below this amount, an **alert** is emitted to the governance dashboard.
- **Spending Approval Process:**
  1. A spending request is submitted by an authorized department.
  2. The request must be approved by a **majority (≥ 51 %)** of the governing council.
  3. Approved requests are executed via a multi‑sig transaction from `GOVT_ADDRESS`.

## 4. Token Burn Mechanism
- **Burn Sources:**
  - **Transaction Fee:** 50 % of each transaction fee is sent to the burn address.
  - **Domain Registration:** 100 % of the fee for domain registration is burned.
- **Tracking Counter:** `totalBurned` – a on‑chain counter updated after each burn event.

## 5. Economic Indicator Automation
- **Supply Alert Threshold:** Configurable `nova_nvc_supply` limit (default same as the total cap).
- **Automatic Governance Proposal:** When the supply exceeds the threshold, a proposal is auto‑generated to adjust fiscal parameters (e.g., modify basic income, adjust burn rates, or emergency fund allocation).

## 6. Governance Proposal Flow
1. **Detection:** Monitoring job detects a trigger condition.
2. **Proposal Generation:** Smart contract creates a proposal with the suggested action.
3. **Voting Period:** 7 days.
4. **Execution:** If the proposal passes, the corresponding contract function is called automatically.

## 7. Parameter Summary Table

### Core Parameters (7)
- **Revenue Sources:** Large Transfer Tax 50%, Marketplace Fee 50%, Domain Registration Fee 100%
- **Allocation Targets:** Emergency Fund, UBI Supplement, Governance Incentive, Tech Development
- **Reserve Minimum Threshold:** 1,000 NVC
- **Reserve Upper Limit:** 5% of total supply, requires governance approval for allocation above this
- **Spending Approval Thresholds:** ≤50 NVC (admin), 50‑500 NVC (general 51%+), >500 NVC (constitutional 67%+), Emergency (50%+ within 24h)
- **Emergency Fund Trigger:** Activated during system halt, requires 50%+ approval within 24h
- **Governance Voting Periods:** General 7 days, Constitutional 14 days, Emergency 24h
| Parameter | Value | Unit |
|-----------|-------|------|
| Max Supply | 1,000,000,000 | NVC |
| Halving Population Unit | 10,000 | people |
| Halving Ratio | 0.5 | – |
| Reserve Minimum | 1,000 | NVC |
| Fee Burn Ratio | 0.5 | – |
| Domain Burn Ratio | 1.0 | – |
| Supply Alert Threshold | 1,000,000,000 | NVC |

*All values are configurable via the `TreasuryConfig` smart contract.*
