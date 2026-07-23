import type { FastifyInstance, FastifyReply } from 'fastify';
import { domainToASCII } from 'node:url';
import { z } from 'zod/v4';
import { getDb } from '../../storage/database.js';
import { env } from '../../utils/config.js';
import { createId } from '../../utils/id.js';
import {
  getWebScrapingCapabilities,
  runWebScraping,
  WebScrapingError,
  type WebScrapingRequest,
} from '../../services/webScrapingService.js';

const FieldsSchema = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  z.string().min(1).max(512),
).refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 50, {
  message: 'fields must contain 1-50 CSS selectors',
});

const ScrapeRequestSchema = z.object({
  url: z.string().url().max(4_096),
  purpose: z.string().trim().min(3).max(500),
  authorizationConfirmed: z.literal(true),
  authorizationReference: z.string().trim().min(3).max(256),
  fields: FieldsSchema,
  engine: z.enum(['static', 'dynamic', 'stealth']).default('static'),
  allowedDomains: z.array(z.string().min(1).max(253)).max(50).default([]),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  maxItems: z.number().int().min(1).max(1_000).default(100),
  maxOutputChars: z.number().int().min(1_000).max(5_000_000).default(1_000_000),
  waitSelector: z.string().min(1).max(512).optional(),
  adaptive: z.boolean().default(false),
  autoSave: z.boolean().default(false),
  stealthAuthorization: z.boolean().default(false),
}).strict();

const AuthorizationSchema = z.object({
  reference: z.string().trim().min(3).max(256),
  allowedDomains: z.array(z.string().trim().min(1).max(253)).min(1).max(50),
  purpose: z.string().trim().min(3).max(500),
  approvedBy: z.string().trim().min(2).max(120),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const CLIENT_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_URL',
  'INVALID_SCOPE',
  'TARGET_NOT_PUBLIC',
  'TARGET_DNS_INVALID',
  'TARGET_DNS_FAILED',
  'TARGET_OUT_OF_SCOPE',
  'EXPLICIT_SCOPE_REQUIRED',
  'ROBOTS_DISALLOWED',
  'ROBOTS_UNAVAILABLE',
  'ROBOTS_DELAY_TOO_LONG',
]);
const FORBIDDEN_CODES = new Set([
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZATION_REFERENCE_REQUIRED',
  'AUTHORIZATION_NOT_FOUND',
  'AUTHORIZATION_SCOPE_MISMATCH',
  'STEALTH_AUTHORIZATION_REQUIRED',
  'STEALTH_DISABLED',
]);

function statusFor(error: WebScrapingError): number {
  if (CLIENT_ERROR_CODES.has(error.code)) return 400;
  if (FORBIDDEN_CODES.has(error.code)) return 403;
  if (['SCRAPLING_NOT_INSTALLED', 'PYTHON_UNAVAILABLE'].includes(error.code)) return 503;
  if (['FETCH_FAILED', 'UPSTREAM_HTTP_ERROR'].includes(error.code)) return 502;
  if (error.code === 'ADAPTER_BUSY') return 429;
  if (error.code === 'ADAPTER_TIMEOUT') return 504;
  return 500;
}

const PUBLIC_DETAIL_CODES = new Set([
  ...CLIENT_ERROR_CODES,
  ...FORBIDDEN_CODES,
  'AUTHORIZATION_NOT_FOUND',
  'AUTHORIZATION_SCOPE_MISMATCH',
]);

function publicErrorMessage(error: WebScrapingError): string {
  if (PUBLIC_DETAIL_CODES.has(error.code)) return error.message;
  if (error.code === 'ADAPTER_TIMEOUT') return 'web scraping request timed out';
  if (error.code === 'ADAPTER_BUSY') return 'web scraping worker capacity is currently full';
  if (['SCRAPLING_NOT_INSTALLED', 'PYTHON_UNAVAILABLE'].includes(error.code)) {
    return 'web scraping runtime is unavailable';
  }
  if (['FETCH_FAILED', 'UPSTREAM_HTTP_ERROR'].includes(error.code)) {
    return 'target fetch failed';
  }
  return 'web scraping adapter failed';
}

function sendScrapingError(reply: FastifyReply, error: WebScrapingError) {
  return reply.code(statusFor(error)).send({
    error: { code: error.code, message: publicErrorMessage(error) },
  });
}

function normalizeDomain(value: string): string | null {
  const candidate = value.trim().replace(/\.$/, '').toLowerCase();
  if (!candidate || candidate.includes('/') || candidate.includes('@') || candidate.includes(':')) return null;
  return domainToASCII(candidate) || null;
}

function hostWithin(host: string, scope: string): boolean {
  return host === scope || host.endsWith(`.${scope}`);
}

function assertStoredAuthorization(request: WebScrapingRequest): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT allowed_domain
    FROM web_scraping_authorizations
    WHERE reference=?
      AND status='active'
      AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
  `).all(request.authorizationReference) as Array<{ allowed_domain: string }>;
  if (rows.length === 0) {
    throw new WebScrapingError(
      'AUTHORIZATION_NOT_FOUND',
      'authorizationReference is not active or has expired',
    );
  }
  const approved = rows.map((row) => row.allowed_domain);
  const targetHost = normalizeDomain(new URL(request.url).hostname);
  if (!targetHost || !approved.some((domain) => hostWithin(targetHost, domain))) {
    throw new WebScrapingError(
      'AUTHORIZATION_SCOPE_MISMATCH',
      'target hostname is outside the stored authorization scope',
    );
  }
  for (const requested of request.allowedDomains ?? []) {
    const normalized = normalizeDomain(requested);
    if (!normalized || !approved.some((domain) => hostWithin(normalized, domain))) {
      throw new WebScrapingError(
        'AUTHORIZATION_SCOPE_MISMATCH',
        `allowed domain is outside the stored authorization scope: ${requested}`,
      );
    }
  }
}

function createStoredAuthorization(input: z.infer<typeof AuthorizationSchema>): {
  reference: string;
  allowedDomains: string[];
  expiresAt: string | null;
} {
  const normalized = input.allowedDomains.map((domain) => normalizeDomain(domain));
  if (normalized.some((domain) => !domain)) {
    throw new WebScrapingError('INVALID_REQUEST', 'allowedDomains contains an invalid domain');
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    throw new WebScrapingError('INVALID_REQUEST', 'expiresAt must be in the future');
  }
  const domains = [...new Set(normalized as string[])];
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO web_scraping_authorizations (
      id, reference, allowed_domain, purpose, approved_by, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(reference, allowed_domain) DO UPDATE SET
      purpose=excluded.purpose,
      approved_by=excluded.approved_by,
      expires_at=excluded.expires_at,
      status='active',
      updated_at=datetime('now')
  `);
  db.transaction(() => {
    for (const domain of domains) {
      insert.run(
        createId('wsauth'),
        input.reference,
        domain,
        input.purpose,
        input.approvedBy,
        input.expiresAt ?? null,
      );
    }
  })();
  return {
    reference: input.reference,
    allowedDomains: domains,
    expiresAt: input.expiresAt ?? null,
  };
}

export interface WebScrapingRouteDependencies {
  getCapabilities: typeof getWebScrapingCapabilities;
  scrape: typeof runWebScraping;
  authConfigured: () => boolean;
  assertAuthorization: (request: WebScrapingRequest) => void | Promise<void>;
  createAuthorization: (
    input: z.infer<typeof AuthorizationSchema>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

const defaultDependencies: WebScrapingRouteDependencies = {
  getCapabilities: getWebScrapingCapabilities,
  scrape: runWebScraping,
  authConfigured: () => Boolean(env.NCO_API_TOKEN),
  assertAuthorization: assertStoredAuthorization,
  createAuthorization: createStoredAuthorization,
};

export async function registerWebScrapingRoutes(
  app: FastifyInstance,
  dependencies: WebScrapingRouteDependencies = defaultDependencies,
): Promise<void> {
  app.get('/api/web-scraping/capabilities', async (_request, reply) => {
    try {
      return await dependencies.getCapabilities();
    } catch (error) {
      if (error instanceof WebScrapingError) {
        return sendScrapingError(reply, error);
      }
      throw error;
    }
  });

  app.post('/api/web-scraping/authorizations', async (request, reply) => {
    if (!dependencies.authConfigured()) {
      return reply.code(503).send({
        error: {
          code: 'AUTH_CONFIGURATION_REQUIRED',
          message: 'NCO API authentication must be configured before creating scraping authorizations',
        },
      });
    }
    const parsed = AuthorizationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: z.prettifyError(parsed.error) },
      });
    }
    try {
      const authorization = await dependencies.createAuthorization(parsed.data);
      return reply.code(201).send({ authorization });
    } catch (error) {
      if (error instanceof WebScrapingError) {
        return sendScrapingError(reply, error);
      }
      throw error;
    }
  });

  app.post('/api/web-scraping/extract', async (request, reply) => {
    if (!dependencies.authConfigured()) {
      return reply.code(503).send({
        error: {
          code: 'AUTH_CONFIGURATION_REQUIRED',
          message: 'NCO API authentication must be configured before web scraping',
        },
      });
    }
    const parsed = ScrapeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: z.prettifyError(parsed.error),
        },
      });
    }
    try {
      await dependencies.assertAuthorization(parsed.data as WebScrapingRequest);
      return await dependencies.scrape(parsed.data as WebScrapingRequest);
    } catch (error) {
      if (error instanceof WebScrapingError) {
        return sendScrapingError(reply, error);
      }
      throw error;
    }
  });
}
