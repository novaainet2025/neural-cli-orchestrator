import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const DISABLED_TOGGLE_VALUES = new Set(['0', 'false', 'off']);

function isCursorPathFallbackEnabled(value: string | undefined): boolean {
  return !DISABLED_TOGGLE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

function isColorSanitizationEnabled(value: string | undefined): boolean {
  return !DISABLED_TOGGLE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

/**
 * Build the environment for a provider subprocess.
 *
 * Cursor Agent is installed in ~/.local/bin on NCO hosts, but service managers
 * can start NCO with a narrower PATH. Keep the fallback provider-scoped and
 * reversible so other CLI lookup behavior remains unchanged.
 *
 * Provider subprocesses are intentionally non-interactive and their callers set
 * NO_COLOR=1. If the parent process also exports FORCE_COLOR, Bun-based CLIs
 * emit a warning before doing any work. That warning was enough to satisfy the
 * task queue's first-activity watchdog, so an otherwise silent provider could
 * consume the full hard timeout. Keep the color policy in this shared builder
 * and allow an immediate rollback with NCO_PROVIDER_COLOR_SANITIZE=off.
 */
export function buildProviderProcessEnv(
  providerId: string,
  providerEnv: Record<string, string> | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...providerEnv,
  };

  if (isColorSanitizationEnabled(merged.NCO_PROVIDER_COLOR_SANITIZE)) {
    merged.FORCE_COLOR = '0';
    merged.NO_COLOR = '1';
    merged.TERM = 'dumb';
  }

  if (
    providerId !== 'cursor-agent'
    || !isCursorPathFallbackEnabled(merged.NCO_CURSOR_AGENT_PATH_FALLBACK)
  ) {
    return merged;
  }

  const fallbackDir = merged.NCO_CURSOR_AGENT_BIN_DIR?.trim() || join(userHome, '.local', 'bin');
  const pathEntries = (merged.PATH ?? '').split(delimiter).filter(Boolean);
  if (!pathEntries.includes(fallbackDir)) {
    merged.PATH = [fallbackDir, ...pathEntries].join(delimiter);
  }

  return merged;
}
