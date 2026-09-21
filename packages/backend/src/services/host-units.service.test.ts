import { DEFAULT_EXECUTION_UNIT_LIMITS, LIMITS } from '@aether/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleAgentFrame, registerAgentSocket, unregisterAgentSocket } from './agent-rpc.service.js';
import {
  assertMayUseRequestedLimits,
  createHostUnit,
  getHostUnit,
  killHostUnit,
  listHostUnits,
  readHostUnitLog,
  restartHostUnit,
  signalHostUnit,
} from './host-units.service.js';

import type { CreateUnitBody } from '@aether/shared';

/**
 * The backend half of the `units.*` surface: who it says it is acting for, what
 * it forwards, and what it refuses before the agent is ever asked.
 *
 * The two behaviours that matter here are both invisible from an HTTP status
 * code, so the stub agent records the frames it is sent and they are asserted
 * directly:
 *
 * 1. **Every request names the principal it is made for.** The agent keys its
 *    units on the owner it is given, and answers a unit belonging to someone
 *    else exactly as it answers one that does not exist. A request that named
 *    nobody would be answered as the agent's paired owner — one identity shared
 *    by every user of an instance-scoped local agent — so passing the principal
 *    is what makes the agent's own ownership check meaningful. This is the
 *    mirror of the `host-terminal.service` suite, for the units path.
 * 2. **A limit above the instance default is refused before the unit exists.**
 *    `assertMayUseRequestedLimits` is the `execution:limits:raise` gate, and it
 *    refuses rather than silently shrinking the request — the fake-success
 *    failure the honesty rule forbids.
 */

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';

// A distinct user per test keeps them independent of one another; nothing here
// resets shared module state, but each call is scoped to its own principal.
const USER_CREATE = '00000000-0000-4000-8000-0000000000b1';
const USER_LIST = '00000000-0000-4000-8000-0000000000b2';
const USER_GET = '00000000-0000-4000-8000-0000000000b3';
const USER_SIGNAL = '00000000-0000-4000-8000-0000000000b4';
const USER_RESTART = '00000000-0000-4000-8000-0000000000b5';
const USER_KILL = '00000000-0000-4000-8000-0000000000b6';
const USER_LOG = '00000000-0000-4000-8000-0000000000b7';

const UNIT_ID = '00000000-0000-4000-8000-0000000000d1';

interface SentFrame {
  id: string;
  type: string;
  ownerUserId?: string;
  params?: Record<string, unknown>;
}

const sent: SentFrame[] = [];

/** A minimal but shape-valid unit, enough for the service's own guards. */
function unitRecord(id: string, ownerUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerUserId,
    kind: 'command',
    state: 'running',
    process: { pid: 4242, pgid: 4242, startedAt: '2026-01-01T00:00:00.000Z' },
    exit: null,
    ...overrides,
  };
}

/**
 * Installs a stub agent that answers each `units.*` verb the way the real one
 * does — the bare unit for `create`, `{ unit }` for `get`/`restart`,
 * `{ units }` for `list`, `{ delivered, escalated }` for `signal`,
 * `{ killed }` for `kill`, and the log record for `log`.
 */
function connectAgent(agentId: string): void {
  registerAgentSocket(agentId, {
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
          result = { delivered: true, escalated: frame.params?.signal === 'SIGKILL' };
          break;
        case 'units.kill':
          result = { killed: true };
          break;
        case 'units.restart':
          result = { unit: unitRecord(String(frame.params?.id), owner, { pid: 5555 }) };
          break;
        case 'units.log':
          result = {
            contentBase64: Buffer.from('output', 'utf8').toString('base64'),
            offset: Number(frame.params?.offset ?? 0),
            retainedBytes: 6,
            droppedBytes: 0,
            totalBytes: 6,
            ended: false,
          };
          break;
        default:
          result = {};
      }

      handleAgentFrame(agentId, { id: frame.id, ok: true, result });
    },
  });
}

function lastFrameOfType(type: string): SentFrame | undefined {
  return sent.filter((frame) => frame.type === type).at(-1);
}

function baseCreateBody(overrides: Partial<CreateUnitBody> = {}): CreateUnitBody {
  return {
    agentId: AGENT_ID,
    kind: 'command',
    command: 'echo hi',
    cols: 80,
    rows: 24,
    wallClockMs: null,
    graceMs: 5_000,
    maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes,
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  connectAgent(AGENT_ID);
});

describe('every request to an agent names the user it is made for', () => {
  it('names the user on units.create and forwards the spec', async () => {
    const unit = await createHostUnit(USER_CREATE, baseCreateBody({ command: 'echo hi' }));

    expect(unit.id).toBe(UNIT_ID);
    const frame = lastFrameOfType('units.create');
    expect(frame?.ownerUserId).toBe(USER_CREATE);
    expect(frame?.params?.command).toBe('echo hi');
    expect(frame?.params?.kind).toBe('command');
  });

  it('names the user on list, get, signal, restart, kill and log', async () => {
    await listHostUnits(AGENT_ID, USER_LIST, 'mine');
    await getHostUnit(AGENT_ID, UNIT_ID, USER_GET);
    await signalHostUnit(AGENT_ID, UNIT_ID, USER_SIGNAL, 'SIGTERM', null);
    await restartHostUnit(AGENT_ID, UNIT_ID, USER_RESTART);
    await killHostUnit(AGENT_ID, UNIT_ID, USER_KILL);
    await readHostUnitLog(AGENT_ID, UNIT_ID, USER_LOG, {
      offset: 0,
      limit: 1024,
      stream: 'combined',
    });

    expect(lastFrameOfType('units.list')?.ownerUserId).toBe(USER_LIST);
    expect(lastFrameOfType('units.get')?.ownerUserId).toBe(USER_GET);
    expect(lastFrameOfType('units.signal')?.ownerUserId).toBe(USER_SIGNAL);
    expect(lastFrameOfType('units.restart')?.ownerUserId).toBe(USER_RESTART);
    expect(lastFrameOfType('units.kill')?.ownerUserId).toBe(USER_KILL);
    expect(lastFrameOfType('units.log')?.ownerUserId).toBe(USER_LOG);
  });

  it('forwards scope=all as the absence of an owner filter', async () => {
    // The permission that legitimises `all` is the route's to check; the service
    // only carries the scope through. What matters here is that it is forwarded
    // verbatim so the agent drops its owner filter.
    await listHostUnits(AGENT_ID, USER_LIST, 'all');
    expect(lastFrameOfType('units.list')?.params?.scope).toBe('all');

    await listHostUnits(AGENT_ID, USER_LIST, 'mine');
    expect(lastFrameOfType('units.list')?.params?.scope).toBe('mine');
  });
});

describe('reply parsing', () => {
  it('reports the list total and echoes nothing it was not told', async () => {
    const units = await listHostUnits(AGENT_ID, USER_LIST, 'mine');
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe(UNIT_ID);
  });

  it('reports delivered and escalated from a signal', async () => {
    const polite = await signalHostUnit(AGENT_ID, UNIT_ID, USER_SIGNAL, 'SIGTERM', null);
    expect(polite).toEqual({ delivered: true, escalated: false });

    const forced = await signalHostUnit(AGENT_ID, UNIT_ID, USER_SIGNAL, 'SIGKILL', null);
    expect(forced.escalated).toBe(true);
  });

  it('reports whether a unit was ended', async () => {
    expect(await killHostUnit(AGENT_ID, UNIT_ID, USER_KILL)).toBe(true);
  });

  it('decodes a log read', async () => {
    const read = await readHostUnitLog(AGENT_ID, UNIT_ID, USER_LOG, {
      offset: 0,
      limit: 1024,
      stream: 'combined',
    });
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toBe('output');
    expect(read.ended).toBe(false);
    expect(read.retainedBytes).toBe(6);
  });
});

describe('a disconnected agent is reported, never faked', () => {
  it('refuses every verb with a service error when the agent is not connected', async () => {
    // OTHER_AGENT was never registered — the request has nowhere to go, and that
    // must surface as a failure, not an empty success.
    await expect(listHostUnits(OTHER_AGENT, USER_LIST, 'mine')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 503,
    });
    await expect(createHostUnit(USER_CREATE, baseCreateBody({ agentId: OTHER_AGENT }))).rejects.toThrow();
  });

  it('reports an agent that disconnects mid-life', async () => {
    unregisterAgentSocket(AGENT_ID, { readyState: 1, OPEN: 1, send: () => undefined });
    // The socket object identity differs, so the unregister is a no-op guard —
    // re-register a closed socket to prove the connected check is real.
    registerAgentSocket(AGENT_ID, { readyState: 3, OPEN: 1, send: () => undefined });
    await expect(getHostUnit(AGENT_ID, UNIT_ID, USER_GET)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe('the execution:limits:raise gate', () => {
  const withinDefaults = {
    maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes,
    restart: { policy: 'never' as const, maxAttempts: 0, backoffMs: 1_000 },
  };

  it('allows a request within the instance defaults without the permission', () => {
    expect(() => assertMayUseRequestedLimits(withinDefaults, false)).not.toThrow();
  });

  it('refuses a bigger output ring without the permission', () => {
    expect(() =>
      assertMayUseRequestedLimits(
        { ...withinDefaults, maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes + 1 },
        false
      )
    ).toThrowError(/execution:limits:raise/);
  });

  it('refuses a higher restart ceiling without the permission', () => {
    expect(() =>
      assertMayUseRequestedLimits(
        {
          maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes,
          restart: {
            policy: 'on-failure',
            maxAttempts: LIMITS.EXECUTION_UNIT_MAX_RESTART_ATTEMPTS + 1,
            backoffMs: 1_000,
          },
        },
        false
      )
    ).toThrowError(/execution:limits:raise/);
  });

  it('allows raised limits when the caller holds the permission', () => {
    expect(() =>
      assertMayUseRequestedLimits(
        {
          maxOutputBytes: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes * 4,
          restart: {
            policy: 'always',
            maxAttempts: LIMITS.EXECUTION_UNIT_MAX_RESTART_ATTEMPTS + 5,
            backoffMs: 1_000,
          },
        },
        true
      )
    ).not.toThrow();
  });
});
