import { FastifyInstance } from 'fastify';

export async function registerCliQaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cli-qa/verify', async (req, reply) => {
    return reply.send({
      status: 'ok',
      team: 'cli-assurance-2026',
      message: 'Verification successful',
      timestamp: new Date().toISOString()
    });
  });
}
