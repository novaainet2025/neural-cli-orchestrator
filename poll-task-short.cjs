const http = require('http');

function pollTask(sessionId, maxAttempts = 5) {
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    const options = {
      hostname: 'localhost',
      port: 6200,
      path: `/api/tasks/${sessionId}`,
      method: 'GET'
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log(`Attempt ${attempts}: Status ${res.statusCode}`);
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            console.log('Task result:', JSON.stringify(parsed, null, 2));
            clearInterval(interval);
          } catch (e) {
            console.log('Response:', data);
          }
        } else if (res.statusCode === 404) {
          console.log('Task not found yet...');
        } else {
          console.log('Error:', data);
          clearInterval(interval);
        }
      });
    });
    req.on('error', (e) => {
      console.error(e);
      clearInterval(interval);
    });
    req.end();

    if (attempts >= maxAttempts) {
      console.log('Max attempts reached');
      clearInterval(interval);
    }
  }, 2000); // poll every 2 seconds
}

pollTask('sess_9oLo71YQasP-kJeS');