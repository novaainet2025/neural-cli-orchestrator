import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { computeOrganizationScores, computeTeamScores } from '../../core/team-scorer.js';
import { getDb } from '../../storage/database.js';

export async function registerTeamScoreRoutes(
  app: FastifyInstance,
  database: Database.Database = getDb(),
): Promise<void> {
  app.get('/api/teams/scores', async () => computeTeamScores(database));
  app.get('/api/org/scores', async () => computeOrganizationScores(database));
}
