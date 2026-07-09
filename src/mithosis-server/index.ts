import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Simple in‑memory placeholder for an orchestrator that runs a single optimal agent sequentially.
// The real implementation would delegate to the NCO orchestrator logic; here we provide the
// required HTTP interface with minimal behaviour so the server starts without errors.

interface OrchestrateBody {
  prompt: string;
  taskType: string;
}

interface BenchmarkRunBody {
  tests: string[];
}

function createServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  // Health check
  server.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok' });
  });

  // Orchestrate endpoint – returns the received payload plus a dummy result.
  server.post('/api/orchestrate', async (request: FastifyRequest<{ Body: OrchestrateBody }>, reply: FastifyReply) => {
    const { prompt, taskType } = request.body;
    // Placeholder: in a real system this would invoke the selected agent.
    const result = {
      agent: 'optimal',
      prompt,
      taskType,
      output: `Executed task of type ${taskType}`,
    };
    return reply.send(result);
  });

  // Benchmark run – simply echoes back the test identifiers.
  server.post('/api/benchmark/run', async (request: FastifyRequest<{ Body: BenchmarkRunBody }>, reply: FastifyReply) => {
    const { tests } = request.body;
    // Placeholder: actual benchmark execution would be implemented here.
    return reply.send({ executed: tests.length, tests });
  });

  return server;
}

// If this file is executed directly, start the server on port 7100.
if (require.main === module) {
  const app = createServer();
  app.listen({ port: 7100, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Mithosis server listening at ${address}`);
  });
}

export default createServer;
