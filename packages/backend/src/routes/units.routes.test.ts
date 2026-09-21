import { DEFAULT_EXECUTION_UNIT_LIMITS } from '@aether/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';
import { handleAgentFrame, registerAgentSocket } from '../services/agent-rpc.service.js';

import type { FastifyInstance } from 'fastify';

/**
 * The units REST surface: the two authorization decisions that are the route's
 * own, and the lifecycle verbs end to end.
 *
 * The static `execution:*` guards on each route are ordinary Fastify
 * pre-handlers, identical in mechanism to every other guarded route and proven
 * by `auth`'s own tests, so they are mocked away here. What is *not* ordinary,
 * and what these tests exist for, are the two conditional checks that a static
 * guard cannot express and that therefore live in the handler:
 *
 * - `scope=all` on the list is a privileged view of everyone's units, refused
 *   unless the caller holds `execution:manage-others`.
 * - A limit above the instance default is refused unless the caller holds
 *   `execution:limits:raise` — before the unit is created, not after.
 *
 * Both read `principal.user.permissions`, so the principal is mutable per test.
 * A stub agent answers the way the real one does and records what it was asked,
 * so a forwarded frame is asserted on rather than merely a status code.
 */

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const UNIT_ID = '00000000-0000-4000-8000-0000000000d1';

const { principal } = vi.hoisted(() => ({
  principal: {
    user: {
      id: '00000000-0000-4000-8000-0000000000b2',
      username: 'master',
      role: 'owner' as const,
      permissions: [] as string[],
    },
    sessionId: '00000000-0000-4000-8000-0000000000e5',
  },
}));

vi.mock('../middleware/auth.js', () => ({
  authenticate: (): Promise<void> => Promise.resolve(),
  // The static permission guards are not this suite's subject; the conditional
  // checks in the handlers read `principal.user.permissions` directly.
  requirePermission: () => (): Promise<void> => Promise.resolve(),
  requirePrincipal: () => principal,
}));

// The audit writes go to the DB; this suite is about authorization, not the
// audit trail (covered where the audit service is tested), so they are stubbed.
vi.mock('../services/audit.service.js', () => ({
  recordAuditEvent: (): Promise<void> => Promise.resolve(),
}));

// `createHostUnit` gates on `listAgents(ownerUserId)` — the DoD-#5 check that
// the caller may use the named agent — which would otherwise hit the database.
// The rest of the pairing service is preserved because the server registers its
// pair/revoke routes at build time; only the list is stubbed, and it answers
// that this principal may use AGENT_ID.
vi.mock('../services/agent-pairing.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agent-pairing.service.js')>();
  return {
    ...actual,
    listAgents: (ownerUserId: string) =>
      Promise.resolve([
        {
          agentId: '00000000-0000-4000-8000-0000000000a1',
          label: 'stub',
          ownerUserId,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
  };
});

interface SentFrame {
  id: string;
  type: string;
  ownerUserId?: string;
  params?: Record<string, unknown>;
}

let app: FastifyInstance;
const sent: SentFrame[] = [];

function unitRecord(id: string, ownerUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerUserId,
    kind: 'command',
    state: 'running',
    process: { pid: 4242, pgid: 4242, startedAt: '2026-01-01T00:00:00.000Z' },
    exit: null,
    spec: { cwd: '/', shell: '/bin/bash' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
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
      const owner = frame.ownerUserId ?? 'paired-fallback';

      let result: unknown = {};
      switch (frame.type) {
        case 'units.create':
          result = unitRecord(UNIT_ID, owner, { kind: frame.params?.kind ?? 'command' });
          break;
        case 'units.list':
          result = { units: [unitRecord(UNIT_ID, owner)] };
          break;
        case 'units.get':
          result = { unit: unitRecord(String(frame.params?.id), owner) };
          break;
        case 'units.signal':
          result = { delivered: true, escalated: false };
          break;
        case 'units.kill':
          result = { killed: true };
          break;
        case 'units.restart':
          result = { unit: unitRecord(String(frame.params?.id), owner, { pid: 5555 }) };
          break;
        case 'units.log':
          result = {
            contentBase64: Buffer.from('out', 'utf8').toString('base64'),
            offset: 0,
            retainedBytes: 3,
            droppedBytes: 0,
            totalBytes: 3,
            ended: false,
          };
          break;
        default:
          result = {};
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
  principal.user.permissions = [];
});

function lastFrameOfType(type: string): SentFrame | undefined {
  return sent.filter((frame) => frame.type === type).pop();
}

describe('scope=all is gated by execution:manage-others', () => {
  it('refuses an unfiltered list without the permission — and never asks the agent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/units?agentId=${AGENT_ID}&scope=all`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    // The refusal happens before the round-trip: an unfiltered list must not
    // reach the agent even to be discarded.
    expect(sent.some((frame) => frame.type === 'units.list')).toBe(false);
  });

  it('allows an unfiltered list with the permission and forwards scope=all', async () => {
    principal.user.permissions = ['execution:manage-others'];

    const response = await app.inject({
      method: 'GET',
      url: `/api/units?agentId=${AGENT_ID}&scope=all`,
    });

    expect(response.statusCode).toBe(200);
    expect(lastFrameOfType('units.list')?.params?.scope).toBe('all');
  });

  it("lists the caller's own units without any special permission", async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/units?agentId=${AGENT_ID}&scope=mine`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { total: number } }>().data.total).toBe(1);
    expect(lastFrameOfType('units.list')?.params?.scope).toBe('mine');
  });
});

describe('raised limits are gated by execution:limits:raise', () => {
  it('refuses a bigger output ring without the permission — before creating anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    expect(sent.some((frame) => frame.type === 'units.create')).toBe(false);
  });

  it('creates a unit within the defaults without the permission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: { agentId: AGENT_ID, kind: 'command', command: 'echo hi' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ data: { unit: { id: string } } }>().data.unit.id).toBe(UNIT_ID);
    expect(lastFrameOfType('units.create')?.ownerUserId).toBe(principal.user.id);
  });

  it('creates with a raised ring when the caller holds the permission', async () => {
    principal.user.permissions = ['execution:limits:raise'];

    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(lastFrameOfType('units.create')?.params?.maxOutputBytes).toBe(
      DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2
    );
  });
});

describe('the lifecycle verbs reach the right host and unit', () => {
  it('gets, signals, restarts, kills and reads the log of a unit on its host', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `/api/units/${UNIT_ID}?agentId=${AGENT_ID}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ data: { unit: { id: string } } }>().data.unit.id).toBe(UNIT_ID);

    const signal = await app.inject({
      method: 'POST',
      url: `/api/units/${UNIT_ID}/signal?agentId=${AGENT_ID}`,
      payload: { signal: 'SIGTERM' },
    });
    expect(signal.statusCode).toBe(200);
    expect(signal.json<{ data: { delivered: boolean } }>().data.delivered).toBe(true);
    expect(lastFrameOfType('units.signal')?.params).toMatchObject({
      id: UNIT_ID,
      signal: 'SIGTERM',
    });

    const restart = await app.inject({
      method: 'POST',
      url: `/api/units/${UNIT_ID}/restart?agentId=${AGENT_ID}`,
    });
    expect(restart.statusCode).toBe(200);
    expect(lastFrameOfType('units.restart')?.params?.id).toBe(UNIT_ID);

    const log = await app.inject({
      method: 'GET',
      url: `/api/units/${UNIT_ID}/log?agentId=${AGENT_ID}`,
    });
    expect(log.statusCode).toBe(200);
    const decoded = Buffer.from(
      log.json<{ data: { contentBase64: string } }>().data.contentBase64,
      'base64'
    ).toString('utf8');
    expect(decoded).toBe('out');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/units/${UNIT_ID}?agentId=${AGENT_ID}`,
    });
    expect(del.statusCode).toBe(204);
    expect(lastFrameOfType('units.kill')?.params?.id).toBe(UNIT_ID);
  });

  it('rejects a request that names no host', async () => {
    // Every single-unit route needs `?agentId=`, because the backend keeps no
    // unit bookkeeping to infer it from. A missing one is a 400, not a guess.
    const response = await app.inject({ method: 'GET', url: `/api/units/${UNIT_ID}` });
    expect(response.statusCode).toBe(400);
  });
});
