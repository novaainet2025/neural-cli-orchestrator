import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_PORT = 6200;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_ENDPOINT = `${SERVER_URL}/api/health`; // assuming there is a health endpoint, we may need to adjust

// Function to wait for server to be ready
async function waitForServer(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(HEALTH_ENDPOINT, { method: 'GET' });
      if (response.ok) {
        return true;
      }
    } catch (err) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not become ready within ${timeout}ms`);
}

// Function to run the consensus test
async function runConsensusTest() {
  const response = await fetch(`${SERVER_URL}/api/realtime/consensus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What is the capital of France?',
      providers: ['opencode', 'agy'],
      consensusThreshold: 0.8
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  console.log('Consensus test result:', JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  let serverProcess = null;
  let serverStartedByUs = false;

  try {
    // First, check if server is already running
    let serverReady = false;
    try {
      await waitForServer(2000); // short timeout to check if already running
      serverReady = true;
    } catch (err) {
      // Server not running, we'll start it
    }

    if (!serverReady) {
      console.log('Starting server...');
      // Start the server using tsx
      serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });

      serverProcess.stdout.on('data', (data) => {
        process.stdout.write(`[server] ${data}`);
      });
      serverProcess.stderr.on('data', (data) => {
        process.stderr.write(`[server err] ${data}`);
      });

      serverStartedByUs = true;
      // Wait for server to be ready
      await waitForServer();
      console.log('Server started and ready.');
    } else {
      console.log('Server is already running.');
    }

    // Run the test
    await runConsensusTest();
    console.log('Test passed!');

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    // Stop the server if we started it
    if (serverStartedByUs && serverProcess) {
      console.log('Stopping server...');
      serverProcess.kill();
      serverProcess = null;
    }
  }
}

main();