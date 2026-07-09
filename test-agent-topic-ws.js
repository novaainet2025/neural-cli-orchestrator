import { WebSocket } from 'ws';
import fetch from 'node-fetch';

const API = 'http://localhost:6200';

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
  // Read the topic from agent_test_topic.txt
  const fs = await import('fs');
  const topic = fs.readFileSync('./agent_test_topic.txt', 'utf8').trim();
  console.log('Topic:', topic);

  console.log('Creating discussion...');
  const { data } = await post('/api/discussion/create', { 
    mode: 'discussion',
    topic: topic
  });
  console.log('Discussion created:', data);
  const wsUrl = data.wsUrl || data.session?.wsUrl;
  if (!wsUrl) throw new Error('No wsUrl in response');
  
  console.log('Connecting to WS:', wsUrl);
  const { ws, msgs, close } = await connectWS(wsUrl);
  
  // Wait for up to 15 seconds for messages
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await new Promise(r => setTimeout(r, 100));
    if (msgs.length > 0) break;
  }
  
  console.log(`Received ${msgs.length} messages:`);
  msgs.forEach((msg, idx) => {
    console.log(`  ${idx}:`, JSON.stringify(msg, null, 2));
  });
  
  close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});