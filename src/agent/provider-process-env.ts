import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const DISABLED_TOGGLE_VALUES = new Set(['0', 'false', 'off']);

function isCursorPathFallbackEnabled(value: string | undefined): boolean {
  return !DISABLED_TOGGLE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

/**
 * Build the environment for a provider subprocess.
 *
 * Cursor Agent is installed in ~/.local/bin on NCO hosts, but service managers
 * can start NCO with a narrower PATH. Keep the fallback provider-scoped and
 * reversible so other CLI lookup behavior remains unchanged.
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
