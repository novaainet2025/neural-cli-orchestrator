import { describe, expect, it } from 'vitest';
import {
  authenticateRequest,
  createJwt,
  isRequestAuthorized,
  shouldAuthenticate,
  verifyJwt,
} from './auth.js';

describe('verifyJwt', () => {
  const secret = 'test-secret';

  describe('valid token', () => {
    it('returns decoded payload for a valid HS256 JWT', () => {
      const token = createJwt({ sub: 'user-1', role: 'admin' }, secret, 3600);
      const payload = verifyJwt(token, secret);

      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe('user-1');
      expect(payload?.role).toBe('admin');
      expect(typeof payload?.iat).toBe('number');
      expect(typeof payload?.exp).toBe('number');
      expect(payload!.exp!).toBeGreaterThan(payload!.iat!);
    });
  });

  describe('expired token', () => {
    it('returns null when exp is in the past', () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const token = createJwt({ sub: 'user-1', exp: past }, secret, 3600);

      expect(verifyJwt(token, secret)).toBeNull();
    });
  });

  describe('signature mismatch', () => {
    it('returns null when verified with wrong secret', () => {
      const token = createJwt({ sub: 'user-1' }, secret, 3600);

      expect(verifyJwt(token, 'wrong-secret')).toBeNull();
    });

    it('returns null when signature segment is tampered', () => {
      const token = createJwt({ sub: 'user-1' }, secret, 3600);
      const [header, payload] = token.split('.');
      const tampered = `${header}.${payload}.invalid-signature`;

      expect(verifyJwt(tampered, secret)).toBeNull();
    });
  });

  describe('null/undefined and invalid input', () => {
    it('returns null for null input', () => {
      expect(verifyJwt(null as unknown as string, secret)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(verifyJwt(undefined as unknown as string, secret)).toBeNull();
    });

    it.each([
      ['empty string', ''],
      ['malformed token', 'not.a.jwt'],
      ['two segments only', 'header.payload'],
    ])('returns null for invalid input: %s', (_label, input) => {
      expect(verifyJwt(input, secret)).toBeNull();
    });
  });
});

describe('auth helpers', () => {
  it('authorizes valid JWT from Authorization header', () => {
    const token = createJwt({ sub: 'user-1' }, 'secret', 60);
    const authorized = isRequestAuthorized(
      { authorization: `Bearer ${token}` },
      { jwtSecret: 'secret' },
    );

    expect(authorized).toBe(true);
  });

  it('falls back to legacy API token matching', () => {
    const authorized = isRequestAuthorized(
      { 'x-api-token': 'legacy-token' },
      { apiToken: 'legacy-token' },
    );

    expect(authorized).toBe(true);
  });

  it('only requires authentication for mutating methods', () => {
    expect(shouldAuthenticate('GET')).toBe(false);
    expect(shouldAuthenticate('POST')).toBe(true);
  });

  it('returns 401 for invalid mutating requests', async () => {
    const reply = {
      statusCode: 200,
      payload: null as unknown,
      code(status: number) {
        this.statusCode = status;
        return this;
      },
      send(payload: unknown) {
        this.payload = payload;
        return this;
      },
    };

    await authenticateRequest(
      {
        method: 'POST',
        headers: { authorization: 'Bearer invalid' },
      } as any,
      reply as any,
      { jwtSecret: 'secret' },
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'Unauthorized: Invalid token' });
  });
});
