import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildProviderCatalog,
  normalizeProviderDeclaration,
  type ProviderConfig,
  type ProviderDeclaration,
} from '../core/provider-catalog.js';

export type {
  ProviderConfig,
  ProviderDeclaration,
  ProviderModelConfig,
  ProviderRuntimeConfig,
  ProviderRoutingConfig,
} from '../core/provider-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// quiet: dotenv v17+ 배너를 stdout 으로 내보내므로 억제 — MCP stdio(JSON-RPC) 오염 방지
dotenvConfig({ path: resolve(ROOT, '.env'), quiet: true });

// ─── topology.json ────────────────────────────────────
interface Topology {
  ports: {
    apiGateway: number;
    websocket: number;
    dashboard: number;
    redis: number;
    ollama: number;
  };
  paths: {
    backend: string;
    dashboard: string;
    database: string;
    stateFile: string;
    workspace: string;
  };
}

export type JsonValidator<T> = (data: unknown) => T;

export function loadJSON<T>(filename: string, validator?: JsonValidator<T>): T {
  const filepath = resolve(ROOT, 'config', filename);
  if (!existsSync(filepath)) {
    throw new Error(`Config file not found: ${filepath}`);
  }
  const data: unknown = JSON.parse(readFileSync(filepath, 'utf-8'));
  return validator ? validator(data) : data as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateTopology(data: unknown): Topology {
  if (!isRecord(data) || !isRecord(data.ports) || !isRecord(data.paths)) {
    throw new Error('[config] topology.json must contain ports and paths objects');
  }

  for (const field of ['apiGateway', 'websocket', 'dashboard', 'redis', 'ollama']) {
    if (typeof data.ports[field] !== 'number') {
      throw new Error(`[config] topology.json ports.${field} must be a number`);
    }
  }
  for (const field of ['backend', 'dashboard', 'database', 'stateFile', 'workspace']) {
    if (typeof data.paths[field] !== 'string') {
      throw new Error(`[config] topology.json paths.${field} must be a string`);
    }
  }

  return data as unknown as Topology;
}

export const topology = loadJSON<Topology>('topology.json', validateTopology);

// ─── Provider Config ──────────────────────────────────
export interface ProvidersFile {
  version: number;
  updated: string;
  providers: ProviderConfig[];
}

export function validateProvidersFile(data: unknown): ProvidersFile {
  if (
    !isRecord(data) ||
    typeof data.version !== 'number' ||
    typeof data.updated !== 'string' ||
    !Array.isArray(data.providers)
  ) {
    throw new Error('[config] ai-providers.json must contain version, updated, and providers');
  }

  for (const [index, provider] of data.providers.entries()) {
    if (!isRecord(provider)) {
      throw new Error(`[config] ai-providers.json providers[${index}] must be an object`);
    }
    if (typeof provider.id !== 'string') {
      throw new Error(`[config] ai-providers.json providers[${index}].id must be a string`);
    }
  }

  // ProviderCatalog performs complete schema validation, duplicate detection,
  // deterministic defaults and unknown executor/adapter rejection in one place.
  return {
    version: data.version,
    updated: data.updated,
    providers: buildProviderCatalog(data.providers as ProviderDeclaration[]),
  };
}

/** 현재 플랫폼: darwin | wsl | linux (WSL은 /proc/version의 microsoft 마커로 판별) */
export function detectPlatform(): 'darwin' | 'wsl' | 'linux' {
  if (process.platform === 'darwin') return 'darwin';
  try {
    const v = readFileSync('/proc/version', 'utf-8').toLowerCase();
    if (v.includes('microsoft')) return 'wsl';
  } catch (err) {
    console.warn(`[config] /proc/version read failed, defaulting to linux: ${String(err)}`);
  }
  return 'linux';
}

function parsePort(envVar: 'PORT' | 'WS_PORT', fallback: number): number {
  const rawValue = process.env[envVar];
  const resolvedValue = rawValue ?? String(fallback);
  const port = Number(resolvedValue);

  if (!Number.isInteger(port) || Number.isNaN(port)) {
    throw new Error(`[config] ${envVar} must be an integer port, received: ${resolvedValue}`);
  }

  if (port < 1 || port > 65535) {
    throw new Error(`[config] ${envVar} must be between 1 and 65535, received: ${resolvedValue}`);
  }

  return port;
}

export interface LocalProviderConfig {
  /** PC-only providers that are not part of the shared catalog. */
  providers?: ProviderDeclaration[];
  /** Per-provider PC overrides (endpoint, model, enabled, etc.). */
  overrides?: Record<string, Partial<ProviderDeclaration>>;
  /** Optional allowlist; providers outside it stay visible but disabled. */
  allowedProviderIds?: string[];
  /** Explicit denylist applied after additions and overrides. */
  deniedProviderIds?: string[];
}

function stringIdSet(value: unknown, label: string): Set<string> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`[config] ${label} must be an array of non-empty provider ids`);
  }
  return new Set(value.map(item => item.trim()));
}

/** Apply a validated PC-local catalog overlay without mutating the shared snapshot. */
export function applyLocalProviderConfig(
  sharedProviders: readonly ProviderConfig[],
  local: LocalProviderConfig,
): ProviderConfig[] {
  if (!isRecord(local)) throw new Error('[config] local provider config must be an object');
  if (local.providers !== undefined && !Array.isArray(local.providers)) {
    throw new Error('[config] local providers must be an array');
  }
  if (local.overrides !== undefined && !isRecord(local.overrides)) {
    throw new Error('[config] local overrides must be an object');
  }

  const additions = buildProviderCatalog(local.providers ?? []);
  const ids = new Set(sharedProviders.map(provider => provider.id));
  for (const provider of additions) {
    if (ids.has(provider.id)) {
      throw new Error(`[config] duplicate local provider id: ${provider.id}; use overrides instead`);
    }
    ids.add(provider.id);
  }

  let providers = [...sharedProviders, ...additions];
  const overrides = local.overrides ?? {};
  const unknownOverrides = Object.keys(overrides).filter(id => !ids.has(id));
  if (unknownOverrides.length > 0) {
    throw new Error(
      `[config] local override references unregistered provider(s): ${unknownOverrides.join(', ')}`,
    );
  }
  providers = providers.map(provider => {
    const localOverride = overrides[provider.id];
    return localOverride
      ? normalizeProviderDeclaration({ ...provider, ...localOverride, id: provider.id })
      : provider;
  });

  const allowed = stringIdSet(local.allowedProviderIds, 'allowedProviderIds');
  const denied = stringIdSet(local.deniedProviderIds, 'deniedProviderIds') ?? new Set<string>();
  return providers.map(provider => normalizeProviderDeclaration({
    ...provider,
    enabled: provider.enabled
      && (allowed === null || allowed.has(provider.id))
      && !denied.has(provider.id),
  }));
}

/**
 * 머신별 오버레이 (config/ai-providers.local.json, git 비추적).
 * 2026-07-02 도입: 머신별 정책(enable/endpoint 등)이 공유 ai-providers.json에
 * 섞여 있어 원격들이 git pull 때마다 충돌/거부하던 문제의 구조적 해결.
 * 공유 파일 = 코드·중립 기본값(SSOT), 로컬 파일 = 이 머신의 정책.
 */
export function loadProviders(): ProviderConfig[] {
  let providers = loadJSON<ProvidersFile>('ai-providers.json', validateProvidersFile).providers;

  // 1) 로컬 오버레이 병합 (provider id 단위 shallow merge)
  const localPath = resolve(ROOT, 'config', 'ai-providers.local.json');
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, 'utf-8')) as LocalProviderConfig;
      providers = applyLocalProviderConfig(providers, local);
    } catch (err) {
      // A stale/invalid override can silently revive or mis-route a retired
      // provider, so provider-catalog violations are boot-fatal rather than a
      // permissive fallback to a different roster.
      throw new Error(`[config] ai-providers.local.json is invalid: ${String(err)}`);
    }
  }

  // 2) 플랫폼 필터: platforms 명시된 프로바이더는 현재 플랫폼일 때만 활성
  const plat = detectPlatform();
  providers = providers.map(p => {
    const platforms = (p as { platforms?: string[] }).platforms;
    const provider = platforms && !platforms.includes(plat) ? { ...p, enabled: false } : p;
    return normalizeProviderDeclaration({ ...provider, model: provider.model ?? null });
  });

  return providers;
}

/** WSL + Windows Ollama: OLLAMA_BASE_URL 우선, OLLAMA_HOST 폴백 (포트 중복 방지) */
function applyOllamaEnvOverride(providers: ProviderConfig[]): ProviderConfig[] {
  let base: string | null = null;
  const rawUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_BASE;
  if (rawUrl) {
    // strip trailing /v1 or / — base should end without path
    base = rawUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  } else if (process.env.OLLAMA_HOST) {
    const host = process.env.OLLAMA_HOST;
    // OLLAMA_HOST may already be a full URL with scheme (e.g. macOS-native
    // "http://localhost:11434") — prepending "http://" again produced a
    // malformed "http://http://..." base that failed DNS resolution on
    // every request, tripping the ollama circuit breaker permanently open
    // (2026-07-09 T1: curl exit 6 on the doubled-scheme URL).
    if (/^https?:\/\//.test(host)) {
      base = host.replace(/\/$/, '');
    } else {
      // bare host (WSL style, e.g. "172.28.112.1" or "172.28.112.1:11434")
      const hasPort = /:\d+$/.test(host);
      const port = process.env.OLLAMA_PORT || '11434';
      base = `http://${host}${hasPort ? '' : `:${port}`}`;
    }
  }
  if (!base) return providers;
  return providers.map((p) => {
    if (p.id !== 'ollama') return p;
    return {
      ...p,
      endpoint: `${base}/v1`,
      healthCheck: {
        ...p.healthCheck,
        url: `${base}/api/tags`,
      },
    };
  });
}

export function loadEnabledProviders(): ProviderConfig[] {
  return applyOllamaEnvOverride(loadProviders().filter(p => p.enabled));
}

export function getProvider(id: string): ProviderConfig | undefined {
  return loadProviders().find(p => p.id === id);
}

// ─── Environment ──────────────────────────────────────
export const env = {
  PORT: parsePort('PORT', topology.ports.apiGateway),
  WS_PORT: parsePort('WS_PORT', topology.ports.websocket),
  NODE_ENV: process.env.NODE_ENV || 'development',
  // lazy getter: 테스트가 beforeAll에서 process.env.DATABASE_PATH를 설정해도 반영되도록
  // import 시점 고정 대신 조회 시점 resolve (getDb()가 첫 호출 때 읽음)
  get DATABASE_PATH(): string {
    return resolve(ROOT, process.env.DATABASE_PATH || topology.paths.database);
  },
  REDIS_URL: process.env.REDIS_URL || `redis://127.0.0.1:${topology.ports.redis}`,
  STATE_FILE_PATH: resolve(ROOT, process.env.STATE_FILE_PATH || topology.paths.stateFile),
  DASHBOARD_URL: process.env.DASHBOARD_URL || `http://localhost:${topology.ports.dashboard}`,
  PROJECT_DIR: process.env.PROJECT_DIR || topology.paths.dashboard,
  NCO_API_TOKEN: process.env.NCO_API_TOKEN || '',
  HF_TOKEN: process.env.HF_TOKEN || '',
  OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH || '',
  ROOT,
} as const;

// ─── API Key Helpers ──────────────────────────────────
export function getApiKeys(envVar: string, delimiter = ','): string[] {
  const raw = process.env[envVar] || '';
  return raw.split(delimiter).map(k => k.trim()).filter(Boolean);
}
