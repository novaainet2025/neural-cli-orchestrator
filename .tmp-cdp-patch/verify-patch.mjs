import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const patchDir = dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'nco-cdp-verify-'));
const debuggerOutfile = join(temp, 'debugger-controller.mjs');

try {
  await build({
    entryPoints: [join(patchDir, 'debugger-controller.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: debuggerOutfile,
    alias: {
      './content-controller.js': join(patchDir, 'stubs/content-controller.js'),
      './debugger-lock.js': join(patchDir, 'stubs/debugger-lock.js'),
      '../shared/destructive.js': join(patchDir, 'stubs/destructive.js'),
    },
  });
  const { executeDebuggerAction } = await import(`${pathToFileURL(debuggerOutfile).href}?t=${Date.now()}`);

  let attached = 0;
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabs: { get: async (tabId) => ({ id: tabId }) },
    debugger: {
      attach(_target, _version, callback) { attached++; callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, method, _params, callback) {
        if (method === 'DOM.getDocument') callback({ root: { nodeId: 42 } });
        else if (method === 'Page.captureScreenshot') callback({ data: 'allowed-shot' });
        else callback({});
      },
    },
  };

  for (const method of ['DOM.setOuterHTML', 'Input.insertText', 'DOM.foo']) {
    const result = await executeDebuggerAction('CDP_EXECUTE', { method });
    assert.equal(result.error?.code, 'cdp_method_blocked');
    assert.match(result.error?.message ?? '', new RegExp(method.replace('.', '\\.')));
  }
  assert.equal(attached, 0);

  const allowedDoc = await executeDebuggerAction('CDP_EXECUTE', { method: 'DOM.getDocument', tabId: 1 });
  assert.equal(allowedDoc.ok, true);
  const allowedShot = await executeDebuggerAction('CDP_EXECUTE', { method: 'Page.captureScreenshot', tabId: 1 });
  assert.equal(allowedShot.ok, true);
  console.log('patch verification: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}
