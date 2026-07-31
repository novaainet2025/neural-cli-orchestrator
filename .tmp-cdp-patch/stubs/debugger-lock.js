export async function withTabDebuggerLock(_tabId, fn) {
  return fn();
}
