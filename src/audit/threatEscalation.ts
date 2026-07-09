// Threat escalation handling
// Nova Government – Security policy implementation
// Implements automatic actions based on threat level definitions.

import {
  blacklistDid,
  isBlacklisted,
  restrictDid,
  ThreatLevel as EmergencyThreatLevel,
  triggerEmergencyStop,
} from "./emergencyService.js";
import type { DID } from "../identity/keyManager.js";
// Import statements omitted – actions are logged; integrate with actual CommandGate/CircuitBreaker as needed

const SYSTEM_DID = "did:nova:system" as DID;
const GOVERNMENT_DID = "did:nova:0000000000000000government00000000" as DID;

/**
 * Threat level enumeration.
 * 1 – Warning + log
 * 2 – Transfer restriction for 24h (implemented via CommandGate)
 * 3 – Account freeze for 48h and governance vote required
 * 4 – Immediate blacklist + emergency stop
 */
export enum ThreatLevel {
  Level1 = 1,
  Level2 = 2,
  Level3 = 3,
  Level4 = 4,
}

/**
 * Handles a detected threat by performing the appropriate automatic action.
 * @param level Threat level (1‑4).
 * @param did   DID of the affected account.
 * @param info  Additional context (e.g., reason, nonce, amount).
 */
export function handleThreat(
  level: ThreatLevel,
  did: string,
  info: { reason: string; extra?: string }
): void {
  switch (level) {
    case ThreatLevel.Level1:
      // Simple warning – just log the event.
      console.warn(`[Threat] Level1 warning for ${did}: ${info.reason}`);
      break;
    case ThreatLevel.Level2:
      // Restrict transfers for 24h via CommandGate.
      console.info(`[Threat] Level2 restricting transfers for ${did}`);
      restrictDid(did, EmergencyThreatLevel.LEVEL_2, info.reason, SYSTEM_DID);
      break;
    case ThreatLevel.Level3:
      // Freeze account for 48h and emit governance required event.
      console.info(`[Threat] Level3 freezing account ${did}`);
      restrictDid(did, EmergencyThreatLevel.LEVEL_3, info.reason, SYSTEM_DID);
      // Governance vote would be handled elsewhere; we just emit a log.
      console.info(`[Threat] Governance vote required to lift freeze for ${did}`);
      break;
    case ThreatLevel.Level4:
      // Immediate blacklist and emergency stop.
      console.info(`[Threat] Level4 blacklisting and emergency stop for ${did}`);
      if (!isBlacklisted(did)) {
        blacklistDid(did, info.reason, SYSTEM_DID);
      }
      try {
        triggerEmergencyStop(GOVERNMENT_DID, `Threat Level4 for ${did}: ${info.reason}`);
      } catch (e) {
        console.error("Failed to trigger emergency stop", e);
        throw e;
      }
      break;
    default:
      console.warn(`[Threat] Unknown level ${level} for ${did}`);
  }
}
