// SPDX-License-Identifier: MIT
/**
 * Royalty Distribution Service
 *
 * Provides utilities to calculate and distribute royalties when a sale occurs.
 * Three public functions are exported as the final API:
 *   1. `calculateRoyaltyAmount(salePrice: number, royaltyPct: number): number`
 *   2. `determineRoyaltyRecipients(saleInfo: SaleInfo): RoyaltyBreakdown`
 *   3. `processRoyaltyDistribution(saleInfo: SaleInfo): Promise<void>`
 *
 * The service is deliberately lightweight – it performs pure calculations and
 * delegates the actual token transfer to `sendNVC`, which is expected to be
 * implemented elsewhere in the codebase (e.g., a blockchain or wallet module).
 *
 * Edge‑case handling:
 *   - `royaltyPct` must be within 0‑20 % (inclusive). Values outside this range
 *     throw an Error.
 *   - `salePrice` must be non‑negative; negative values throw.
 *   - The distribution chain is fixed at 5 % → creator, 3 % → platform, 2 % →
 *     curator (example). The percentages are applied in order; any remainder
 *     stays with the seller.
 */

/** Types used by the service */
export interface SaleInfo {
  /** Unique identifier of the sale */
  saleId: string;
  /** Sale price in the smallest currency unit (e.g., wei) */
  salePrice: number;
  /** Percentage of the sale price to allocate as total royalty (0‑20) */
  royaltyPct: number;
  /** Address of the seller */
  sellerAddress: string;
  /** Address of the creator */
  creatorAddress: string;
  /** Address of the platform (e.g., the marketplace) */
  platformAddress: string;
  /** Address of the curator or additional beneficiary */
  curatorAddress?: string;
}

/** Result of a royalty breakdown */
export interface RoyaltyBreakdown {
  /** Amount sent to the creator */
  creatorAmount: number;
  /** Amount sent to the platform */
  platformAmount: number;
  /** Amount sent to the curator (if any) */
  curatorAmount: number;
  /** Amount retained by the seller after royalties */
  sellerNet: number;
}

/**
 * Calculate the raw royalty amount from a sale price and percentage.
 *
 * @param salePrice – total sale price (non‑negative integer)
 * @param royaltyPct – percentage (0‑20). Values outside this range cause an Error.
 * @returns royalty amount rounded down to the nearest integer.
 */
export function calculateRoyaltyAmount(salePrice: number, royaltyPct: number): number {
  if (salePrice < 0) throw new Error('salePrice must be non‑negative');
  if (royaltyPct < 0 || royaltyPct > 20) throw new Error('royaltyPct must be between 0 and 20');
  // Integer arithmetic – floor the result.
  return Math.floor((salePrice * royaltyPct) / 100);
}

/**
 * Determine how the total royalty is split among beneficiaries.
 * The split follows the fixed 5 % → creator, 3 % → platform, 2 % → curator rule.
 * If a curator address is not supplied, its share is added back to the seller.
 */
export function determineRoyaltyRecipients(saleInfo: SaleInfo): RoyaltyBreakdown {
  const totalRoyalty = calculateRoyaltyAmount(saleInfo.salePrice, saleInfo.royaltyPct);

  // Fixed share percentages of the total royalty.
  const creatorPct = 5;
  const platformPct = 3;
  const curatorPct = 2;

  const creatorAmount = Math.floor((totalRoyalty * creatorPct) / 10); // 5/10 of totalRoyalty
  const platformAmount = Math.floor((totalRoyalty * platformPct) / 10);
  const curatorAmount = saleInfo.curatorAddress
    ? Math.floor((totalRoyalty * curatorPct) / 10)
    : 0;

  const allocated = creatorAmount + platformAmount + curatorAmount;
  const sellerNet = saleInfo.salePrice - allocated;

  return {
    creatorAmount,
    platformAmount,
    curatorAmount,
    sellerNet,
  };
}

/**
 * Send NVC tokens to a given address.
 * This is a placeholder – the real implementation lives in the blockchain
 * integration layer. Here we simply log the action for visibility.
 */
async function sendNVC(to: string, amount: number): Promise<void> {
  // In production this would interact with the NVC smart‑contract / wallet.
  console.log(`sendNVC: ${amount} tokens → ${to}`);
}

/**
 * Process a sale by calculating the royalty distribution and invoking `sendNVC`
 * for each beneficiary.
 *
 * @param saleInfo – details of the sale
 */
export async function processRoyaltyDistribution(saleInfo: SaleInfo): Promise<void> {
  const breakdown = determineRoyaltyRecipients(saleInfo);

  // Dispatch payments – sequentially to keep the example simple.
  await Promise.all([
    sendNVC(saleInfo.creatorAddress, breakdown.creatorAmount),
    sendNVC(saleInfo.platformAddress, breakdown.platformAmount),
    ...(saleInfo.curatorAddress ? [sendNVC(saleInfo.curatorAddress, breakdown.curatorAmount)] : []),
  ]);

  // Seller net amount is retained in the marketplace; logging for audit.
  console.log(`Seller ${saleInfo.sellerAddress} retains ${breakdown.sellerNet}`);
}

/** Exported API – three signatures as requested */
export const royaltyDistributionService = {
  calculateRoyaltyAmount,
  determineRoyaltyRecipients,
  processRoyaltyDistribution,
};
