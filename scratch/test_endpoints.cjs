const fs = require('fs');
const http = require('http');

const gatewayCode = fs.readFileSync('/Users/nova-ai/project/nco/src/server/gateway.ts', 'utf8');
const endpointRegex = /app\.(get|post|put|delete|patch)\('(\/api\/[^']+)'/g;
const endpoints = [];
let match;
while ((match = endpointRegex.exec(gatewayCode)) !== null) {
    if (!match[2].includes(':')) { // Skip endpoints with path parameters for simple testing
        endpoints.push({ method: match[1].toUpperCase(), path: match[2] });
    }
}

// deduplicate
const uniqueEndpoints = [];
const seen = new Set();
for (const ep of endpoints) {
    const key = `${ep.method} ${ep.path}`;
    if (!seen.has(key)) {
        seen.add(key);
        uniqueEndpoints.push(ep);
    }
}

console.log(`Found ${uniqueEndpoints.length} unique endpoints without path parameters.`);

async function testEndpoint(ep) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: 6200,
            path: ep.path,
            method: ep.method,
            timeout: 2000, // 2s timeout
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({ ...ep, status: res.statusCode, body: data.substring(0, 100) + (data.length > 100 ? '...' : '') }));
        });
        
        req.on('error', (e) => resolve({ ...ep, status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ...ep, status: 0, error: 'timeout' }); });
        
        if (['POST', 'PUT', 'PATCH'].includes(ep.method)) {
            req.write(JSON.stringify({}));
        }
        req.end();
    });
}

async function runTests() {
    const results = [];
    for (const ep of uniqueEndpoints) {
        const res = await testEndpoint(ep);
        console.log(`[${res.status}] ${res.method} ${res.path}`);
        results.push(res);
    }
    fs.writeFileSync('/Users/nova-ai/project/nco/REPORTS/api_test_results.json', JSON.stringify(results, null, 2));
}

runTests();
