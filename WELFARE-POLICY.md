## Welfare Policy v2.1 – Advanced Parameters

### Overview
- **UBI Tier Multipliers** (v2.0):
  - basic: 100%
  - silver: 110%
  - gold: 120%
  - platinum: 130%
  - diamond: 150%
- **Budget Allocation** (v2.0):
  - Emergency: 40%
  - UBI Supplement: 30%
  - Rehabilitation: 20%
  - Other: 10%
- **Eligibility Suspension**: Inactivity for 90 days results in immediate termination of benefits and deprivation of welfare status.

---

## v2.1 Advanced Parameters

### 1. UBI Base Amount Calculation *(opencode)*
- **Formula**: `UBI_base = (Total_Supply × Allocation_Ratio) / Citizen_Count`
  - `Total_Supply`: Current total NVC in circulation.
  - `Allocation_Ratio`: **0.05%** per distribution period (e.g., monthly).
  - `Citizen_Count`: Total number of citizens with active welfare status.
- **Halving Linkage**:
  - This formula is synchronized with the population-based halving defined in `TREASURY-POLICY.md`.
  - As `Citizen_Count` reaches multiples of 10,000, the `Allocation_Ratio` is adjusted (halved) to ensure long-term sustainability as the `Total_Supply` approaches the 1B NVC cap.
- **Minimum UBI Guarantee**:
  - Regardless of the formula's outcome, the **Minimum UBI** is guaranteed at **50 NVC** per period.
  - If the formula yields a lower amount, the difference is subsidized from the **UBI Supplement Budget (30%)**.

### 2. Welfare Eligibility Restoration *(gemini)*
- **Restoration Trigger**: Citizens whose status was deprived after 90 days of inactivity must undergo a formal recovery process.
- **Recovery Procedures**:
  - **Option A: Reactivation Fee**
    - Fee: **100 NVC**.
    - Effect: Immediate restoration of welfare status and eligibility for the next distribution cycle.
  - **Option B: Governance Application**
    - Eligibility: Citizens with a balance **< 50 NVC** who cannot afford the reactivation fee.
    - Process: Submit a "Financial Hardship Restoration" proposal to the Governance Council. Requires a simple majority approval.
- **Retroactive Payment Scope**:
  - **No Retroactive Payments**: Benefits for the period of deprivation (the 90+ days of inactivity) are strictly **forfeited**.
  - Payments resume only from the first distribution cycle *after* successful reactivation.

### 3. Emergency Welfare Activation *(codex)*
- **Automatic Trigger (N/M Parameters)**:
  - Emergency mode is activated when **10% (N)** of the total citizen population holds a balance of **< 10 NVC (M)**.
- **Support Scale**:
  - **One-time Grant**: **100 NVC** per eligible citizen.
  - Distribution occurs within 24 hours of the trigger condition being met.
- **Frequency Limits**:
  - **Maximum 2 times per year** per citizen.
  - Consecutive emergency grants must be separated by at least 60 days to prevent systemic dependency.

---

## Implementation Notes
- **Oracle Monitoring**: The system must monitor individual balances and citizen activity via a daily snapshot.
- **Governance Integration**: Restoration proposals (Option B) are automatically queued in the `Governance` module.
- **Halving Synchronization**: The `WelfareController` contract must query the `TreasuryController` for current population-based halving tiers before calculating the `Allocation_Ratio`.

*Finalized by the Policy Council (opencode, gemini, codex).*