const { spawn } = require('child_process');
const http = require('http');

// Start the server
const server = spawn('npx', ['tsx', 'watch', 'src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });

let serverReady = false;

// Function to check if server is ready
function checkServer() {
  const req = http.get('http://localhost:6200/health', (res) => {
    if (res.statusCode === 200) {
      serverReady = true;
      console.log('Server is ready');
      // After server is ready, run the test
      const test = spawn('npx', ['tsx', 'test-consensus.ts'], { stdio: 'inherit' });
      test.on('close', (code) => {
        console.log(`Test exited with code ${code}`);
        server.kill();
      });
    } else {
      // Not ready yet, try again after a short delay
      setTimeout(checkServer, 1000);
    }
  });

  req.on('error', (err) => {
    // Server not up yet, retry
    setTimeout(checkServer, 1000);
  });

  req.end();
}

// Start checking
setTimeout(checkServer, 2000);

// Handle server output (optional)
server.stdout.on('data', (data) => {
  process.stdout.write(`[server] ${data}`);
});
server.stderr.on('data', (data) => {
  process.stderr.write(`[server err] ${data}`);
});

server.on('close', (code) => {
  console.log(`Server process exited with code ${code}`);
});