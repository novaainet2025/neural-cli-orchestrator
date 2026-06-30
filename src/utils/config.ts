import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync, writeFileSync } from 'fs';
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
    mlx: number;
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

function writeJSON(filename: string, value: unknown): void {
  const filepath = resolve(ROOT, 'config', filename);
  writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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

export interface CompanySelectionConfig {
  keywords: string[];
  aliases?: string[];
  regexes?: string[];
  minComplexity?: number;
  priority?: number;
  autoSelect?: boolean;
}

export interface CompanyRoleConfig {
  role: string;
  provider?: string;
  fallbackProviders?: string[];
  prompt: string;
}

export interface CompanyAutomationConfig {
  strategy: 'pipeline' | 'remote-task';
  autoProgress?: boolean;
  endpoint?: string;
  method?: 'POST';
  timeoutMs?: number;
  fallbackProvider?: string;
  payloadTemplate?: {
    promptField?: string;
    taskIdField?: string;
  };
}

export interface CompanyProfile {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  mode: 'company' | 'nova-ax';
  selection: CompanySelectionConfig;
  providers: {
    default: string[];
    roles: CompanyRoleConfig[];
  };
  automation: CompanyAutomationConfig;
  metadata?: Record<string, unknown>;
}

interface CompanyProfilesFile {
  version: number;
  updated: string;
  companies: CompanyProfile[];
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

export function loadCompanyProfiles(): CompanyProfile[] {
  return loadJSON<CompanyProfilesFile>('company-profiles.json').companies;
}

export function loadEnabledCompanyProfiles(): CompanyProfile[] {
  return loadCompanyProfiles().filter(company => company.enabled);
}

export function getCompanyProfile(id: string): CompanyProfile | undefined {
  return loadCompanyProfiles().find(company => company.id === id);
}

export function saveCompanyProfiles(companies: CompanyProfile[]): void {
  writeJSON('company-profiles.json', {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    companies,
  });
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
  PROJECT_DIR: process.env.PROJECT_DIR || topology.paths.backend,
  NCO_API_TOKEN: process.env.NCO_API_TOKEN || '',
  NCO_JWT_SECRET: process.env.NCO_JWT_SECRET || '',
  HF_TOKEN: process.env.HF_TOKEN || '',
  OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH || '',
  ROOT,
} as const;

// ─── API Key Helpers ──────────────────────────────────
export function getApiKeys(envVar: string, delimiter = ','): string[] {
  const raw = process.env[envVar] || '';
  return raw.split(delimiter).map(k => k.trim()).filter(Boolean);
}
