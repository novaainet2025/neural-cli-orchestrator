export const EXTENSION_SINGLE_TIMEOUT = 20000;
export const EXTENSION_BATCH_TIMEOUT = 60000;
export const TIMEOUT_BUFFER_MS = 5000;
export const MAX_RESPONSE_TIMEOUT = 300000;

export function calculateTimeoutMs(envTimeout: number | string | null): number {
  if (typeof envTimeout !== 'number') {
    return MAX_RESPONSE_TIMEOUT;
  }
  if (envTimeout < 1) return 1;
  if (envTimeout > MAX_RESPONSE_TIMEOUT) return MAX_RESPONSE_TIMEOUT;
  return Math.floor(envTimeout);
}