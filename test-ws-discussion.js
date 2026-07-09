import { WebSocket } from 'ws';

const API = 'http://localhost:6200';
const WS_BASE = 'ws://localhost:6201';

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
}

function connectWS(wsUrl) {
  return new Promise((res, rej) => {
    const msgs = [];
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => res({ ws, msgs, close: () => ws.close() }));
    ws.on('message', d => {
      try { msgs.push(JSON.parse(d.toString())); } catch {}
    });
    ws.on('error', rej);
    ws.on('close', () => {
      // resolve even on close so we can return msgs
      res({ ws, msgs, close: () => {} });
    });
    setTimeout(() => rej(new Error('WS connection timeout')), 5000);
  });
}

async function main() {
  console.log('Creating discussion...');
  const { data } = await post('/api/discussion/create', { mode: 'discussion' });
  console.log('Discussion created:', data);
  const wsUrl = data.wsUrl || data.session?.wsUrl;
  if (!wsUrl) throw new Error('No wsUrl in response');
  
  console.log('Connecting to WS:', wsUrl);
  const { ws, msgs, close } = await connectWS(wsUrl);
  
  // Wait for up to 10 seconds for messages
  const start = Date.now();
  while (Date.now() - start < 10000) {
    await new Promise(r => setTimeout(r, 100));
    if (msgs.length > 0) break;
  }
  
  console.log(`Received ${msgs.length} messages:`);
  msgs.forEach((m, i) => {
    console.log(`  ${i}: ${JSON.stringify(m)}`);
  });
  
  // Check we got at least one discussion-related event
  const discussionEvents = msgs.filter(m => m.type && m.type.startsWith('discussion:'));
  if (discussionEvents.length === 0) {
    console.warn('No discussion events received');
  } else {
    console.log(`Received ${discussionEvents.length} discussion events`);
  }
  
  close();
  console.log('Test completed.');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
