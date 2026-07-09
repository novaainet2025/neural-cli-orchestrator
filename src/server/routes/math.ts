import type { FastifyInstance } from 'fastify';
import { createLogger } from '../../utils/logger.js';
import { MathValidationError, validateAddTwo } from '../../services/mathService.js';

const log = createLogger('math-route');

export async function registerMathRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/add', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { a, b } = body;
      const response = validateAddTwo(a, b);

      log.info({ a, b, result: response.result }, 'addTwo request processed');
      reply.code(200);return response;
    } catch (error) {
      if (error instanceof MathValidationError) {
        log.warn({ err: error.message, body: request.body }, 'Invalid addTwo request');
        reply.code(error.statusCode);
        return { error: 'Invalid numbers', message: error.message, statusCode: error.statusCode };
      }

      throw error;
    }
  });
}
