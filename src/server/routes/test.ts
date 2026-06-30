import { FastifyInstance } from 'fastify';

/**
 * Register a simple test route.
 *
 * GET /api/test
 * Returns a JSON payload confirming that the server is up.
 */
export async function registerTestRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/test', async (request, reply) => {
    return { status: 'ok', message: 'Test route is working' };
  });
}
