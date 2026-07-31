import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from '../extension/node_modules/esbuild/lib/main.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_ACTIONS, CONTROL_PLAN_SCHEMA, PAGE_MODEL_SCHEMA, decideAction, validateControlPlan } from '../shared/protocol.js';

assert.equal(PAGE_MODEL_SCHEMA, 'nco.page-model.v1');
assert.equal(BROWSER_ACTIONS.INSPECT.risk, 'read');
assert.equal(BROWSER_ACTIONS.PREFLIGHT.risk, 'read');
assert.equal(decideAction('PREFLIGHT', 'example.com', ['example.com']), 'auto_allow');

const input = {
  goal: '댓글 입력', pageSignature: 'sig-1',
  steps: [{ action: 'type', frameId: 3, selector: '#comment', text: '의견' }, { action: 'click', frameId: 3, selector: '#submit', risk: 'read' }],
};
const first = validateControlPlan(input);
const second = validateControlPlan(structuredClone(input));
assert.equal(first.valid, true);
assert.deepEqual(first, second, 'same semantic input must produce provider-independent output');
assert.equal(first.normalized.schema, CONTROL_PLAN_SCHEMA);
assert.equal(first.normalized.steps[0].risk, 'write');
assert.equal(first.normalized.steps[1].risk, 'write', 'provider-supplied risk must never override protocol risk');
assert.equal(first.normalized.steps[0].requiresPreflight, true);

const deepPlan = validateControlPlan({ steps: [{ action: 'inspect', deep: true }] });
assert.equal(deepPlan.valid, true);
assert.equal(deepPlan.normalized.steps[0].depth, 'deep', 'provider control plans must preserve canonical deep inspection');

const rejected = validateControlPlan({ steps: [{ action: 'EVAL_JS', selector: 'body' }] });
assert.equal(rejected.valid, false);

const debuggerSource = await readFile(new URL('../extension/src/control/debugger-controller.ts', import.meta.url), 'utf8');
assert.match(debuggerSource, /'Runtime\.evaluate'/, 'external Runtime.evaluate must remain explicitly blocked');
assert.match(debuggerSource, /'Input\.dispatchKeyEvent'/, 'raw key dispatch must remain blocked');
assert.doesNotMatch(debuggerSource, /CDP_ALLOWED_PREFIXES/, 'prefix allowlist must be removed');
assert.match(debuggerSource, /'DOM\.getDocument'/, 'explicit read allowset must include DOM.getDocument');
const deepSource = await readFile(new URL('../shared/enhanced-snapshot.js', import.meta.url), 'utf8');
assert.doesNotMatch(deepSource, /send\(['"]Runtime\./, 'deep inspector must not invoke Runtime methods');

const temp = await mkdtemp(join(tmpdir(), 'nco-control-contract-'));
const debuggerOutfile = join(temp, 'debugger-controller.mjs');
try {
  await build({
    entryPoints: [fileURLToPath(new URL('../extension/src/control/debugger-controller.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: debuggerOutfile,
  });
  const { executeDebuggerAction } = await import(`${pathToFileURL(debuggerOutfile).href}?t=${Date.now()}`);

  let attached = 0;
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, callback) { attached++; callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, _method, _params, callback) { callback({}); },
    },
  };

  const blockedMethods = [
    'Runtime.evaluate',
    'Input.dispatchKeyEvent',
    'DOM.setOuterHTML',
    'DOM.setAttributeValue',
    'DOM.setFileInputFiles',
    'Input.insertText',
    'Input.dispatchDragEvent',
    'Input.foo',
    'DOM.foo',
  ];
  for (const method of blockedMethods) {
    const result = await executeDebuggerAction('CDP_EXECUTE', { method });
    assert.equal(result.ok, false, `${method} must be blocked`);
    assert.equal(result.error?.code, 'cdp_method_blocked', `${method} error code`);
    assert.match(result.error?.message ?? '', new RegExp(method.replace('.', '\\.')), `${method} must appear in error message`);
  }
  assert.equal(attached, 0, 'blocked CDP_EXECUTE must fail before debugger attach');
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('control contract: ok');
