import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

dotenvConfig({ path: resolve(ROOT, '.env') });

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

function loadJSON<T>(filename: string): T {
  const filepath = resolve(ROOT, 'config', filename);
  if (!existsSync(filepath)) {
    throw new Error(`Config file not found: ${filepath}`);
  }
  return JSON.parse(readFileSync(filepath, 'utf-8')) as T;
}

export const topology = loadJSON<Topology>('topology.json');

// ─── Provider Config ──────────────────────────────────
export interface ProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: 'cli' | 'api' | 'local';
  role: string;
  score: number;
  model: string | null;
  command: string | null;
  args: string[];
  endpoint?: string;
  apiKeyRef?: string;
  keyRotation?: {
    enabled: boolean;
    envVar: string;
    delimiter: string;
    maxKeys: number;
    cooldownMs: number;
  };
  freeModels?: string[];
  apiConfig?: {
    primary: { provider: string; baseUrl: string; apiKeyRef: string; model: string };
    fallback: { provider: string; baseUrl: string; apiKeyRef: string | null; model: string };
  };
  env: Record<string, string>;
  concurrency: number;
  rateLimitRpm: number;
  cost: 'free' | 'paid';
  capabilities: string[];
  permissions: Record<string, boolean>;
  persona: { systemPrompt: string; tone: string; style: string };
  healthCheck: Record<string, unknown>;
  note?: string;
}

interface ProvidersFile {
  version: number;
  updated: string;
  providers: ProviderConfig[];
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

interface LocalOverrides {
  overrides?: Record<string, Partial<ProviderConfig>>;
}

/**
 * 머신별 오버레이 (config/ai-providers.local.json, git 비추적).
 * 2026-07-02 도입: 머신별 정책(enable/endpoint 등)이 공유 ai-providers.json에
 * 섞여 있어 원격들이 git pull 때마다 충돌/거부하던 문제의 구조적 해결.
 * 공유 파일 = 코드·중립 기본값(SSOT), 로컬 파일 = 이 머신의 정책.
 */
export function loadProviders(): ProviderConfig[] {
  let providers = loadJSON<ProvidersFile>('ai-providers.json').providers;

  // 1) 로컬 오버레이 병합 (provider id 단위 shallow merge)
  const localPath = resolve(ROOT, 'config', 'ai-providers.local.json');
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, 'utf-8')) as LocalOverrides;
      const ov = local.overrides ?? {};
      providers = providers.map(p => (ov[p.id] ? { ...p, ...ov[p.id], id: p.id } : p));
    } catch (err) {
      // 오버레이 파손 시 기본값으로 계속 (부팅 실패보다 낫다) — 단, 로그로 알림
      console.error(`[config] ai-providers.local.json parse failed — ignored: ${String(err)}`);
    }
  }

  // 2) 플랫폼 필터: platforms 명시된 프로바이더는 현재 플랫폼일 때만 활성
  const plat = detectPlatform();
  providers = providers.map(p => {
    const platforms = (p as { platforms?: string[] }).platforms;
    if (platforms && !platforms.includes(plat)) return { ...p, enabled: false };
    return p;
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
    // OLLAMA_HOST may already contain port (e.g. "172.28.112.1:11434") — don't append again
    const hasPort = /:\d+$/.test(host);
    const port = process.env.OLLAMA_PORT || '11434';
    base = `http://${host}${hasPort ? '' : `:${port}`}`;
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
