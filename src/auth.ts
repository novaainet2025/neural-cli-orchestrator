import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface JwtPayload {
  sub?: string;
  role?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

export interface AuthConfig {
  apiToken?: string;
  jwtSecret?: string;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(padLength)}`, 'base64').toString('utf8');
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(JSON.stringify(value));
}

function signSegment(input: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function safeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export function createJwt(payload: JwtPayload, secret: string, expiresInSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(body);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signSegment(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  let header: { alg?: string; typ?: string } | null = null;
  let payload: JwtPayload | null = null;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as JwtPayload;
  } catch {
    return null;
  }

  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || !payload) {
    return null;
  }

  const expectedSignature = signSegment(`${encodedHeader}.${encodedPayload}`, secret);
  if (!safeCompare(signature, expectedSignature)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    return null;
  }

  return payload;
}

function normalizeBearerToken(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.startsWith('Bearer ') ? value.slice(7).trim() : value.trim();
}

export function isRequestAuthorized(
  headers: Record<string, unknown>,
  config: AuthConfig,
): boolean {
  const rawToken = headers['x-api-token'] ?? headers.authorization;
  const providedToken = normalizeBearerToken(
    Array.isArray(rawToken) ? rawToken[0] : (rawToken as string | undefined),
  );

  if (!providedToken) return false;

  if (config.jwtSecret) {
    const payload = verifyJwt(providedToken, config.jwtSecret);
    if (payload) return true;
  }

  if (!config.apiToken) return false;
  return safeCompare(providedToken, config.apiToken);
}

export function shouldAuthenticate(method: string): boolean {
  return ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase());
}

export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AuthConfig,
): Promise<void> {
  const authEnabled = Boolean(config.jwtSecret || config.apiToken);
  if (!authEnabled || !shouldAuthenticate(request.method)) return;

  if (!isRequestAuthorized(request.headers as Record<string, unknown>, config)) {
    return reply.code(401).send({ error: 'Unauthorized: Invalid token' });
  }
}
