import { DEFAULT_EXECUTION_UNIT_LIMITS, LIMITS } from '@aether/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleAgentFrame,
  registerAgentSocket,
  unregisterAgentSocket,
} from './agent-rpc.service.js';
import {
  assertMayUseRequestedLimits,
  createHostUnit,
  getHostUnit,
  killHostUnit,
  listHostUnits,
  readHostUnitLog,
  restartHostUnit,
  signalHostUnit,
  subscribeHostUnit,
  toUnitServerMessage,
  resetUnitStreamsForTests,
} from './host-units.service.js';

import type { CreateUnitBody } from '@aether/shared';

// `createHostUnit` gates on `listAgents(ownerUserId)` — the DoD-#5 check that
// the caller may use the named agent — so the pairing service is mocked to a
// controllable allow-set rather than reaching the database. `agentsForUser`
// returns the agent ids each user is allowed to use; a user absent from the map
// is allowed nothing, which is what the cross-user regression below asserts.
const { agentsForUser } = vi.hoisted(() => ({
  agentsForUser: new Map<string, string[]>(),
}));

vi.mock('./agent-pairing.service.js', () => ({
  listAgents: (ownerUserId: string) =>
    Promise.resolve(
      (agentsForUser.get(ownerUserId) ?? []).map((agentId) => ({
        agentId,
        label: 'stub',
        ownerUserId,
        createdAt: '2026-01-01T00:00:00.000Z',
      }))
    ),
}));

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
  /**
   * The subscribe/unsubscribe channels name their target at the top level, not
   * under `params` — `units.subscribe` puts `unitId` there and the terminal
   * channel predates it and puts `sessionId` there. The agent reads the field
   * its channel uses, so a test that looked under `params` would pass while the
   * real agent refused the frame.
   */
  unitId?: string;
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
  resetUnitStreamsForTests();
  connectAgent(AGENT_ID);
  // Every user in the existing suite is allowed both agents, so the DoD-#5 gate
  // passes and each test exercises what it was written to — the disconnected
  // case still reaches `requireConnected` rather than tripping the gate first.
  agentsForUser.clear();
  for (const user of [
    USER_CREATE,
    USER_LIST,
    USER_GET,
    USER_SIGNAL,
    USER_RESTART,
    USER_KILL,
    USER_LOG,
  ]) {
    agentsForUser.set(user, [AGENT_ID, OTHER_AGENT]);
  }
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
    await expect(
      createHostUnit(USER_CREATE, baseCreateBody({ agentId: OTHER_AGENT }))
    ).rejects.toThrow();
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

describe('creating a unit is refused on an agent the caller may not use (DoD #5)', () => {
  // A stranger who never paired AGENT_ID and cannot see it in listAgents. The
  // agent is connected and healthy — the only thing standing between this user
  // and a process on someone else's machine is the create-path authorization
  // gate, so the agent must never be asked.
  const STRANGER = '00000000-0000-4000-8000-0000000000c9';

  it('refuses with a 404, indistinguishable from an agent that does not exist', async () => {
    agentsForUser.set(STRANGER, []);

    await expect(createHostUnit(STRANGER, baseCreateBody())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('never sends a create frame to the agent when the caller may not use it', async () => {
    agentsForUser.set(STRANGER, []);

    await expect(createHostUnit(STRANGER, baseCreateBody())).rejects.toBeDefined();
    // The gate is checked before `requireConnected` and before any RPC, so a
    // rejected caller leaves no trace on the wire — the process is never spawned.
    expect(lastFrameOfType('units.create')).toBeUndefined();
  });

  it('refuses even an agent the caller can partly see but was not granted', async () => {
    // The stranger is allowed OTHER_AGENT but asks to create on AGENT_ID: being
    // allowed *an* agent is not being allowed *this* one.
    agentsForUser.set(STRANGER, [OTHER_AGENT]);

    await expect(
      createHostUnit(STRANGER, baseCreateBody({ agentId: AGENT_ID }))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(lastFrameOfType('units.create')).toBeUndefined();
  });

  it("allows the create once the agent is in the caller's allow-set", async () => {
    // The same stranger, now granted the agent, gets through the gate — proving
    // the refusal above is the gate doing its job, not a blanket denial.
    agentsForUser.set(STRANGER, [AGENT_ID]);

    const unit = await createHostUnit(STRANGER, baseCreateBody());
    expect(unit.id).toBe(UNIT_ID);
    expect(lastFrameOfType('units.create')?.ownerUserId).toBe(STRANGER);
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

describe('the unit stream is narrowed at the RPC boundary', () => {
  // The agent is a separate process reached over a socket. These are the four
  // event shapes it emits, and everything else — a shape this build does not
  // model, a field of the wrong type — must not reach a browser on faith.

  it('forwards output with the stream it came from', () => {
    expect(toUnitServerMessage({ type: 'output', data: 'hi\n', stream: 'stderr' })).toEqual({
      type: 'output',
      data: 'hi\n',
      stream: 'stderr',
    });
  });

  it('treats an unstated stream as stdout rather than dropping the output', () => {
    // Losing output because a selector was missing would be worse than naming
    // the default: the bytes are real either way.
    expect(toUnitServerMessage({ type: 'output', data: 'x' })).toEqual({
      type: 'output',
      data: 'x',
      stream: 'stdout',
    });
  });

  it('forwards an exit with the normalized status a shell would report', () => {
    expect(
      toUnitServerMessage({
        type: 'exit',
        exitCode: null,
        signal: 15,
        normalized: 143,
        state: 'failed',
      })
    ).toEqual({ type: 'exit', exitCode: null, signal: 15, normalized: 143, state: 'failed' });
  });

  it('forwards a state change and a restart attempt', () => {
    expect(toUnitServerMessage({ type: 'state', state: 'stale' })).toEqual({
      type: 'state',
      state: 'stale',
    });
    expect(toUnitServerMessage({ type: 'restart', attempt: 2 })).toEqual({
      type: 'restart',
      attempt: 2,
    });
  });

  it('drops an event shape this build does not model', () => {
    // The point of the guard: a future agent event is invisible until it is
    // deliberately carried, instead of arriving in browsers that cannot read it.
    expect(toUnitServerMessage({ type: 'metrics', cpu: 0.9 })).toBeNull();
  });

  it('drops a malformed event instead of forwarding half of it', () => {
    expect(toUnitServerMessage({ type: 'output', data: 42 })).toBeNull();
    expect(toUnitServerMessage({ type: 'state', state: 'melted' })).toBeNull();
    expect(toUnitServerMessage({ type: 'exit', state: 'exited' })).toBeNull();
    expect(toUnitServerMessage(null)).toBeNull();
    expect(toUnitServerMessage('state')).toBeNull();
  });
});

describe('subscribing to a unit stream', () => {
  it('reads the unit before subscribing, and names the owner on both', async () => {
    const subscription = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);

    expect(subscription.unit.id).toBe(UNIT_ID);
    // The principal goes on the subscribe as well as the read: the agent checks
    // it against the unit's owner, so a subscribe that named nobody would
    // silently succeed as the agent's paired owner.
    expect(sent.map((frame) => frame.type)).toEqual(['units.get', 'units.subscribe']);
    expect(lastFrameOfType('units.subscribe')?.ownerUserId).toBe(USER_GET);
    expect(lastFrameOfType('units.subscribe')?.unitId).toBe(UNIT_ID);

    // Live streams outlive a single call, so a test that opens one closes it.
    subscription.unsubscribe();
  });

  it('routes a live agent event to the caller', async () => {
    const seen: unknown[] = [];
    const subscription = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (message) =>
      seen.push(message)
    );

    handleAgentFrame(AGENT_ID, {
      type: 'unit.event',
      unitId: UNIT_ID,
      event: { type: 'output', data: 'live\n', stream: 'pty' },
    });

    expect(seen).toEqual([{ type: 'output', data: 'live\n', stream: 'pty' }]);
    subscription.unsubscribe();
  });

  it('drops an event for a unit nobody subscribed to', async () => {
    const seen: unknown[] = [];
    const subscription = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (message) =>
      seen.push(message)
    );

    handleAgentFrame(AGENT_ID, {
      type: 'unit.event',
      unitId: '00000000-0000-4000-8000-0000000000d9',
      event: { type: 'output', data: 'other\n', stream: 'stdout' },
    });

    expect(seen).toEqual([]);
    subscription.unsubscribe();
  });

  it('tells the agent to stop streaming when the subscriber detaches', async () => {
    const subscription = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    subscription.unsubscribe();

    expect(lastFrameOfType('units.unsubscribe')?.unitId).toBe(UNIT_ID);
  });

  it('does not subscribe at all when the unit is not the caller\'s to stream', async () => {
    registerAgentSocket(OTHER_AGENT, {
      readyState: 1,
      OPEN: 1,
      send(raw: string): void {
        const frame = JSON.parse(raw) as SentFrame;
        sent.push(frame);
        handleAgentFrame(OTHER_AGENT, {
          id: frame.id,
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Unit not found' },
        });
      },
    });

    await expect(
      subscribeHostUnit(OTHER_AGENT, UNIT_ID, USER_GET, () => undefined)
    ).rejects.toThrowError(/not found/i);

    // The refusal happens on the read, so no stream was ever opened: a caller
    // who may not see a unit must not be left holding part of its output.
    expect(lastFrameOfType('units.subscribe')).toBeUndefined();
  });
});

describe('several viewers of one unit share a single agent subscription', () => {
  // The agent keeps one subscription per unit and replaces it on each
  // `units.subscribe`, replaying the output again as it does. So a second attach
  // that simply asked again would hand the first viewer the whole stream twice
  // and, when either viewer left, stop the stream for both — a viewer that
  // believes it is attached and receives nothing.

  it('subscribes once, however many viewers attach', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];

    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => first.push(m));
    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => second.push(m));

    expect(sent.filter((frame) => frame.type === 'units.subscribe')).toHaveLength(1);
    // Both watched the same unit, so both were told what they attached to.
    expect(a.unit.id).toBe(UNIT_ID);
    expect(b.unit.id).toBe(UNIT_ID);

    a.unsubscribe();
    b.unsubscribe();
  });

  it('delivers an event to every viewer', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => first.push(m));
    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => second.push(m));

    handleAgentFrame(AGENT_ID, {
      type: 'unit.event',
      unitId: UNIT_ID,
      event: { type: 'output', data: 'shared\n', stream: 'stdout' },
    });

    expect(first).toEqual([{ type: 'output', data: 'shared\n', stream: 'stdout' }]);
    expect(second).toEqual([{ type: 'output', data: 'shared\n', stream: 'stdout' }]);

    a.unsubscribe();
    b.unsubscribe();
  });

  it('keeps streaming to a viewer when another viewer detaches', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => first.push(m));
    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, (m) => second.push(m));

    a.unsubscribe();

    // The agent is not told to stop: someone is still watching.
    expect(lastFrameOfType('units.unsubscribe')).toBeUndefined();

    handleAgentFrame(AGENT_ID, {
      type: 'unit.event',
      unitId: UNIT_ID,
      event: { type: 'state', state: 'exited' },
    });
    expect(second).toEqual([{ type: 'state', state: 'exited' }]);
    expect(first).toEqual([]);

    b.unsubscribe();
  });

  it('releases the agent subscription when the last viewer detaches', async () => {
    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);

    a.unsubscribe();
    expect(lastFrameOfType('units.unsubscribe')).toBeUndefined();

    b.unsubscribe();
    expect(lastFrameOfType('units.unsubscribe')?.unitId).toBe(UNIT_ID);
  });

  it('subscribes afresh for a viewer who arrives after everyone left', async () => {
    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    a.unsubscribe();

    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    expect(sent.filter((frame) => frame.type === 'units.subscribe')).toHaveLength(2);

    b.unsubscribe();
    expect(lastFrameOfType('units.unsubscribe')?.unitId).toBe(UNIT_ID);
  });

  it('ignores a second detach from the same viewer', async () => {
    // The socket's close and error handlers both release; the second call must
    // not stop a stream that a later viewer now holds.
    const a = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    a.unsubscribe();

    const b = await subscribeHostUnit(AGENT_ID, UNIT_ID, USER_GET, () => undefined);
    a.unsubscribe();

    const unsubscribes = sent.filter((frame) => frame.type === 'units.unsubscribe');
    expect(unsubscribes).toHaveLength(1);
    expect(lastFrameOfType('units.subscribe')).toBeDefined();

    b.unsubscribe();
  });
});
