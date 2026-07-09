import { WebSocket } from 'ws';
const WS_URL = 'ws://localhost:6201';

const ws = new WebSocket(WS_URL);
ws.on('open', () => {
  console.log('WebSocket connected');
});
ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
ws.on('error', (err) => {
  console.error('Error:', err);
});
ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});

// Wait for 5 seconds then exit
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 5000);