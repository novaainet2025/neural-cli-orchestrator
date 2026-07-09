import fetch from 'node-fetch';

const testConsensus = async () => {
  try {
    const response = await fetch('http://localhost:6200/api/realtime/consensus', {
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
  } catch (error) {
    console.error('Error testing consensus:', error);
  }
};

testConsensus();