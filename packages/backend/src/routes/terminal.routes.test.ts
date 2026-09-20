import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';
import { handleAgentFrame, registerAgentSocket } from '../services/agent-rpc.service.js';

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
const SESSION_ID = '00000000-0000-4000-8000-0000000000c3';
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-0000000000d4';

// The ids are literals rather than the constants above because `vi.mock` is
// hoisted above them: a factory that reads one would run before it is
// initialised.
vi.mock('../middleware/auth.js', () => ({
  authenticate: (): Promise<void> => Promise.resolve(),
  // The permission a route asks for is not what these tests are about; every
  // route under test is reached by the owner, who holds all of them.
  requirePermission: () => (): Promise<void> => Promise.resolve(),
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

interface AgentSession {
  id: string;
  pid: number | null;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  status: string;
  exitCode: number | null;
  createdAt: string;
  lastActivityAt: string;
  attachedClients: number;
}

let app: FastifyInstance;
const sent: SentFrame[] = [];

// What the stub agent has. It is the authority on the PTYs it owns, so the
// backend's session list is only truthful to the extent that it is asked.
let agentSessions: AgentSession[] = [];
let listFails = false;

function sessionRecord(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: SESSION_ID,
    pid: 4242,
    shell: '/bin/bash',
    cwd: '/',
    cols: 80,
    rows: 24,
    status: 'running',
    exitCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    attachedClients: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  registerAgentSocket(AGENT_ID, {
    readyState: 1,
    OPEN: 1,
    send(raw: string): void {
      const frame = JSON.parse(raw) as SentFrame;
      sent.push(frame);

      // Answer the way the agent does: `terminal.create` returns the session it
      // made, `terminal.list` returns what it still has, `terminal.kill` ends one.
      if (listFails && frame.type === 'terminal.list') {
        handleAgentFrame(AGENT_ID, {
          id: frame.id,
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'agent is having a bad day' },
        });
        return;
      }

      let result: unknown = {};
      if (frame.type === 'terminal.create') {
        const session = sessionRecord();
        agentSessions = [session];
        result = session;
      } else if (frame.type === 'terminal.list') {
        result = { sessions: agentSessions };
      } else if (frame.type === 'terminal.kill') {
        agentSessions = [];
        result = { killed: true };
      }

      handleAgentFrame(AGENT_ID, { id: frame.id, ok: true, result });
    },
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sent.length = 0;
  agentSessions = [];
  listFails = false;
});

async function createHostSession(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/terminal/sessions',
    payload: { scope: 'host', agentId: AGENT_ID, cols: 80, rows: 24 },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { id: string } }>().data.id;
}

function lastFrameOfType(type: string): SentFrame | undefined {
  return sent.filter((frame) => frame.type === type).pop();
}

interface ListedSession {
  id: string;
  status: string;
  exitCode: number | null;
}

/** The session list the API returns, which is what the caller is shown. */
async function listSessions(): Promise<ListedSession[]> {
  const response = await app.inject({ method: 'GET', url: '/api/terminal/sessions' });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { sessions: ListedSession[] } }>().data.sessions;
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
    expect(response.json<{ data: { id: string } }>().data.id).toBe(SESSION_ID);
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

/**
 * A host shell can end without anyone asking it to, and the agent is the only
 * party that knows: the record here is written once, from the create reply, and
 * nothing revised it. `GET /api/terminal/sessions` therefore reported a session
 * the user had already ended as running, for as long as the process lived.
 */
describe('session status is the agent\'s, not this process\'s', () => {
  it('lists a session it created', async () => {
    await createHostSession();

    expect((await listSessions()).map((session) => session.id)).toContain(SESSION_ID);
  });

  it('drops a session the agent no longer has', async () => {
    await createHostSession();
    expect((await listSessions()).map((session) => session.id)).toContain(SESSION_ID);

    // The shell exited and the agent forgot it — it deletes the record 30
    // seconds after an exit. It is not "running" and it is not there.
    agentSessions = [];

    expect((await listSessions()).map((session) => session.id)).not.toContain(SESSION_ID);
  });

  it('reports the status and exit code the agent reports', async () => {
    await createHostSession();
    agentSessions = [sessionRecord({ status: 'exited', exitCode: 0, pid: null })];

    const listed = (await listSessions()).find((session) => session.id === SESSION_ID);
    expect(listed?.status).toBe('exited');
    expect(listed?.exitCode).toBe(0);
  });

  it('tells the same story about one session as it does about the list', async () => {
    await createHostSession();
    agentSessions = [sessionRecord({ status: 'exited', exitCode: 130, pid: null })];

    const response = await app.inject({
      method: 'GET',
      url: `/api/terminal/sessions/${SESSION_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { status: string; exitCode: number | null } }>().data).toMatchObject(
      { status: 'exited', exitCode: 130 }
    );
  });

  it('leaves the record alone when the agent cannot answer', async () => {
    await createHostSession();
    listFails = true;

    // A backend that cannot ask must not invent an answer. The session stays, as
    // it was, rather than being reported dead because a request failed.
    const listed = (await listSessions()).find((session) => session.id === SESSION_ID);
    expect(listed?.status).toBe('running');
  });
});
