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

// Hoist everything a vi.mock factory references so initialization order is safe.
const { principal, recordedAuditEvents, ids, createUnitCalls } = vi.hoisted(() => ({
  principal: {
    user: {
      id: '00000000-0000-4000-8000-0000000000b2',
      username: 'master',
      role: 'owner' as const,
      permissions: [] as string[],
    },
    sessionId: '00000000-0000-4000-8000-0000000000e5',
  },
  recordedAuditEvents: [] as Array<{
    action: string;
    target: string;
    metadata: Record<string, unknown>;
  }>,
  ids: {
    AGENT_ID: '00000000-0000-4000-8000-0000000000a1',
    UNIT_ID: '00000000-0000-4000-8000-0000000000d1',
  },
  /**
   * Every `createHostUnit` the route made, in order.
   *
   * The service is mocked here, so the frame the *agent* would have received
   * never exists in this suite — asserting on `sent` for a create would be
   * asserting on something the mock guarantees is empty. What the route's own
   * decision is, though, is exactly what it hands the service, so that is what
   * these tests read.
   */
  createUnitCalls: [] as Array<{ ownerUserId: string; body: Record<string, unknown> }>,
}));

const AGENT_ID = ids.AGENT_ID;
const UNIT_ID = ids.UNIT_ID;

vi.mock('../middleware/auth.js', () => ({
  authenticate: (): Promise<void> => Promise.resolve(),
  // The static permission guards are not this suite's subject; the conditional
  // checks in the handlers read `principal.user.permissions` directly.
  requirePermission: () => (): Promise<void> => Promise.resolve(),
  requirePrincipal: () => principal,
}));

// The audit writes go to the DB; this suite is about authorization, not the
// audit trail (covered where the audit service is tested), so they are stubbed.
// `recordedAuditEvents` is shared so individual tests can assert the calls.
vi.mock('../services/audit.service.js', () => ({
  recordAuditEvent: (event: {
    action: string;
    target: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    recordedAuditEvents.push({
      action: event.action,
      target: event.target,
      metadata: event.metadata ?? {},
    });
    return Promise.resolve();
  },
}));

// createHostUnit is mocked directly so we control the unit record returned.
// createHostUnit's own logic (assertMayUseAgent gate, the #5 check) is tested
// separately in host-units.service.test.ts. This suite tests the route handler's
// own decisions: limits, audit events, and the lifecycle verbs.
vi.mock('../services/host-units.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/host-units.service.js')>();
  return {
    ...actual,
    createHostUnit: (ownerUserId: string, body: Record<string, unknown>) => {
      createUnitCalls.push({ ownerUserId, body });
      const bodyRlimits = (body as { rlimits?: Record<string, number | null> }).rlimits;
      return Promise.resolve({
        id: ids.UNIT_ID,
        ownerUserId,
        kind: (body as { kind?: string }).kind ?? 'command',
        state: 'running',
        process: { pid: 4242, pgid: 4242, startedAt: '2026-01-01T00:00:00.000Z' },
        exit: null,
        limits: {
          wallClockMs: (body as { wallClockMs?: number | null }).wallClockMs ?? null,
          graceMs: 5000,
          maxOutputBytes: (body as { maxOutputBytes?: number }).maxOutputBytes ?? 262144,
          addressSpaceBytes: bodyRlimits?.addressSpaceBytes ?? null,
          cpuSeconds: bodyRlimits?.cpuSeconds ?? null,
          maxOpenFiles: bodyRlimits?.maxOpenFiles ?? null,
          coreDumpBytes: bodyRlimits?.coreDumpBytes ?? null,
          // The route reads this back into the audit metadata; the real agent
          // sets it from the platform, and nothing in this suite spawns one.
          enforced: false,
          exceeded: null,
        },
        restart: {
          policy: 'never',
          maxAttempts: 0,
          backoffMs: 1000,
          attempts: 0,
        },
        spec: {
          kind: 'command',
          shell: '/bin/bash',
          cwd: '/',
          env: {},
          tty: false,
          cols: null,
          rows: null,
          term: null,
          logMode: 'pipe',
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        agentId: ids.AGENT_ID,
        requestId: (body as { requestId?: string }).requestId ?? null,
        log: { mode: 'pipe', retainedBytes: 0, droppedBytes: 0, totalBytes: 0 },
      });
    },
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
  recordedAuditEvents.length = 0;
  createUnitCalls.length = 0;
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
    // Refused before the unit was created, not after: the service was never
    // reached. (`sent` would be empty either way here — the service is mocked —
    // so the check has to be on the call the route did or did not make.)
    expect(createUnitCalls).toHaveLength(0);
  });

  it('creates a unit within the defaults without the permission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: { agentId: AGENT_ID, kind: 'command', command: 'echo hi' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ data: { unit: { id: string } } }>().data.unit.id).toBe(UNIT_ID);
    // The principal travels with the create, which is what makes the agent's own
    // ownership check meaningful.
    expect(createUnitCalls.at(-1)?.ownerUserId).toBe(principal.user.id);
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
        // explicitly null wallClockMs to match default
        wallClockMs: null,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createUnitCalls.at(-1)?.body?.maxOutputBytes).toBe(
      DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2
    );
  });
});

describe('the lifecycle audit events are recorded correctly (DoD #13)', () => {
  // Audit events are the only non-trivial output of the lifecycle routes that is
  // invisible from the HTTP status. Each test creates a unit (or uses the stub
  // agent's reply) and asserts the audit event that results — the DB write itself
  // is stubbed, so we assert the call arguments rather than a DB row.

  it('records unit.created on a successful create', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: { agentId: AGENT_ID, kind: 'command', command: 'echo hi' },
    });
    expect(response.statusCode).toBe(201);

    const created = recordedAuditEvents.find((e) => e.action === 'unit.created');
    expect(created).toBeDefined();
    expect(created?.target).toBe(UNIT_ID);
    expect(created?.metadata).toMatchObject({
      agentId: AGENT_ID,
      kind: 'command',
    });
  });

  it('records unit.limits-applied when non-default limits are requested', async () => {
    // Needs execution:limits:raise to request a bigger ring; the route's
    // assertMayUseRequestedLimits refuses above-default limits without it.
    principal.user.permissions = ['execution:limits:raise'];

    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        wallClockMs: 60_000,
        maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2,
      },
    });
    expect(response.statusCode).toBe(201);

    const limitsEvent = recordedAuditEvents.find((e) => e.action === 'unit.limits-applied');
    expect(limitsEvent).toBeDefined();
    expect(limitsEvent?.target).toBe(UNIT_ID);
    expect(limitsEvent?.metadata).toMatchObject({
      agentId: AGENT_ID,
      requested: {
        wallClockMs: 60_000,
        maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 2,
        restartPolicy: 'never',
        restartMaxAttempts: 0,
      },
      usedRaisePermission: true,
    });
  });

  it('records usedRaisePermission:true when execution:limits:raise is held and non-default limits are used', async () => {
    principal.user.permissions = ['execution:limits:raise'];

    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 4,
        wallClockMs: null,
      },
    });
    expect(response.statusCode).toBe(201);

    const limitsEvent = recordedAuditEvents.find((e) => e.action === 'unit.limits-applied');
    expect(limitsEvent).toBeDefined();
    expect(limitsEvent?.metadata).toMatchObject({ usedRaisePermission: true });
  });

  it('records the requested rlimits and whether the host enforced them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        // No permission needed: an rlimit is a *bound* on the caller's own
        // process, not a claim on a shared host resource, so the defaults gate
        // does not apply to it.
        rlimits: { addressSpaceBytes: 256 * 1024 * 1024, maxOpenFiles: 128 },
      },
    });
    expect(response.statusCode).toBe(201);

    const limitsEvent = recordedAuditEvents.find((e) => e.action === 'unit.limits-applied');
    expect(limitsEvent).toBeDefined();
    expect(limitsEvent?.metadata).toMatchObject({
      requested: {
        rlimits: {
          addressSpaceBytes: 256 * 1024 * 1024,
          cpuSeconds: null,
          maxOpenFiles: 128,
          coreDumpBytes: null,
        },
      },
      // The route must not claim a bound is in force. `enforced` is what the
      // agent reported, and the audit carries it through verbatim.
      effective: {
        rlimits: { enforced: false },
      },
    });
  });

  it('does NOT record unit.limits-applied for a default-shaped rlimit request', async () => {
    // Every field null is the same as asking for nothing, and the audit exists
    // to record limit *changes* — an all-null object is not one.
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: {
        agentId: AGENT_ID,
        kind: 'command',
        command: 'echo hi',
        rlimits: {},
      },
    });
    expect(response.statusCode).toBe(201);
    expect(recordedAuditEvents.some((e) => e.action === 'unit.limits-applied')).toBe(false);
  });

  it('does NOT record unit.limits-applied when all limits are at defaults', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/units',
      payload: { agentId: AGENT_ID, kind: 'command', command: 'echo hi' },
    });
    expect(response.statusCode).toBe(201);

    const limitsEvent = recordedAuditEvents.find((e) => e.action === 'unit.limits-applied');
    expect(limitsEvent).toBeUndefined();
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
