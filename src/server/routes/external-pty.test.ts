import { createHash } from 'node:crypto';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerExternalPtyRoutes } from './external-pty.js';

describe('external PTY routes', () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify({ logger: false });
    await registerExternalPtyRoutes(app);
  });

  afterEach(async () => {
    await app.close();
  });

  async function register() {
    const response = await app.inject({
      method: 'POST',
      url: '/api/external-sessions',
      payload: {
        externalSessionId: 'terminal-1',
        paneKey: 'pane:1',
        providerId: 'codex',
        workspaceRoot: '/project/nova-use',
        owner: 'nova-use',
        transport: 'pty',
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function dispatch(sessionId: string, prompt = '  exact prompt\n') {
    const response = await app.inject({
      method: 'POST',
      url: `/api/external-sessions/${sessionId}/dispatch`,
      payload: {
        clientDispatchId: 'client-1',
        runId: 'run-1',
        prompt,
        role: 'implement',
        participants: ['OpenAI Codex'],
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('registers NCO authority and preserves the exact dispatch payload', async () => {
    const authority = await register();
    expect(authority).toMatchObject({
      externalSessionId: 'terminal-1',
      providerId: 'codex',
      workspaceRoot: '/project/nova-use',
      authority: 'nco-http',
    });
    expect(authority.capabilityProfileHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Date.parse(authority.leaseExpiresAt)).toBeGreaterThan(Date.now());

    const prompt = '  exact prompt\n';
    const result = await dispatch(authority.sessionId, prompt);
    expect(result.exactPayload).toBe(prompt);
    expect(result.payloadSha256).toBe(`sha256:${createHash('sha256').update(prompt).digest('hex')}`);
    expect(result.receipt).toMatchObject({ schema: 'nco-external-pty-receipt/v1', kind: 'dispatch-accepted' });
  });

  it('auto-approves safe commands and gates destructive commands', async () => {
    const authority = await register();
    const result = await dispatch(authority.sessionId);
    const safe = await app.inject({
      method: 'POST',
      url: `/api/external-dispatches/${result.dispatchId}/approval-decision`,
      payload: {
        commandArgs: ['npm', 'test'],
        category: 'test',
        target: 'npm',
        scope: '/project/nova-use',
      },
    });
    expect(safe.statusCode).toBe(200);
    expect(safe.json()).toMatchObject({ decision: 'allow', responseBase64: 'eQ0=' });

    const destructive = await app.inject({
      method: 'POST',
      url: `/api/external-dispatches/${result.dispatchId}/approval-decision`,
      payload: {
        commandArgs: ['git', 'push', '--force'],
        category: 'execute',
        target: 'git',
        scope: '/project/nova-use',
      },
    });
    expect(destructive.statusCode).toBe(200);
    expect(destructive.json()).toMatchObject({
      decision: 'waiting_preauth',
      reason: 'destructive command requires signed preauthorization',
    });
  });

  it('records evidence events and cancels an owned dispatch', async () => {
    const authority = await register();
    const result = await dispatch(authority.sessionId);
    const event = await app.inject({
      method: 'POST',
      url: `/api/external-dispatches/${result.dispatchId}/events`,
      payload: {
        status: 'working',
        outputDigest: `sha256:${'e'.repeat(64)}`,
        evidence: { source: 'nova-use-main-pty' },
      },
    });
    expect(event.statusCode).toBe(200);
    expect(event.json()).toEqual({ accepted: true });

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/external-dispatches/${result.dispatchId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({
      cancelled: true,
      receipt: { schema: 'nco-external-pty-receipt/v1', kind: 'dispatch-cancel' },
    });
  });

  it('rejects scope substitution and malformed registrations', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/external-sessions',
      payload: {
        externalSessionId: '../terminal',
        paneKey: 'pane:1',
        providerId: 'codex',
        workspaceRoot: '/project/nova-use',
        owner: 'nova-use',
        transport: 'pty',
      },
    });
    expect(malformed.statusCode).toBe(400);

    const authority = await register();
    const result = await dispatch(authority.sessionId);
    const substituted = await app.inject({
      method: 'POST',
      url: `/api/external-dispatches/${result.dispatchId}/approval-decision`,
      payload: {
        commandArgs: ['npm', 'test'],
        category: 'test',
        target: 'npm',
        scope: '/project/other',
      },
    });
    expect(substituted.statusCode).toBe(403);
    expect(substituted.json()).toEqual({ error: 'approval_scope_mismatch' });
  });
});
