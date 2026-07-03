import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAgentCards } from '../src/core/agent-card.js';
import { createGateway } from '../src/server/gateway.js';

let server: Awaited<ReturnType<typeof createGateway>>;

beforeAll(async () => {
  server = await createGateway();
});

afterAll(async () => {
  await server.close();
});

describe('buildAgentCards schema and functionality verification', () => {
  it('should compile agent cards matching the AgentCard schema', async () => {
    const mockProviders = [
      {
        id: 'test-agent-1',
        name: 'Test Agent One',
        role: 'Tester',
        capabilities: ['test', 'verify'],
        endpoint: 'http://localhost:9999',
      },
      {
        id: 'test-agent-2',
        name: 'Test Agent Two',
        role: 'Debugger',
        capabilities: ['debug'],
        endpoint: '',
      }
    ];

    const cards = await buildAgentCards(mockProviders);

    expect(cards).toBeInstanceOf(Array);
    expect(cards).toHaveLength(2);

    for (const card of cards) {
      // Schema validation
      expect(typeof card.name).toBe('string');
      expect(typeof card.role).toBe('string');
      expect(card.capabilities).toBeInstanceOf(Array);
      for (const cap of card.capabilities) {
        expect(typeof cap).toBe('string');
      }

      // status must be 'idle' | 'working' | 'error'
      expect(['idle', 'working', 'error']).toContain(card.status);

      expect(typeof card.endpoint).toBe('string');
      expect(typeof card.successRate).toBe('number');
      expect(card.successRate).toBeGreaterThanOrEqual(0);
      expect(card.successRate).toBeLessThanOrEqual(1);

      expect(typeof card.gate).toBe('string');

      if (card.signature !== undefined) {
        expect(typeof card.signature).toBe('string');
      }
    }

    // Specific field checks for mock provider 1
    expect(cards[0].name).toBe('Test Agent One');
    expect(cards[0].role).toBe('Tester');
    expect(cards[0].capabilities).toEqual(['test', 'verify']);
    expect(cards[0].endpoint).toBe('http://localhost:9999');
    expect(cards[0].successRate).toBe(1.0); // Default fallback when no DB tasks exist

    // Specific field checks for mock provider 2
    expect(cards[1].name).toBe('Test Agent Two');
    expect(cards[1].role).toBe('Debugger');
    expect(cards[1].capabilities).toEqual(['debug']);
    expect(cards[1].endpoint).toBe('');
  });

  it('should fallback to default providers when none are passed', async () => {
    const cards = await buildAgentCards();
    expect(cards).toBeInstanceOf(Array);
    if (cards.length > 0) {
      const card = cards[0];
      expect(typeof card.name).toBe('string');
      expect(typeof card.role).toBe('string');
      expect(card.capabilities).toBeInstanceOf(Array);
      expect(['idle', 'working', 'error']).toContain(card.status);
      expect(typeof card.endpoint).toBe('string');
      expect(typeof card.successRate).toBe('number');
      expect(typeof card.gate).toBe('string');
    }
  });
});

describe('GET /.well-known/agent-card.json gateway route integration test', () => {
  it('returns valid JSON with agents list matching AgentCard schema', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/.well-known/agent-card.json',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('agents');
    expect(body.agents).toBeInstanceOf(Array);

    for (const card of body.agents) {
      expect(typeof card.name).toBe('string');
      expect(typeof card.role).toBe('string');
      expect(card.capabilities).toBeInstanceOf(Array);
      expect(['idle', 'working', 'error']).toContain(card.status);
      expect(typeof card.endpoint).toBe('string');
      expect(typeof card.successRate).toBe('number');
      expect(typeof card.gate).toBe('string');
    }
  });
});
