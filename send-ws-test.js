import { WebSocket } from 'ws';
const WS_URL = 'ws://localhost:6201';

const ws = new WebSocket(WS_URL);
ws.on('open', () => {
  console.log('WebSocket connected, sending test message');
  ws.send(JSON.stringify({type: 'test', content: 'hello from test agent'}));
});
ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
ws.on('error', (err) => {
  console.error('Error:', err);
});
ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
  process.exit(0);
});

// Wait for 3 seconds then exit
setTimeout(() => {
  ws.close();
}, 3000);