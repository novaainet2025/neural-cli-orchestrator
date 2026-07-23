import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';
import { getWebScrapingCapabilities } from '../../../src/services/webScrapingService.js';
import {
  registerWebScrapingRoutes,
  type WebScrapingRouteDependencies,
} from '../../../src/server/routes/web-scraping.js';

interface LatencySummary {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function summarize(latencies: number[]): LatencySummary {
  const sorted = [...latencies].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    meanMs: round(total / sorted.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function print(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const repetitions = positiveInteger('BENCH_REPETITIONS', 5);
const iterations = positiveInteger('BENCH_ITERATIONS', 500);
let unexpectedOutcomes = 0;

for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  let sampleUnexpectedOutcomes = 0;
  let adapterInvocations = 0;
  const dependencies: WebScrapingRouteDependencies = {
    getCapabilities: async () => ({ ok: true, scrapling: { version: '0.4.11' } }),
    authConfigured: () => true,
    assertAuthorization: async () => undefined,
    createAuthorization: async (input) => ({
      reference: input.reference,
      allowedDomains: input.allowedDomains,
    }),
    scrape: async () => {
      adapterInvocations += 1;
      return {
        ok: true,
        data: { title: ['Example Domain'] },
        meta: { contentTrust: 'untrusted_external' },
      };
    },
  };
  const app = Fastify({ logger: false });
  await registerWebScrapingRoutes(app, dependencies);
  await app.ready();

  if (repetition > 1) {
    for (let warmup = 0; warmup < 25; warmup += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/web-scraping/extract',
        payload: {
          url: 'https://example.com',
          purpose: 'deterministic baseline benchmark',
          authorizationConfirmed: true,
          authorizationReference: 'BENCH-AUTH-001',
          fields: { title: 'h1::text' },
        },
      });
    }
    adapterInvocations = 0;
  }

  const latencies: number[] = [];
  const startCpu = process.cpuUsage();
  const startRss = process.memoryUsage().rss;
  const startedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let requestStartedAt = performance.now();
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'deterministic baseline benchmark',
        authorizationConfirmed: true,
        authorizationReference: 'BENCH-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });
    latencies.push(performance.now() - requestStartedAt);
    if (
      allowed.statusCode !== 200
      || allowed.json().meta?.contentTrust !== 'untrusted_external'
    ) {
      sampleUnexpectedOutcomes += 1;
    }

    requestStartedAt = performance.now();
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'deterministic baseline benchmark',
        authorizationConfirmed: false,
        authorizationReference: 'BENCH-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });
    latencies.push(performance.now() - requestStartedAt);
    if (blocked.statusCode !== 400) sampleUnexpectedOutcomes += 1;
  }

  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(startCpu);
  const requestCount = iterations * 2;
  if (adapterInvocations !== iterations) sampleUnexpectedOutcomes += 1;
  unexpectedOutcomes += sampleUnexpectedOutcomes;

  print({
    scenario: 'fastify-route-contract',
    repetition,
    sample: repetition === 1 ? 'cold' : 'warm',
    iterations,
    requestCount,
    expectedAllowed: iterations,
    expectedBlocked: iterations,
    adapterInvocations,
    unexpectedOutcomes: sampleUnexpectedOutcomes,
    successRatePct: round(((requestCount - sampleUnexpectedOutcomes) / requestCount) * 100),
    errorRatePct: round((sampleUnexpectedOutcomes / requestCount) * 100),
    wallMs: round(wallMs),
    throughputRequestsPerSecond: round(requestCount / (wallMs / 1_000)),
    latency: summarize(latencies),
    cpuUserMs: round(cpu.user / 1_000),
    cpuSystemMs: round(cpu.system / 1_000),
    rssStartBytes: startRss,
    rssEndBytes: process.memoryUsage().rss,
    processMaxRssRaw: process.resourceUsage().maxRSS,
  });

  await app.close();
}

for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  const startCpu = process.cpuUsage();
  const startRss = process.memoryUsage().rss;
  const startedAt = performance.now();
  let success = false;
  let observedVersion: unknown;
  try {
    const capabilities = await getWebScrapingCapabilities();
    observedVersion = (capabilities.scrapling as { version?: unknown } | undefined)?.version;
    success = capabilities.ok === true && observedVersion === '0.4.11';
  } catch {
    success = false;
  }
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(startCpu);
  if (!success) unexpectedOutcomes += 1;
  print({
    scenario: 'node-python-capabilities',
    repetition,
    sample: repetition === 1 ? 'cold' : 'warm',
    requestCount: 1,
    success,
    observedVersion,
    successRatePct: success ? 100 : 0,
    errorRatePct: success ? 0 : 100,
    wallMs: round(wallMs),
    throughputRequestsPerSecond: round(1 / (wallMs / 1_000)),
    cpuUserMs: round(cpu.user / 1_000),
    cpuSystemMs: round(cpu.system / 1_000),
    rssStartBytes: startRss,
    rssEndBytes: process.memoryUsage().rss,
    processMaxRssRaw: process.resourceUsage().maxRSS,
  });
}

if (unexpectedOutcomes > 0) {
  process.exitCode = 1;
}
