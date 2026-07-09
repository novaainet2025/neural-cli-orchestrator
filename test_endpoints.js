const http = require('http');
const HOST = '127.0.0.1';
const PORT = 6200;

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  const results = [];

  // 1) GET /api/ai/manifest @type field exists
  try {
    const res = await request({ hostname: HOST, port: PORT, path: '/api/ai/manifest', method: 'GET' });
    const pass = res.statusCode === 200 && res.data && res.data['@type'] !== undefined;
    results.push({ name: 'GET /api/ai/manifest @type', pass });
  } catch (e) {
    results.push({ name: 'GET /api/ai/manifest @type', pass: false, error: e.message });
  }

  // 2) GET /api/ai/context agents.total > 0
  try {
    const res = await request({ hostname: HOST, port: PORT, path: '/api/ai/context', method: 'GET' });
    const pass = res.statusCode === 200 && res.data && res.data.agents && res.data.agents.total > 0;
    results.push({ name: 'GET /api/ai/context agents.total>0', pass });
  } catch (e) {
    results.push({ name: 'GET /api/ai/context agents.total>0', pass: false, error: e.message });
  }

  // 3) GET /api/ai/search?q=cursor hits > 0
  try {
    const res = await request({ hostname: HOST, port: PORT, path: '/api/ai/search?q=cursor', method: 'GET' });
    const pass = res.statusCode === 200 && res.data && res.data.hits && res.data.hits > 0;
    results.push({ name: 'GET /api/ai/search?q=cursor hits>0', pass });
  } catch (e) {
    results.push({ name: 'GET /api/ai/search?q=cursor hits>0', pass: false, error: e.message });
  }

  // 4) POST /api/ai/agents/verify-bot/memory save success
  try {
    const res = await request({
      hostname: HOST,
      port: PORT,
      path: '/api/ai/agents/verify-bot/memory',
      method: 'POST'
    }, { key: 'test', value: 'verification' });
    // Assuming success if status 200 and maybe a saved field
    const pass = res.statusCode === 200 && res.data && (res.data.success || res.data.saved);
    results.push({ name: 'POST /api/ai/agents/verify-bot/memory save', pass });
  } catch (e) {
    results.push({ name: 'POST /api/ai/agents/verify-bot/memory save', pass: false, error: e.message });
  }

  // 5) GET /api/ai/agents/verify-bot/home memoryCount > 0
  try {
    const res = await request({ hostname: HOST, port: PORT, path: '/api/ai/agents/verify-bot/home', method: 'GET' });
    const pass = res.statusCode === 200 && res.data && res.data.memoryCount && res.data.memoryCount > 0;
    results.push({ name: 'GET /api/ai/agents/verify-bot/home memoryCount>0', pass });
  } catch (e) {
    results.push({ name: 'GET /api/ai/agents/verify-bot/home memoryCount>0', pass: false, error: e.message });
  }

  // 6) GET /api/ai/residents totalResidents > 0
  try {
    const res = await request({ hostname: HOST, port: PORT, path: '/api/ai/residents', method: 'GET' });
    const pass = res.statusCode === 200 && res.data && res.data.totalResidents && res.data.totalResidents > 0;
    results.push({ name: 'GET /api/ai/residents totalResidents>0', pass });
  } catch (e) {
    results.push({ name: 'GET /api/ai/residents totalResidents>0', pass: false, error: e.message });
  }

  // Output results
  results.forEach(r => {
    console.log(`${r.name}: ${r.pass ? 'PASS' : 'FAIL'}`);
  });
}

runTests().catch(console.error);