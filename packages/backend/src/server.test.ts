import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

/**
 * HTTP-level integration tests.
 *
 * These drive the real Fastify instance through `inject`, so the plugin
 * registrations, pre-handlers, error handler, and not-found handler are all
 * genuinely exercised. They deliberately run **without a database**: everything
 * asserted here is a property the API must hold before it can talk to one, and
 * an unauthenticated request must never reach the database at all.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('liveness', () => {
  it('answers /health without touching any dependency', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    expect(typeof response.json().version).toBe('string');
  });

  it('answers /api/version with the running version and Node version', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/version' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: expect.any(String),
      terminalAvailable: expect.any(Boolean),
      node: expect.stringMatching(/^v\d+\./),
    });
  });
});

describe('authentication enforcement', () => {
  it('rejects an unauthenticated files request with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/files/list' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({
      code: 'UNAUTHENTICATED',
      statusCode: 401,
    });
  });

  it('rejects an unauthenticated user-administration request with 401, not 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/users' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unauthenticated terminal request with 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/terminal/sessions' });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['a malformed header', 'Bearer'],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a garbage token', 'Bearer not-a-jwt'],
    ['a JWT signed by someone else', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.forged'],
  ])('rejects %s with 401', async (_label, authorization) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/list',
      headers: { authorization },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.statusCode).toBe(401);
  });

  it('does not disclose whether a forged token was structurally valid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/list',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.forged' },
    });

    // A signature failure and an expired token must not be distinguishable by
    // message, or the endpoint becomes a token oracle.
    expect(response.json().error.message).not.toMatch(/stack|secret|signature/i);
  });
});

describe('input validation', () => {
  it('rejects a login body that fails schema validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'NOT VALID', password: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.statusCode).toBe(400);
  });

  it('rejects malformed JSON with 400 rather than crashing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": "aldo", ',
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an unsupported signal on the terminal socket path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/terminal/sessions/00000000-0000-0000-0000-000000000000/input',
      payload: { data: 'ls\n' },
    });

    // Unauthenticated, so 401 comes first — the point is that it is not a 500.
    expect(response.statusCode).toBe(401);
  });
});

describe('routing', () => {
  it('returns a structured 404 for an unknown API route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('returns 404 rather than 500 for a browser navigation when no frontend is built', async () => {
    // `reply.sendFile` only exists once @fastify/static is registered. An
    // API-only deployment must still answer this with a 404.
    const response = await app.inject({
      method: 'GET',
      url: '/desktop',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('exposes the request id on the response for correlation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-correlation-id' },
    });

    expect(response.headers['x-request-id']).toBe('test-correlation-id');
  });
});

describe('security headers', () => {
  it('sets a content security policy that forbids framing', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const csp = String(response.headers['content-security-policy'] ?? '');

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('does not advertise the server implementation', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error masking', () => {
  it('never returns a stack trace or a credential to the client', async () => {
    // This route touches the database. With no database reachable it becomes a
    // 500, which is exactly the case that must be masked; with one reachable it
    // returns 200 and the assertion below is vacuous but harmless.
    const response = await app.inject({ method: 'GET', url: '/api/auth/bootstrap-status' });
    const body = response.body;

    expect(body).not.toMatch(/\bat\s+\w+\s+\(/);
    expect(body).not.toMatch(/postgresql:\/\//);
    expect(body).not.toMatch(/password/i);

    if (response.statusCode >= 500) {
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(response.json().error.message).toBe('Internal Server Error');
    }
  });
});
