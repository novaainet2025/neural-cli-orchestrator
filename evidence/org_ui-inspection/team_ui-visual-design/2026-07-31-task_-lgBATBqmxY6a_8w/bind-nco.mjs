#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createGateway } from '/Users/nova-ai/project/nco/dist/server/gateway.js';

const outDir = path.dirname(new URL(import.meta.url).pathname);
const taskId = 'task_-lgBATBqmxY6a_8w';
const actorId = 'agy';
const decision = JSON.parse(
  await fs.readFile(path.join(outDir, 'verification-decision.json'), 'utf8'),
);

if (
  decision.status !== 'approved'
  || decision.passedInstitutions !== 6
  || typeof decision.receiptId !== 'string'
) {
  throw new Error('Refusing NCO binding without a 6/6 approved receipt');
}

const app = await createGateway();
const response = await app.inject({
  method: 'POST',
  url: `/api/tasks/${taskId}/verification`,
  payload: {
    receiptId: decision.receiptId,
    actorId,
  },
});
const body = JSON.parse(response.body);
const result = {
  request: {
    method: 'POST',
    path: `/api/tasks/${taskId}/verification`,
    body: { receiptId: decision.receiptId, actorId },
  },
  response: {
    statusCode: response.statusCode,
    body,
  },
  observedAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(outDir, 'nco-binding-response.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);
await app.close();
console.log(JSON.stringify(result, null, 2));
if (response.statusCode < 200 || response.statusCode >= 300) process.exit(4);
