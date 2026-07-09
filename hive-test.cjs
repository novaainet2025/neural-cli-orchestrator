const http = require('http');
const data = JSON.stringify({prompt: 'Test the hive with a simple greeting.'});
const options = {
  hostname: 'localhost',
  port: 6200,
  path: '/api/hive',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};
const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
});
req.on('error', (e) => {
  console.error(e);
});
req.write(data);
req.end();