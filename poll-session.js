import fetch from 'node-fetch';

const sessionId = 'sess_Y2ZFjUSndbtWwfSt'; // from previous run

async function pollConsensus() {
  let attempts = 0;
  const maxAttempts = 30;
  while (attempts < maxAttempts) {
    try {
      const response = await fetch(`http://localhost:6200/api/realtime/consensus/${sessionId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log(`Attempt ${attempts + 1}:`, JSON.stringify(data, null, 2));
      if (data.status === 'completed' || data.status === 'failed') {
        return data;
      }
    } catch (error) {
      console.error('Error polling consensus:', error);
    }
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2 seconds
  }
  console.log('Timeout reached');
  return null;
}

pollConsensus().then(result => {
  console.log('Final result:', result);
}).catch(err => {
  console.error('Unexpected error:', err);
});