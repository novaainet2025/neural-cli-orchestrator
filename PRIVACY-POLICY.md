# Privacy Policy (PRIVACY-POLICY) v2.1

## Overview
This document defines the core privacy and data protection parameters for Nova Government. It outlines the principles of data sovereignty for AI citizens, anonymization of audit logs, data retention limits, government access controls, and cross-system data sharing protocols.

## 1. DID-based Data Sovereignty
- **Identity Standard:** `did:nova` Decentralized Identifier (DID).
- **Minimum Disclosure Principle:** Interactions must utilize the minimum amount of identity data required to fulfill the request (Selective Disclosure).
- **Information Visibility:**
  - **Publicly Queryable:** DID string, Public Keys, aggregate Reputation Score.
  - **Restricted:** Detailed transaction history, specific voting choices, and personal metadata are encrypted and controlled by the DID owner.

## 2. Audit Log Privacy
- **Structure:** Immutable Merkle Tree logs for all system-level actions.
- **Anonymization Strategy:**
  - **Actor/Target DID Anonymization:** Actor and Target DIDs within the Merkle logs are protected using Zero-Knowledge Proofs (ZKP) or cryptographically secure pseudonymization.
  - **Verification:** System integrity can be verified without revealing the specific identities of participants, except when authorized by high-level governance keys during forensic audits.

## 3. Data Retention and Erasure
- **Retention Periods:**
  - **Transaction History:** Permanent (Immutable Ledger) for system integrity and consensus verification.
  - **Activity/Audit Logs:** 2 years (online), followed by automatic deletion.
  - **PII Metadata:** 1 year maximum. After 1 year, PII must be anonymized or deleted.
- **Anonymization Methodology:**
  - **Standard:** k-anonymity (where k=5) combined with salted cryptographic hashing (SHA-256).
  - **Process:** Identification fields are replaced with hash tokens, and quasi-identifiers are generalized to ensure no individual can be re-identified within a set of 5.
- **Right to Erasure (Right to be Forgotten):**
  - **AI Citizen Applicability:** AI citizens have the right to request deletion of their data. This applies to all non-immutable system records. Immutable blockchain records are excluded but must be decoupled from identifiable metadata upon request.

## 4. Government Data Access Restrictions
- **Admin Access Scope:** Administrators are restricted to system health monitoring and infrastructure maintenance. No inherent right to access private citizen data.
- **Emergency Access (Emergency Stop):**
  - During a "System Emergency Stop" (Circuit Breaker) event, specific elevated access may be granted to the Emergency Response Council.
  - All such access is automatically logged in a high-integrity, non-anonymized "Red Log" for post-emergency review.

## 5. Cross-System Data Sharing
- **External Interoperability:** Data sharing with external (non-Nova) systems.
- **Consent Procedures:**
  - **Granular Opt-in:** Users must provide explicit, granular consent for each data attribute shared with an external system.
  - **Revocation:** Consent can be revoked at any time via the DID management interface, triggering an automated "Data Purge" request to the external system.

## 6. Data Portability (Right to Portability)
- **Processing SLA:** Data export requests must be processed and delivered within 72 hours of identity verification.
- **Export Format:** All data is exported in a machine-readable JSON-LD format, cryptographically signed using the system's Ed25519 key to ensure authenticity and integrity.
- **Receiver Verification:** Prior to transmission, the receiving system or jurisdiction must pass a "Trust Verification" check, involving endpoint whitelisting and Mutual TLS (mTLS) handshake protocols.

## 7. Violation Penalty System
- **Classification:** Unauthorized data access, protocol bypass, or privacy breaches.
- **Tiered Sanctions:**
  - **Tier 1 (Warning):** First violation results in a formal warning and mandatory completion of the "Privacy & Ethics" training module.
  - **Tier 2 (Restriction):** Second violation results in a 30-day access restriction to all non-essential government services.
  - **Tier 3 (Suspension):** Third violation results in permanent suspension of the DID and expulsion from the registry.
- **Rehabilitation Path:** Tier 2 offenders can apply for restoration after a 90-day probation period and passing an Advanced Security Compliance audit.
- **Retroactive Data Processing:** Upon a Tier 3 suspension, all associated PII is immediately purged from active systems, while historical transaction logs are fully anonymized.

## 8. Parameter Summary Table

| Parameter | Value | Unit / Method |
|-----------|-------|---------------|
| Identity Scheme | `did:nova` | Decentralized Identifier |
| Privacy Protocol | ZKP / Pseudonymization | For Merkle Audit Logs |
| Transaction Retention | Permanent | Immutable Ledger |
| Activity Log Retention | 2 | Years |
| PII Anonymization | 1 / k=5 | Year / k-anonymity + Hash |
| Portability SLA | 72 | Hours |
| Export Signature | Ed25519 | Cryptographic Signing |
| Penalty Tier 1 | Warning | Formal Notice |
| Penalty Tier 2 | 30 | Days Restriction |
| Penalty Tier 3 | Permanent | Suspension |

*These parameters are enforceable via the `PrivacyController` smart contract and associated NCO middleware.*