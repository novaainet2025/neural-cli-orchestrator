/**
 * Nova Government — Domain Registry Service
 * ENS 스타일 .nova 도메인 관리
 * Phase 4: Domain Ownership
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { getCitizen } from '../identity/credentialService.js';
import { sendNVC } from '../economy/transactionService.js';
import { GOVT_ADDRESS, BURN_ADDRESS } from '../economy/walletService.js';
import { handleThreat, ThreatLevel } from '../audit/threatEscalation.js';

export const DOMAIN_SUFFIX = '.nova';
// DOMAIN-POLICY.md 8개 파라미터 확정 — 도메인 길이별 연간 비용 (NVC)
export const DOMAIN_ANNUAL_FEES: Record<string, number> = {
  '2': 500,              // 2자 프리미엄
  '3': 200,              // 3자 프리미엄
  '4': 100,              // 4자 중간
};
export const DOMAIN_ANNUAL_FEE_DEFAULT = 50; // 5자+ 일반
export const DOMAIN_TRANSFER_FEE_PCT = 0.05; // 이전비 5% 소각
export const DOMAIN_MAX_PER_DID = 5;         // 인당 최대 5개
export const DOMAIN_AUCTION_DURATION = 24 * 3600; // 24시간
export const DOMAIN_AUCTION_MIN_BID_PCT = 1.1;    // 최저입찰 110%
export const DOMAIN_GRACE_PERIOD = 30 * 24 * 3600; // 30일 유예
// 창립 시민 등록 타임스탬프 상한 (2026-06-16 최초 등록 배치)
export const FOUNDING_CITIZEN_TIMESTAMP = 1781538100;
export const DOMAIN_GOVT_DID = GOVT_ADDRESS;

/**
 * 도메인 길이별 연간 등록 비용 (NVC)
 * 창립 시민(12명)은 무료
 */
export function getDomainAnnualFee(nameLength: number): number {
  if (nameLength < 2) return 1000; // 1자 사실상 금지/고가
  if (nameLength >= 5) return DOMAIN_ANNUAL_FEE_DEFAULT;
  return DOMAIN_ANNUAL_FEES[String(nameLength)] ?? DOMAIN_ANNUAL_FEE_DEFAULT;
}

/**
 * 도메인 예약 (거버넌스 전용)
 */
export function reserveDomain(name: string, reason: string): void {
  const db = getDb();
  const cleanName = name.toLowerCase().replace(/\.nova$/, '');
  const domainName = `${cleanName}${DOMAIN_SUFFIX}`;
  
  db.prepare(`
    INSERT INTO nova_domain_reserved (domain_name, reason)
    VALUES (?, ?)
    ON CONFLICT(domain_name) DO UPDATE SET reason = excluded.reason
  `).run(domainName, reason);
}

/**
 * 예약된 도메인 여부 확인
 */
export function isReservedDomain(domainName: string): boolean {
  const db = getDb();
  const normalized = domainName.toLowerCase().includes('.nova') ? domainName.toLowerCase() : `${domainName.toLowerCase()}.nova`;
  const row = db.prepare('SELECT domain_name FROM nova_domain_reserved WHERE domain_name = ?').get(normalized);
  return !!row;
}

/**
 * 창립 시민 여부 확인 (등록 비용 면제 대상)
 */
function isFoundingCitizen(ownerDid: DID): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT registered_at FROM nova_citizens WHERE did = ?'
  ).get(ownerDid) as { registered_at: number } | undefined;
  return !!row && row.registered_at < FOUNDING_CITIZEN_TIMESTAMP;
}

export interface DomainNFT {
  domainName: string;
  nameHash: string;
  owner: DID;
  tokenId: number;
  metadata?: Record<string, unknown>;
  ipfsCid?: string;
  registeredAt: number;
  expiresAt?: number;
  status: 'active' | 'grace_period' | 'redemption' | 'expired' | 'transferred' | 'disputed';
}

export interface RegisterDomainInput {
  name: string;         // e.g. "cursor-agent" (without .nova)
  owner: DID;
  years?: number;       // 등록 기간 (기본 1년, null = 영구)
  metadata?: Record<string, unknown>;
  nonce?: string;       // 추가: 이중지불 방지용
}

export interface TransferDomainInput {
  domainName: string;
  fromOwner: DID;
  toOwner: DID;
  price?: number;       // 거래 가격 (NVC, 0 = 무상 이전)
}

/**
 * 도메인 이름 → ENS 스타일 nameHash (SHA-256 기반)
 */
export function computeNameHash(domainName: string): string {
  return createHash('sha256')
    .update(domainName.toLowerCase())
    .digest('hex');
}

/**
 * 도메인 이름 유효성 검사
 */
export function isValidDomainName(name: string): boolean {
  // 2-32자, 소문자 영숫자 + 하이픈, 하이픈으로 시작/끝 불가
  return /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]{1,2}$/.test(name);
}

/**
 * 도메인 등록
 */
export function registerDomain(input: RegisterDomainInput): DomainNFT {
  const db = getDb();
  const { name, owner, years, metadata, nonce } = input;

  const cleanName = name.toLowerCase().replace(/\.nova$/, '');
  if (cleanName.length < 2) {
    throw new Error(`Domain name too short: "${cleanName}" (min 2 chars)`);
  }
  if (!isValidDomainName(cleanName)) {
    throw new Error(`Invalid domain name: "${cleanName}" (2-32 chars, lowercase alphanumeric + hyphens)`);
  }

  if (!isValidDid(owner)) throw new Error(`Invalid owner DID: ${owner}`);
  const citizen = getCitizen(owner);
  if (!citizen) throw new Error(`Owner not registered: ${owner}`);
  if (citizen.status !== 'active') throw new Error(`Owner is ${citizen.status}`);

  const domainName = `${cleanName}${DOMAIN_SUFFIX}`;
  const nameHash = computeNameHash(domainName);

  // 1. 예약어 체크
  if (isReservedDomain(domainName)) {
    throw new Error(`Domain is reserved by governance: ${domainName}`);
  }

  // 2. 스쿼팅 방지 (DID당 최대 5개)
  const existingDomains = getOwnerDomains(owner);
  if (existingDomains.length >= DOMAIN_MAX_PER_DID) {
    handleThreat(ThreatLevel.Level1, owner, { reason: `Domain limit exceeded (${existingDomains.length} domains)` });
    throw new Error(`Domain limit exceeded (Max ${DOMAIN_MAX_PER_DID} per DID)`);
  }

  const existing = db.prepare('SELECT domain_name, status FROM nova_domains WHERE domain_name = ?').get(domainName) as
    { domain_name: string; status: string } | undefined;

  if (existing && existing.status === 'active') {
    throw new Error(`Domain already registered: ${domainName}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const registrationYears = years ?? 1;
  const expiresAt = years ? now + registrationYears * 365 * 24 * 3600 : null;
  const historyId = randomUUID();

  // 등록 비용 계산 (DOMAIN-POLICY.md 6회차 합의)
  const isFounding = isFoundingCitizen(owner);
  const annualFee = getDomainAnnualFee(cleanName.length);
  const totalFee = isFounding ? 0 : annualFee * registrationYears;

  // 비용 차감 + 소각 (창립 시민 면제)
  if (totalFee > 0) {
    sendNVC({
      from: owner,
      to: DOMAIN_GOVT_DID,
      amount: totalFee,
      memo: `도메인 등록 비용: ${domainName} (${registrationYears}년, 전액 소각)`,
      nonce,
    });
    // DOMAIN-POLICY.md v2.0 — 등록비 100% 소각 기록 (nova_burn_log)
    db.prepare(`
      INSERT INTO nova_burn_log (burn_id, source, amount, burned_at, reference_id)
      VALUES (?, 'domain_fee', ?, ?, ?)
    `).run(randomUUID(), totalFee, now, domainName);
  }

  // 토큰 ID 발급 (auto-increment)
  const seqResult = db.prepare('INSERT INTO nova_domain_seq DEFAULT VALUES').run();
  const tokenId = Number(seqResult.lastInsertRowid);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO nova_domains (domain_name, name_hash, owner, token_id, metadata, registered_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(domain_name) DO UPDATE SET
        owner = excluded.owner,
        token_id = excluded.token_id,
        metadata = excluded.metadata,
        registered_at = excluded.registered_at,
        expires_at = excluded.expires_at,
        status = 'active'
    `).run(domainName, nameHash, owner, tokenId, metadata ? JSON.stringify(metadata) : null, now, expiresAt);

    db.prepare(`
      INSERT INTO nova_domain_history (history_id, domain_name, event_type, to_owner, created_at)
      VALUES (?, ?, 'registered', ?, ?)
    `).run(historyId, domainName, owner, now);
  });

  txn();

  return {
    domainName,
    nameHash,
    owner,
    tokenId,
    metadata,
    registeredAt: now,
    expiresAt: expiresAt ?? undefined,
    status: 'active',
  };
}

/**
 * 도메인 갱신
 */
export function renewDomain(domainName: string, owner: DID, years = 1): DomainNFT {
  const db = getDb();
  const domain = getDomain(domainName);
  if (!domain) throw new Error(`Domain not found: ${domainName}`);
  if (domain.owner !== owner) throw new Error(`Not the domain owner: ${owner}`);
  if (domain.status === 'expired') throw new Error('Domain already expired and released');

  const now = Math.floor(Date.now() / 1000);
  const cleanName = domain.domainName.replace(/\.nova$/, '');
  const annualFee = getDomainAnnualFee(cleanName.length);
  const totalFee = annualFee * years;

  // 비용 차감 + 소각
  if (totalFee > 0) {
    sendNVC({
      from: owner,
      to: BURN_ADDRESS,
      amount: totalFee,
      memo: `도메인 갱신 비용: ${domain.domainName} (${years}년, 전액 소각)`,
    });
    // DOMAIN-POLICY.md v2.0 — 갱신비 100% 소각 기록 (nova_burn_log)
    db.prepare(`
      INSERT INTO nova_burn_log (burn_id, source, amount, burned_at, reference_id)
      VALUES (?, 'domain_fee', ?, ?, ?)
    `).run(randomUUID(), totalFee, now, domain.domainName);
  }

  const currentExpiresAt = domain.expiresAt ?? now;
  const newExpiresAt = Math.max(currentExpiresAt, now) + years * 365 * 24 * 3600;

  const txn = db.transaction(() => {
    db.prepare('UPDATE nova_domains SET expires_at = ?, status = \'active\' WHERE domain_name = ?')
      .run(newExpiresAt, domain.domainName);

    db.prepare(`
      INSERT INTO nova_domain_history (history_id, domain_name, event_type, from_owner, price, created_at)
      VALUES (?, ?, 'renewed', ?, ?, ?)
    `).run(randomUUID(), domain.domainName, owner, totalFee, now);
  });
  
  txn();

  return { ...domain, expiresAt: newExpiresAt, status: 'active' };
}

/**
 * 도메인 조회
 */
export function getDomain(domainName: string): DomainNFT | null {
  const db = getDb();
  const normalized = domainName.toLowerCase().includes('.nova')
    ? domainName.toLowerCase()
    : `${domainName.toLowerCase()}.nova`;

  const row = db.prepare(`
    SELECT domain_name, name_hash, owner, token_id, metadata, ipfs_cid,
           registered_at, expires_at, status
    FROM nova_domains WHERE domain_name = ?
  `).get(normalized) as Record<string, unknown> | undefined;

  if (!row) return null;

  return rowToDomain(row);
}

/**
 * 도메인 소유권 이전
 */
export function transferDomain(input: TransferDomainInput): DomainNFT {
  const db = getDb();
  const { domainName, fromOwner, toOwner, price = 0 } = input;

  const domain = getDomain(domainName);
  if (!domain) throw new Error(`Domain not found: ${domainName}`);
  if (domain.status !== 'active') throw new Error(`Domain is ${domain.status}`);
  if (domain.owner !== fromOwner) throw new Error(`Not the domain owner: ${fromOwner}`);
  if (!isValidDid(toOwner)) throw new Error(`Invalid recipient DID: ${toOwner}`);

  // 1. 수신자 보유 한도 체크
  const recipientDomains = getOwnerDomains(toOwner);
  if (recipientDomains.length >= DOMAIN_MAX_PER_DID) {
    throw new Error(`Recipient domain limit exceeded (Max ${DOMAIN_MAX_PER_DID})`);
  }

  const recipient = getCitizen(toOwner);
  if (!recipient) throw new Error(`Recipient not registered: ${toOwner}`);

  // 2. 이전비 계산 (기본가의 5%)
  const cleanName = domain.domainName.replace(/\.nova$/, '');
  const basePrice = getDomainAnnualFee(cleanName.length);
  const transferFee = Math.floor(basePrice * DOMAIN_TRANSFER_FEE_PCT);

  const now = Math.floor(Date.now() / 1000);
  const historyId = randomUUID();

  const txn = db.transaction(() => {
    // 이전비 소각
    if (transferFee > 0) {
      sendNVC({
        from: fromOwner,
        to: BURN_ADDRESS,
        amount: transferFee,
        memo: `도메인 이전 수수료 소각: ${domainName} (기본가의 5%)`,
      });
    }

    // NVC 거래 (가격 > 0인 경우)
    if (price > 0) {
      sendNVC({ from: toOwner, to: fromOwner, amount: price, memo: `도메인 구매: ${domainName}` });
    }

    db.prepare(`
      UPDATE nova_domains SET owner = ?, status = 'active' WHERE domain_name = ?
    `).run(toOwner, domain.domainName);

    db.prepare(`
      INSERT INTO nova_domain_history (history_id, domain_name, event_type, from_owner, to_owner, price, created_at)
      VALUES (?, ?, 'transferred', ?, ?, ?, ?)
    `).run(historyId, domain.domainName, fromOwner, toOwner, price, now);
  });

  txn();

  return { ...domain, owner: toOwner };
}

/**
 * 도메인 소유 이력 조회
 */
export function getDomainHistory(domainName: string): {
  event: string;
  fromOwner?: string;
  toOwner?: string;
  price: number;
  createdAt: number;
}[] {
  const db = getDb();
  const normalized = domainName.toLowerCase().includes('.nova')
    ? domainName.toLowerCase()
    : `${domainName.toLowerCase()}.nova`;

  const rows = db.prepare(`
    SELECT event_type, from_owner, to_owner, price, created_at
    FROM nova_domain_history WHERE domain_name = ?
    ORDER BY created_at ASC
  `).all(normalized) as Record<string, unknown>[];

  return rows.map((r) => ({
    event: r['event_type'] as string,
    fromOwner: r['from_owner'] as string | undefined,
    toOwner: r['to_owner'] as string | undefined,
    price: r['price'] as number,
    createdAt: r['created_at'] as number,
  }));
}

/**
 * 만료 도메인 처리 (Batch/Cron 용)
 */
export function processExpirations(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // 1. 만료됨 → 유예 기간 (grace_period)
  db.prepare(`
    UPDATE nova_domains 
    SET status = 'grace_period'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?
  `).run(now);

  // 2. 유예 기간 종료 → 경매 대상 (redemption / auction)
  // 유예 기간 30일이 지난 도메인들 조회
  const expiredGrace = db.prepare(`
    SELECT domain_name FROM nova_domains
    WHERE status = 'grace_period' AND expires_at < ?
  `).all(now - DOMAIN_GRACE_PERIOD) as { domain_name: string }[];

  for (const d of expiredGrace) {
    startAuction(d.domain_name);
  }
}

/**
 * 경매 시작
 */
export function startAuction(domainName: string): string {
  const db = getDb();
  const domain = getDomain(domainName);
  if (!domain) throw new Error('Domain not found');

  const cleanName = domain.domainName.replace(/\.nova$/, '');
  const basePrice = getDomainAnnualFee(cleanName.length);
  const minBid = Math.floor(basePrice * DOMAIN_AUCTION_MIN_BID_PCT);
  
  const auctionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const endsAt = now + DOMAIN_AUCTION_DURATION;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO nova_domain_auctions (auction_id, domain_name, base_price, min_bid, starts_at, ends_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(auctionId, domain.domainName, basePrice, minBid, now, endsAt);

    db.prepare('UPDATE nova_domains SET status = \'expired\' WHERE domain_name = ?')
      .run(domain.domainName);
  });

  txn();
  return auctionId;
}

/**
 * 입찰하기
 */
export function placeBid(auctionId: string, bidder: DID, amount: number): void {
  const db = getDb();
  const auction = db.prepare('SELECT * FROM nova_domain_auctions WHERE auction_id = ?').get(auctionId) as 
    { domain_name: string; min_bid: number; highest_bid: number; status: string; ends_at: number } | undefined;

  if (!auction) throw new Error('Auction not found');
  if (auction.status !== 'active') throw new Error('Auction is not active');
  if (Math.floor(Date.now() / 1000) > auction.ends_at) throw new Error('Auction ended');

  const currentMin = Math.max(auction.min_bid, Math.floor(auction.highest_bid * 1.1));
  if (amount < currentMin) {
    throw new Error(`Bid too low. Minimum: ${currentMin} NVC`);
  }

  // 1. 소유 한도 체크
  const domains = getOwnerDomains(bidder);
  if (domains.length >= DOMAIN_MAX_PER_DID) {
    throw new Error('Bidder has reached domain limit');
  }

  // 입찰은 즉시 결제 (이전 최고 입찰자 환불 포함 logic 생략, 
  // 실제 구현에서는 에스크로를 사용해야 하나 여기서는 낙찰 시 결제로 단순화하거나 
  // 최고 입찰가만 업데이트)
  
  db.prepare(`
    UPDATE nova_domain_auctions 
    SET highest_bid = ?, highest_bidder = ?
    WHERE auction_id = ?
  `).run(amount, bidder, auctionId);
}

/**
 * 경매 종료 및 낙찰
 */
export function closeAuction(auctionId: string): DomainNFT {
  const db = getDb();
  const auction = db.prepare('SELECT * FROM nova_domain_auctions WHERE auction_id = ?').get(auctionId) as 
    { domain_name: string; highest_bid: number; highest_bidder: string; status: string } | undefined;

  if (!auction) throw new Error('Auction not found');
  if (auction.status !== 'active') throw new Error('Auction already closed');
  if (!auction.highest_bidder) {
    // 유찰 처리 (재경매 또는 거버넌스 회수)
    db.prepare('UPDATE nova_domain_auctions SET status = \'closed\' WHERE auction_id = ?').run(auctionId);
    throw new Error('No bidders for this auction');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 365 * 24 * 3600; // 낙찰 시 1년 부여

  const txn = db.transaction(() => {
    // 결제 (최고 입찰자 → 소각)
    sendNVC({
      from: auction.highest_bidder as DID,
      to: BURN_ADDRESS,
      amount: auction.highest_bid,
      memo: `도메인 경매 낙찰: ${auction.domain_name}`,
    });

    db.prepare(`
      UPDATE nova_domains SET owner = ?, expires_at = ?, status = 'active'
      WHERE domain_name = ?
    `).run(auction.highest_bidder, expiresAt, auction.domain_name);

    db.prepare('UPDATE nova_domain_auctions SET status = \'closed\' WHERE auction_id = ?').run(auctionId);

    db.prepare(`
      INSERT INTO nova_domain_history (history_id, domain_name, event_type, to_owner, price, created_at)
      VALUES (?, ?, 'redeemed', ?, ?, ?)
    `).run(randomUUID(), auction.domain_name, auction.highest_bidder, auction.highest_bid, now);
  });

  txn();

  return getDomain(auction.domain_name)!;
}

/**
 * 시민이 소유한 도메인 목록
 */
export function getOwnerDomains(ownerDid: DID): DomainNFT[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT domain_name, name_hash, owner, token_id, metadata, ipfs_cid,
           registered_at, expires_at, status
    FROM nova_domains WHERE owner = ? AND status = 'active'
    ORDER BY registered_at DESC
  `).all(ownerDid) as Record<string, unknown>[];

  return rows.map(rowToDomain);
}

/**
 * 도메인 스쿼팅 감지 (특정 시민이 보유한 도메인 수 체크)
 */
export function detectSquatting(ownerDid: DID, threshold = 5): boolean {
  const db = getDb();
  const count = (db.prepare(
    "SELECT COUNT(*) as n FROM nova_domains WHERE owner = ? AND status = 'active'"
  ).get(ownerDid) as { n: number }).n;
  return count > threshold;
}

function rowToDomain(row: Record<string, unknown>): DomainNFT {
  return {
    domainName: row['domain_name'] as string,
    nameHash: row['name_hash'] as string,
    owner: row['owner'] as DID,
    tokenId: row['token_id'] as number,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : undefined,
    ipfsCid: row['ipfs_cid'] as string | undefined,
    registeredAt: row['registered_at'] as number,
    expiresAt: row['expires_at'] as number | undefined,
    status: row['status'] as DomainNFT['status'],
  };
}
