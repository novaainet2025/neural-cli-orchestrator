#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE = join(homedir(), '.nco-cli-ext');
const url = (await readFile(join(STORE, 'bridge-url'), 'utf8')).trim();
const token = (await readFile(join(STORE, 'bridge-token'), 'utf8')).trim();

function envelope(type, payload = {}, options = {}) {
  return {
    v: 2,
    id: options.id || randomUUID(),
    type,
    sessionId: options.sessionId ?? null,
    seq: 1,
    replyTo: options.replyTo ?? null,
    ts: new Date().toISOString(),
    payload,
  };
}

async function bridgeRequest(outboundRequest, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let requestId;
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(envelope('hello', { token, role: 'agent' })));
    });
    socket.addEventListener('error', () => reject(new Error(`connect failed ${url}`)));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'error') {
        clearTimeout(timer);
        socket.close();
        reject(new Error(message.payload?.message || 'bridge error'));
        return;
      }
      if (message.type === 'welcome') {
        const sessionId = message.payload?.sessionId;
        const outbound = envelope(outboundRequest.type, outboundRequest.payload, { sessionId });
        requestId = outbound.id;
        socket.send(JSON.stringify(outbound));
        return;
      }
      if ((message.type === 'browser.action.result' || message.type === 'browser.status') && message.replyTo === requestId) {
        clearTimeout(timer);
        socket.close();
        resolve(message);
      }
    });
  });
}

async function action(actionName, payload = {}) {
  return bridgeRequest({
    type: 'browser.action.request',
    payload: { action: actionName, ...payload },
  });
}

console.log('=== STATUS ===');
const status = await bridgeRequest({ type: 'browser.status.get', payload: {} });
console.log(JSON.stringify(status));

console.log('\n=== NAVIGATE iq-test.us ===');
const nav = await action('NAVIGATE', { url: 'https://iq-test.us/' });
console.log(JSON.stringify(nav));

console.log('\n=== ANALYZE ===');
const analyze = await action('ANALYZE');
console.log(JSON.stringify(analyze));
