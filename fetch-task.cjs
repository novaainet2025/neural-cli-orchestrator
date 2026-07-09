const http = require('http');
const options = {
  hostname: 'localhost',
  port: 6200,
  path: '/api/tasks/sess_9oLo71YQasP-kJeS',
  method: 'GET'
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
req.end();