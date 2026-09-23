import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';
import { handleAgentFrame, registerAgentSocket } from '../services/agent-rpc.service.js';
import { resetUnitStreamsForTests } from '../services/host-units.service.js';

import type { UnitServerMessage } from '@aether/shared';
import type { FastifyInstance } from 'fastify';

/**
 * The unit stream, end to end over a real socket.
 *
 * Everything in the chain below the browser is real: a real Fastify server with
 * the real routes, the real ticket store, the real `host-units.service`, the
 * real `agent-rpc.service`. Only two things are stubbed, and both are outside
 * the code under test: the authenticated principal (the route guards are proven
 * by `auth`'s own tests), and the agent's socket — which is a stub in the same
 * sense the real thing is a socket, answering the frames it is sent in the
 * protocol's own shapes.
 *
 * What this proves that a service-level test cannot:
 *
 * 1. **The whole handshake works** — a ticket minted over HTTP is redeemed at
 *    the WebSocket upgrade, and an invalid one is refused with the application's
 *    close code rather than a stream.
 * 2. **`ready` precedes every event, including the replay.** The stub agent
 *    writes its replayed output *before* it answers the subscribe, exactly as
 *    the real one does, so a bridge that forwarded as it received would put
 *    output on the wire before the client was told which unit it was looking at.
 * 3. **This channel cannot control the unit.** A control frame is refused, and
 *    no control request reaches the agent — asserted on the frame log, because
 *    an error reply alone would not prove the act did not also happen.
 * 4. **Closing the browser socket releases the stream** on the agent.
 */

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
  requirePermission: () => (): Promise<void> => Promise.resolve(),
  requirePrincipal: () => principal,
}));

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const UNIT_ID = '00000000-0000-4000-8000-0000000000d1';
const OTHER_UNIT_ID = '00000000-0000-4000-8000-0000000000d2';

/** What the bridge sent the agent, so a test can assert on the request not just the reply. */
const sentToAgent: Array<{ type: string; unitId?: string; ownerUserId?: string }> = [];

/** A shape-valid unit record, so `ready` carries a real one rather than a stub. */
function unitRecord(id: string, ownerUserId: string) {
  return {
    id,
    ownerUserId,
    kind: 'command',
    agentId: AGENT_ID,
    state: 'running',
    process: { pid: 4242, pgid: 4242, startTicks: '1', bootId: 'b' },
    exit: null,
    restart: { policy: 'never', maxAttempts: 0, backoffMs: 1000, attempts: 0 },
    limits: {
      wallClockMs: null,
      graceMs: 5000,
      maxOutputBytes: 262144,
      addressSpaceBytes: null,
      cpuSeconds: null,
      maxOpenFiles: null,
      coreDumpBytes: null,
      enforced: false,
      exceeded: null,
    },
    spec: {
      kind: 'command',
      shell: '/bin/bash',
      command: 'echo hi',
      cwd: '/',
      env: {},
      tty: false,
      cols: null,
      rows: null,
      term: null,
      logMode: 'pipe',
    },
    log: { mode: 'pipe', retainedBytes: 0, droppedBytes: 0, totalBytes: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    requestId: null,
  };
}

/**
 * A stub agent that behaves like the real one on the frames this channel uses.
 *
 * The ordering in `units.subscribe` is the point: the real agent replays the
 * retained output *inside* the subscribe, before it answers, so those frames
 * reach the bridge before the subscribe promise resolves. Reproducing that here
 * is what makes the backlog a tested requirement rather than a hopeful comment.
 */
function connectStubAgent(): void {
  registerAgentSocket(AGENT_ID, {
    readyState: 1,
    OPEN: 1,
    send(raw: string): void {
      const frame = JSON.parse(raw) as { id: string; type: string; unitId?: string };
      sentToAgent.push({
        type: frame.type,
        ...(frame.unitId !== undefined ? { unitId: frame.unitId } : {}),
        ...(typeof (frame as { ownerUserId?: string }).ownerUserId === 'string'
          ? { ownerUserId: (frame as { ownerUserId?: string }).ownerUserId }
          : {}),
      });

      switch (frame.type) {
        case 'units.get':
          handleAgentFrame(AGENT_ID, {
            id: frame.id,
            ok: true,
            result: { unit: unitRecord(UNIT_ID, principal.user.id) },
          });
          break;
        case 'units.subscribe':
          // Retained output first — the agent's replay — then the reply.
          handleAgentFrame(AGENT_ID, {
            type: 'unit.event',
            unitId: UNIT_ID,
            event: { type: 'output', data: 'replayed\n', stream: 'stdout' },
          });
          handleAgentFrame(AGENT_ID, {
            id: frame.id,
            ok: true,
            result: { subscribed: true, id: UNIT_ID },
          });
          break;
        case 'units.unsubscribe':
          handleAgentFrame(AGENT_ID, {
            id: frame.id,
            ok: true,
            result: { unsubscribed: true },
          });
          break;
        default:
          handleAgentFrame(AGENT_ID, { id: frame.id, ok: true, result: {} });
      }
    },
  });
}

let app: FastifyInstance;
/** The real listening port. See `connect` for why this suite uses one. */
let baseUrl = '';

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  // A real TCP listener, not a simulated upgrade. `app.injectWS` exists, but it
  // fails against this server's route set for a reason that has nothing to do
  // with the code under test — so the stream is exercised the way a browser
  // exercises it: over a socket, through a genuine HTTP upgrade.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }
  baseUrl = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  // A fresh slate: forget any stream a prior test left in the registry, then
  // re-register the agent socket (which resets the agent-rpc channel). Without
  // the first, a test reusing this unit would ride the prior test's live stream
  // and never send its own `units.subscribe` — so the stub would never replay.
  resetUnitStreamsForTests();
  sentToAgent.length = 0;
  connectStubAgent();
});

/** Polls until `predicate` holds. A test that hangs is a failure, not a wait. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; frames so far: ${JSON.stringify(received)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let received: UnitServerMessage[] = [];
let closed: { code: number; reason: string } | null = null;

/**
 * Every socket a test opened, so `afterEach` can close them and wait for the
 * server to release the stream before the next test reuses the same unit.
 */
const openSockets: WebSocket[] = [];

/**
 * The socket whose frames the shared `received`/`closed` collectors reflect.
 *
 * A closed socket fires `onclose` asynchronously, so a socket from earlier in
 * the *same* test (the ticket-reuse test opens two) can report its close after
 * the next `openSocket` has already reset the collectors — clobbering them with
 * the wrong socket's code. Guarding every handler on identity means only the
 * socket a test is currently reading from can write to the collectors.
 */
let activeSocket: WebSocket | null = null;

/**
 * Opens a socket the way a browser does — a real client over a real port.
 *
 * Resolves with the socket, or with `null` when the server closed it before the
 * handshake completed. A refusal after the upgrade (which is how every refusal
 * here arrives, since a browser cannot be turned away at the transport level) is
 * still an `open` followed by a `close`; resolving on either keeps the tests
 * from depending on which of the two the client reports first.
 */
function openSocket(url: string): Promise<WebSocket | null> {
  received = [];
  closed = null;
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    activeSocket = socket;
    openSockets.push(socket);
    socket.onmessage = (event) => {
      if (socket !== activeSocket) return;
      received.push(JSON.parse(String(event.data)) as UnitServerMessage);
    };
    socket.onclose = (event) => {
      if (socket === activeSocket) closed = { code: event.code, reason: event.reason };
      resolve(null);
    };
    socket.onopen = () => resolve(socket);
    // A close always follows an error, and the close is what the test reads.
    socket.onerror = () => undefined;
  });
}

/**
 * Closes every socket the test opened and waits for the server to release the
 * stream, so a prior test's late `close` handler cannot delete the *next*
 * test's subscriber. The registry and the agent channel are reset in
 * `beforeEach`; this is the third leg — draining the sockets themselves.
 */
afterEach(async () => {
  const subscribed = sentToAgent.some((frame) => frame.type === 'units.subscribe');
  for (const socket of openSockets) {
    if (socket.readyState === socket.CLOSED) continue;
    await new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.close();
    });
  }
  openSockets.length = 0;
  activeSocket = null;
  // The socket closing on the client is not the server having processed it. The
  // server's `close` handler is what unsubscribes, so wait until that landed —
  // otherwise it fires into the next test and detaches its fresh subscriber.
  if (subscribed) {
    const deadline = Date.now() + 3_000;
    while (!sentToAgent.some((frame) => frame.type === 'units.unsubscribe')) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});

async function mintTicket(unitId: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: `/api/units/${unitId}/ticket` });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { ticket: string } }>().data.ticket;
}

/** A fresh ticket, a fresh socket, and empty collectors for the new stream. */
async function connect(options: {
  unitId?: string;
  agentId?: string;
  ticket?: string;
}): Promise<WebSocket | null> {
  const unitId = options.unitId ?? UNIT_ID;
  const agentId = options.agentId ?? AGENT_ID;
  const ticket = options.ticket ?? (await mintTicket(unitId));

  return openSocket(
    `${baseUrl}/ws/units/${unitId}?agentId=${encodeURIComponent(agentId)}&ticket=${encodeURIComponent(ticket)}`
  );
}

describe('the ticket endpoint', () => {
  it('issues a single-use ticket bound to the unit, over an authenticated request', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/units/${UNIT_ID}/ticket` });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { ticket: string; expiresIn: number } }>().data;
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  it('refuses a second use of the same ticket', async () => {
    // The whole reason the ticket exists: it is a one-shot credential, so a
    // leaked URL is worthless a moment later.
    const ticket = await mintTicket(UNIT_ID);
    const first = await connect({ ticket });
    await waitUntil(() => received.length > 0, 'the first attach');
    first?.close();
    await waitUntil(() => received.length > 0, 'the first stream');

    await connect({ ticket });

    // The socket is accepted at the transport level — a browser cannot be
    // refused before the upgrade — and then closed as unauthenticated.
    await waitUntil(() => closed !== null, 'the refusal');
    expect(closed?.code).toBe(4001);
  });
});

describe('attaching to a unit', () => {
  it('sends ready before any event, even though the agent replays first', async () => {
    const socket = await connect({});

    await waitUntil(() => received.length >= 2, 'ready and the replay');
    expect(received[0]).toMatchObject({ type: 'ready', unitId: UNIT_ID, agentId: AGENT_ID });
    expect(received[0]).toHaveProperty('unit.id', UNIT_ID);
    expect(received[1]).toEqual({ type: 'output', data: 'replayed\n', stream: 'stdout' });

    socket?.close();
  });

  it('names the user it is acting for on the subscribe', async () => {
    const socket = await connect({});
    await waitUntil(() => received.length > 0, 'the attach');

    const subscribe = sentToAgent.find((frame) => frame.type === 'units.subscribe');
    expect(subscribe?.ownerUserId).toBe(principal.user.id);
    expect(subscribe?.unitId).toBe(UNIT_ID);

    socket?.close();
  });

  it('streams a live event after the attach', async () => {
    const socket = await connect({});
    await waitUntil(() => received.length >= 2, 'the replay');

    handleAgentFrame(AGENT_ID, {
      type: 'unit.event',
      unitId: UNIT_ID,
      event: { type: 'exit', exitCode: 0, signal: null, normalized: 0, state: 'exited' },
    });

    await waitUntil(() => received.length >= 3, 'the exit event');
    expect(received[2]).toEqual({
      type: 'exit',
      exitCode: 0,
      signal: null,
      normalized: 0,
      state: 'exited',
    });

    socket?.close();
  });

  it('closes as unauthenticated when the ticket is for another unit', async () => {
    // A ticket is bound to one unit; presenting it for a different one is not a
    // stream, and is refused in the same breath as a forged one.
    const ticket = await mintTicket(OTHER_UNIT_ID);
    const socket = await connect({ unitId: UNIT_ID, ticket });

    await waitUntil(() => closed !== null, 'the refusal');
    expect(closed?.code).toBe(4001);
    socket?.close();
  });

  it('refuses a request that names no host, without redeeming anything', async () => {
    const socket = await openSocket(
      `${baseUrl}/ws/units/${UNIT_ID}?ticket=${encodeURIComponent(await mintTicket(UNIT_ID))}`
    );
    socket?.close();

    await waitUntil(() => closed !== null, 'the refusal');
    expect(closed?.code).toBe(1008);
    expect(sentToAgent).toEqual([]);
  });
});

describe('the stream cannot control the unit', () => {
  it('answers a ping with a pong', async () => {
    const socket = await connect({});
    await waitUntil(() => received.length >= 2, 'the replay');

    socket?.send(JSON.stringify({ type: 'ping' }));

    await waitUntil(() => received.some((frame) => frame.type === 'pong'), 'the pong');
    socket?.close();
  });

  it('refuses a control frame and names the route that can do it', async () => {
    const socket = await connect({});
    await waitUntil(() => received.length >= 2, 'the replay');

    socket?.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));

    await waitUntil(() => received.some((frame) => frame.type === 'error'), 'the refusal');
    const error = received.find((frame) => frame.type === 'error');
    expect(error).toMatchObject({ code: 'UNSUPPORTED_MESSAGE' });
    expect((error as { message: string }).message).toContain('/api/units/:id/signal');

    // The refusal must be the *whole* story: no signal reached the agent, so
    // nothing was done and then reported as not done.
    expect(sentToAgent.some((frame) => frame.type === 'units.signal')).toBe(false);
    socket?.close();
  });
});

describe('releasing the stream', () => {
  it('tells the agent to stop streaming when the browser socket closes', async () => {
    const socket = await connect({});
    await waitUntil(() => received.length >= 2, 'the replay');

    socket?.close();

    await waitUntil(
      () => sentToAgent.some((frame) => frame.type === 'units.unsubscribe'),
      'the unsubscribe'
    );
  });

  it('does not end the unit when the browser goes away', async () => {
    // Detaching is not killing: a reload has to re-attach to a live process.
    const socket = await connect({});
    await waitUntil(() => received.length >= 2, 'the replay');
    socket?.close();
    await waitUntil(
      () => sentToAgent.some((frame) => frame.type === 'units.unsubscribe'),
      'the unsubscribe'
    );

    expect(sentToAgent.some((frame) => frame.type === 'units.kill')).toBe(false);
    expect(sentToAgent.some((frame) => frame.type === 'units.signal')).toBe(false);
  });
});
