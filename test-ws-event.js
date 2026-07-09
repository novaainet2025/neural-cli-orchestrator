import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:6201';

new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ws.close();
    reject(new Error('Timeout waiting for WS event'));
  }, 5000);

  ws.on('open', () => {
    console.log('WebSocket connected');
  });
  ws.on('message', (data) => {
    const msg = data.toString();
    console.log('Received:', msg);
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type && (parsed.type.startsWith('mesh:') || parsed.type.startsWith('task:'))) {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  });
  ws.on('error', (err) => {
    clearTimeout(timeout);
    ws.close();
    reject(err);
  });
  ws.on('close', (code, reason) => {
    if (!timedOut) {
      reject(new Error(`WebSocket closed early: ${code} ${reason}`));
    }
  });
})
.then(() => {
  console.log('Test passed: Received expected WS event');
  process.exit(0);
})
.catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});