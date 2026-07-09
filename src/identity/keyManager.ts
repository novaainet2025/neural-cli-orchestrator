/**
 * Nova Government — Key Manager
 * Ed25519 키페어 생성 + DID 발급
 * Phase 1: Identity Infrastructure
 */

import { webcrypto } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';

export type DID = `did:nova:${string}`;

export interface KeyPair {
  publicKey: string;   // base64url Ed25519
  privateKey: string;  // base64url Ed25519 (keep secret)
}

export interface DIDDocument {
  did: DID;
  publicKey: string;
  createdAt: number;
}

/**
 * Ed25519 키페어 생성 (Web Crypto API)
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  ) as unknown as CryptoKeyPair;

  const pubRaw = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
  const privRaw = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKey: Buffer.from(pubRaw).toString('base64url'),
    privateKey: Buffer.from(privRaw).toString('base64url'),
  };
}

/**
 * 공개키로부터 DID 생성
 * did:nova:<sha256(publicKey)[:16]>
 */
export function deriveDidFromPublicKey(publicKey: string): DID {
  const hash = createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .slice(0, 32);
  return `did:nova:${hash}`;
}

/**
 * 랜덤 DID 생성 (키페어 없이 등록 시)
 */
export function generateRandomDid(): DID {
  const rand = randomBytes(16).toString('hex');
  return `did:nova:${rand}`;
}

/**
 * Ed25519로 메시지 서명
 */
export async function signMessage(
  privateKeyBase64url: string,
  message: string
): Promise<string> {
  const privRaw = Buffer.from(privateKeyBase64url, 'base64url');
  const cryptoKey = await webcrypto.subtle.importKey(
    'pkcs8',
    privRaw,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
  const sig = await webcrypto.subtle.sign(
    'Ed25519',
    cryptoKey,
    Buffer.from(message)
  );
  return Buffer.from(sig).toString('base64url');
}

/**
 * Ed25519 서명 검증
 */
export async function verifySignature(
  publicKeyBase64url: string,
  message: string,
  signatureBase64url: string
): Promise<boolean> {
  try {
    const pubRaw = Buffer.from(publicKeyBase64url, 'base64url');
    const cryptoKey = await webcrypto.subtle.importKey(
      'raw',
      pubRaw,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return await webcrypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      Buffer.from(signatureBase64url, 'base64url'),
      Buffer.from(message)
    );
  } catch {
    return false;
  }
}

/**
 * DID 형식 검증
 */
export function isValidDid(did: string): did is DID {
  // W3C DID: did:nova:<method-specific-id>
  // Allows: hex hashes, official-* government agents, any alphanumeric+hyphen+underscore id
  const didPattern = /^did:nova:[a-zA-Z0-9_\-]{1,128}$/;
  return didPattern.test(did);
}
