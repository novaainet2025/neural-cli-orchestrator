import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
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
  'STEALTH_AUTHORIZATION_REQUIRED',
  'STEALTH_DISABLED',
]);

function statusFor(error: WebScrapingError): number {
  if (CLIENT_ERROR_CODES.has(error.code)) return 400;
  if (FORBIDDEN_CODES.has(error.code)) return 403;
  if (['SCRAPLING_NOT_INSTALLED', 'PYTHON_UNAVAILABLE'].includes(error.code)) return 503;
  if (['FETCH_FAILED', 'UPSTREAM_HTTP_ERROR'].includes(error.code)) return 502;
  if (error.code === 'ADAPTER_TIMEOUT') return 504;
  return 500;
}

export async function registerWebScrapingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/web-scraping/capabilities', async (_request, reply) => {
    try {
      return await getWebScrapingCapabilities();
    } catch (error) {
      if (error instanceof WebScrapingError) {
        return reply.code(statusFor(error)).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/api/web-scraping/extract', async (request, reply) => {
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
      return await runWebScraping(parsed.data as WebScrapingRequest);
    } catch (error) {
      if (error instanceof WebScrapingError) {
        return reply.code(statusFor(error)).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
}

