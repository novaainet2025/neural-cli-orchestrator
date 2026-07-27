const WebSocket = require('ws');
const fs = require('fs');

async function testWebSocket() {
    return new Promise((resolve, reject) => {
        console.log('Connecting to ws://localhost:6201...');
        const ws = new WebSocket('ws://localhost:6201');
        
        const timeout = setTimeout(() => {
            ws.close();
            resolve({ status: 'timeout', messages: [] });
        }, 5000);

        const messages = [];

        ws.on('open', () => {
            console.log('Connected to WebSocket');
            ws.send(JSON.stringify({ type: 'ping' }));
        });

        ws.on('message', (data) => {
            console.log('Received:', data.toString());
            messages.push(data.toString());
            if (messages.length > 2) { // Just get a few messages
                clearTimeout(timeout);
                ws.close();
                resolve({ status: 'success', messages });
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket error:', err.message);
            clearTimeout(timeout);
            resolve({ status: 'error', error: err.message });
        });
    });
}

testWebSocket().then(res => {
    fs.writeFileSync('/Users/nova-ai/project/nco/REPORTS/ws_test_results.json', JSON.stringify(res, null, 2));
    console.log('WebSocket test finished.');
});
