import { getRedis, isRedisConnected, redisHealthCheck } from './src/storage/redis.js';
import { sharedState } from './src/core/shared-state.js';
import { performance } from 'perf_hooks';

async function main() {
  const t0 = performance.now();
  await redisHealthCheck();
  const t1 = performance.now();
  console.log('redisHealthCheck:', t1 - t0, 'ms');
  
  const t2 = performance.now();
  await sharedState.getAllAgentStates();
  const t3 = performance.now();
  console.log('getAllAgentStates:', t3 - t2, 'ms');
  
  process.exit(0);
}

main().catch(console.error);
