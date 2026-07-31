export function executeWaitFor(selector, timeoutMs) {
  const validatedTimeout = Math.max(1, Math.min(timeoutMs, 20000));
  // ... implementation using validatedTimeout
}