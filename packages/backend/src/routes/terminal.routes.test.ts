import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAgentFrame, registerAgentSocket } from '../services/agent-rpc.service.js';
import { buildServer } from '../server.js';

import type { FastifyInstance } from 'fastify';

/**
 * Regression tests for host-scope terminal sessions over the REST endpoints.
 *
 * A host session is a PTY on the connected agent, not in this process, so it
 * lives in `host-terminal.service` and not in the local registry. `POST .../input`
 * and `POST .../resize` were written against the local registry alone, so every
 * host session the caller could see in `GET /api/terminal/sessions` answered
 * 404 from them — while the WebSocket path, which branches on the same question,
 * worked. These tests drive the real routes with the two things a running
 * deployment supplies and a unit test cannot: an authenticated principal, and a
 * connected agent.
 *
 * The agent is a stub socket that answers each request the way the real one
 * does, `{ id, ok: true, result }`, and records what was asked of it — so a
 * frame that reaches the agent is asserted on, not merely a status code.
 */

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b2';
const SESSION_ID = '00000000-0000-4000-8000-0000000000c3';
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-0000000000d4';

vi.mock('../middleware/auth.js', () => ({
  authenticate: async (): Promise<void> => undefined,
  // The permission a route asks for is not what these tests are about; every
  // route under test is reached by the owner, who holds all of them.
  requirePermission: () => async (): Promise<void> => undefined,
  requirePrincipal: () => ({
    user: {
      id: '00000000-0000-4000-8000-0000000000b2',
      username: 'master',
      role: 'owner',
      permissions: [],
    },
    sessionId: '00000000-0000-4000-8000-0000000000e5',
  }),
}));

interface SentFrame {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

let app: FastifyInstance;
const sent: SentFrame[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  registerAgentSocket(AGENT_ID, {
    readyState: 1,
    OPEN: 1,
    send(raw: string): void {
      const frame = JSON.parse(raw) as SentFrame;
      sent.push(frame);

      // Answer the way the agent does. `terminal.create` has to return a
      // session the service accepts, which means at minimum an id.
      const result =
        frame.type === 'terminal.create'
          ? {
              id: SESSION_ID,
              pid: 4242,
              shell: '/bin/bash',
              cwd: '/',
              cols: 80,
              rows: 24,
              status: 'running',
            }
          : {};

      handleAgentFrame(AGENT_ID, { id: frame.id, ok: true, result });
    },
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sent.length = 0;
});

async function createHostSession(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/terminal/sessions',
    payload: { scope: 'host', agentId: AGENT_ID, cols: 80, rows: 24 },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

function lastFrameOfType(type: string): SentFrame | undefined {
  return sent.filter((frame) => frame.type === type).pop();
}

describe('host terminal sessions over REST', () => {
  it('creates the session on the agent, not in this process', async () => {
    const id = await createHostSession();

    expect(id).toBe(SESSION_ID);
    expect(lastFrameOfType('terminal.create')?.params).toMatchObject({ cols: 80, rows: 24 });
  });

  it('reports the session it created', async () => {
    await createHostSession();

    const response = await app.inject({ method: 'GET', url: `/api/terminal/sessions/${SESSION_ID}` });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { id: string } }).data.id).toBe(SESSION_ID);
  });

  it('forwards input to the agent instead of 404ing on its own session', async () => {
    await createHostSession();

    const response = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${SESSION_ID}/input`,
      payload: { data: 'echo hello\n' },
    });

    expect(response.statusCode).toBe(204);
    expect(lastFrameOfType('terminal.input')?.params).toMatchObject({
      id: SESSION_ID,
      data: 'echo hello\n',
    });
  });

  it('forwards a resize to the agent', async () => {
    await createHostSession();

    const response = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${SESSION_ID}/resize`,
      payload: { cols: 120, rows: 40 },
    });

    expect(response.statusCode).toBe(204);
    expect(lastFrameOfType('terminal.resize')?.params).toMatchObject({
      id: SESSION_ID,
      cols: 120,
      rows: 40,
    });
  });

  it('still reports a session nobody owns as not found', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/terminal/sessions/${UNKNOWN_SESSION_ID}/input`,
      payload: { data: 'echo hello\n' },
    });

    expect(response.statusCode).toBe(404);
    expect(sent.some((frame) => frame.type === 'terminal.input')).toBe(false);
  });
});
