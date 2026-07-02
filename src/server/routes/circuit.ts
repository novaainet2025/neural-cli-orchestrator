import type { FastifyInstance } from 'fastify';
import { agentManager } from '../../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../../security/circuit-breaker-registry.js';

export async function registerCircuitRoutes(app: FastifyInstance) {
  app.get('/api/circuit', async () => {
    const providers = agentManager.listEnabledIds();
    return {
      circuits: circuitBreakerRegistry.listSnapshots(providers),
    };
  });

  app.post('/api/circuit/:agentId/reset', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    if (!agentManager.getProvider(agentId)) {
      reply.code(404);
      return { error: `Unknown agent: ${agentId}` };
    }

    circuitBreakerRegistry.reset(agentId);
    return {
      ok: true,
      circuit: circuitBreakerRegistry.getSnapshot(agentId),
    };
  });
}
