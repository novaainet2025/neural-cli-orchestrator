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

export function loadProviders(): ProviderConfig[] {
  return loadJSON<ProvidersFile>('ai-providers.json').providers;
}

export function loadEnabledProviders(): ProviderConfig[] {
  return loadProviders().filter(p => p.enabled);
}

export function getProvider(id: string): ProviderConfig | undefined {
  return loadProviders().find(p => p.id === id);
}

// ─── Environment ──────────────────────────────────────
export const env = {
  PORT: Number(process.env.PORT || topology.ports.apiGateway),
  WS_PORT: Number(process.env.WS_PORT || topology.ports.websocket),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_PATH: resolve(ROOT, process.env.DATABASE_PATH || topology.paths.database),
  REDIS_URL: process.env.REDIS_URL || `redis://127.0.0.1:${topology.ports.redis}`,
  STATE_FILE_PATH: resolve(ROOT, process.env.STATE_FILE_PATH || topology.paths.stateFile),
  DASHBOARD_URL: process.env.DASHBOARD_URL || `http://localhost:${topology.ports.dashboard}`,
  PROJECT_DIR: process.env.PROJECT_DIR || topology.paths.dashboard,
  NCO_API_TOKEN: process.env.NCO_API_TOKEN || '',
  HF_TOKEN: process.env.HF_TOKEN || '',
  ROOT,
} as const;

// ─── API Key Helpers ──────────────────────────────────
export function getApiKeys(envVar: string, delimiter = ','): string[] {
  const raw = process.env[envVar] || '';
  return raw.split(delimiter).map(k => k.trim()).filter(Boolean);
}
