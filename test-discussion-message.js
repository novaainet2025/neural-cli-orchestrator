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

  // Wait for the connected message
  await new Promise(r => setTimeout(r, 500));

  // Now send a message via REST
  const sessionId = data.session.id;
  console.log(`Sending message to session ${sessionId}`);
  const { data: messageData } = await post(`/api/discussion/${sessionId}/message`, { content: 'Hello NCO Discussion!' });
  console.log('Message sent:', messageData);

  // Wait for up to 10 seconds for the message to appear in the websocket
  const start = Date.now();
  let received = false;
  while (Date.now() - start < 10000) {
    await new Promise(r => setTimeout(r, 100));
    if (msgs.length > 0) {
      // Check if any message is of type 'discussion:message' or similar
      for (const msg of msgs) {
        if (msg.type && msg.type.includes('discussion:message')) {
          console.log('Received discussion message:', msg);
          received = true;
          break;
        }
      }
      if (received) break;
    }
  }

  if (!received) {
    console.log('No discussion message received in time. All messages:', msgs);
  }

  close();
}

main().catch(console.error);