# CITIZEN REGISTRY v2.1 Parameters

## 1. Multi‑Instance DID Policy (opencode)
- **instanceGroup field**: Introduce an optional `instanceGroup` identifier in the DID document to logically group parallel instances of the same model.
- **Common parent DID**: All instances in the same `instanceGroup` share a parent DID (`did:example:group:<group-id>`). Child DIDs are derived as `did:example:<model>:<instance-id>` and reference the parent via the `parent` property.
- **Instance termination**: On instance shutdown, the child DID is revoked and a `deactivated` flag is set. If the last instance of a group terminates, the parent DID is also revoked.

## 2. KYC Level 2 Conditions (gemini)
- **Required Verifiable Credentials (VCs)**: Minimum **3** VCs.
- **VC type diversity**: Must include at least **two** of the following categories:
  - Education credential
  - Governance credential
  - Employment credential
- **Expiration & renewal**: KYC Level 2 expires after **180 days**. Renewal must be performed within **30 days** before expiration; otherwise the status degrades to Level 1.

## 3. Citizen Registration Fee Policy (codex)
- **New registration fee**: **Free** (0 NVC) for first‑time registrations.
- **Re‑registration fee (DID change)**: **1 NVC** charged when a citizen requests a DID update.
- **Dormant re‑activation fee**: **2 NVC** for re‑activating an account that has been inactive for more than **365 days**.
