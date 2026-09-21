import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAgentFrame, registerAgentSocket } from './agent-rpc.service.js';
import {
  attachHostSession,
  createHostSession,
  killHostSession,
  listHostSessionsForUser,
  reconcileHostSessionsForUser,
  resizeHostSession,
  signalHostSession,
  writeHostInput,
} from './host-terminal.service.js';

/**
 * Host-scope terminal sessions: who the backend says it is acting for, and
 * sessions it did not create.
 *
 * Two behaviours are under test, and both are invisible from the HTTP status
 * code alone — which is why the stub agent below records the frames it is sent
 * and they are asserted on directly.
 *
 * 1. Every request to an agent names the user it is made on behalf of. The agent
 *    keys its sessions on the principal it is given, so a request that named
 *    nobody would be answered as the agent's paired owner — and an
 *    instance-scoped local agent pairs as *itself*, one identity shared by every
 *    user of the instance. The agent's ownership checks would then compare
 *    against that shared identity, and every user's `terminal.list` would answer
 *    with every user's shells.
 * 2. A session the agent holds but this replica has no record of is adopted. The
 *    records here are per-process and the PTYs are not, so restarting the backend
 *    alone used to make live shells unreachable even though the agent still had
 *    them.
 *
 * `query` is mocked so this runs without a database; the SQL `listAgents` issues
 * is already covered by `agent-pairing.service.test.ts`. What matters here is
 * that the agent list is consulted at all before adopting anything.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  queryOne: vi.fn(),
}));

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';

/**
 * A distinct user per test. The session table is module state with no reset, and
 * every operation here is scoped to one user, so distinct principals keep the
 * tests independent without reaching into the module's internals.
 */
const USER_CREATE = '00000000-0000-4000-8000-0000000000b1';
const USER_SEND = '00000000-0000-4000-8000-0000000000b2';
const USER_ATTACH = '00000000-0000-4000-8000-0000000000b3';
const USER_RECONCILE = '00000000-0000-4000-8000-0000000000b4';
const USER_ADOPT = '00000000-0000-4000-8000-0000000000b5';
const USER_UNAUTHORIZED = '00000000-0000-4000-8000-0000000000b6';

const SESSION_ID = '00000000-0000-4000-8000-0000000000c3';
const ADOPTED_SESSION_ID = '00000000-0000-4000-8000-0000000000c4';

interface SentFrame {
  id: string;
  type: string;
  /** The principal the backend named, when it named one. */
  ownerUserId?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
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

const sent: SentFrame[] = [];

/** What the stub agent holds. It is the authority on the PTYs it owns. */
let agentSessions: AgentSession[] = [];

function sessionRecord(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
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

/** Rows in the shape `listAgents` reads, for the agents this user may use. */
function agentRows(agentIds: string[]): { rows: unknown[]; rowCount: number } {
  return {
    rows: agentIds.map((id) => ({
      id,
      label: 'Local host',
      owner_user_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    })),
    rowCount: agentIds.length,
  };
}

/** Installs a stub agent that answers the way the real one does. */
function connectAgent(): void {
  registerAgentSocket(AGENT_ID, {
    readyState: 1,
    OPEN: 1,
    send(raw: string): void {
      const frame = JSON.parse(raw) as SentFrame;
      sent.push(frame);

      let result: unknown = {};
      if (frame.type === 'terminal.create') {
        result = sessionRecord(SESSION_ID);
      } else if (frame.type === 'terminal.list') {
        result = { sessions: agentSessions };
      } else if (frame.type === 'terminal.kill') {
        agentSessions = [];
        result = { killed: true };
      } else if (frame.type === 'terminal.subscribe') {
        result = { subscribed: true, sessionId: frame.sessionId };
      }

      handleAgentFrame(AGENT_ID, { id: frame.id, ok: true, result });
    },
  });
}

function framesOfType(type: string): SentFrame[] {
  return sent.filter((frame) => frame.type === type);
}

function lastFrameOfType(type: string): SentFrame | undefined {
  return framesOfType(type).at(-1);
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  sent.length = 0;
  agentSessions = [];
  connectAgent();
});

describe('every request to an agent names the user it is made for', () => {
  it('names the user on terminal.create', async () => {
    await createHostSession(AGENT_ID, USER_CREATE, { cols: 80, rows: 24 });

    expect(lastFrameOfType('terminal.create')?.ownerUserId).toBe(USER_CREATE);
  });

  it('names the user on input, resize, signal and kill', async () => {
    await createHostSession(AGENT_ID, USER_SEND, { cols: 80, rows: 24 });
    agentSessions = [sessionRecord(SESSION_ID)];

    await writeHostInput(SESSION_ID, USER_SEND, 'echo hello\n');
    await resizeHostSession(SESSION_ID, USER_SEND, 120, 40);
    await signalHostSession(SESSION_ID, USER_SEND, 'SIGINT');
    await killHostSession(SESSION_ID, USER_SEND);

    for (const type of ['terminal.input', 'terminal.resize', 'terminal.signal', 'terminal.kill']) {
      expect(lastFrameOfType(type)?.ownerUserId, type).toBe(USER_SEND);
    }
  });

  it('names the user on the subscribe control frame', async () => {
    await createHostSession(AGENT_ID, USER_ATTACH, { cols: 80, rows: 24 });
    agentSessions = [sessionRecord(SESSION_ID)];

    // An unrelated user cannot attach at all, so this is the owner's own path.
    const attached = await attachHostSession(SESSION_ID, USER_ATTACH, () => undefined);
    attached.unsubscribe();

    // `terminal.subscribe` is a control frame, not a routed request: it never
    // passes through the request envelope, so it carries the principal by hand.
    expect(lastFrameOfType('terminal.subscribe')?.ownerUserId).toBe(USER_ATTACH);
  });

  it('names the user when reconciling', async () => {
    await createHostSession(AGENT_ID, USER_RECONCILE, { cols: 80, rows: 24 });
    sent.length = 0;

    await reconcileHostSessionsForUser(USER_RECONCILE);

    expect(lastFrameOfType('terminal.list')?.ownerUserId).toBe(USER_RECONCILE);
  });
});

describe('sessions this replica did not create', () => {
  it('adopts a session the agent reports and this replica has no record of', async () => {
    queryMock.mockResolvedValue(agentRows([AGENT_ID]));
    agentSessions = [sessionRecord(ADOPTED_SESSION_ID)];

    // Nothing here created this session: it is the state after this replica
    // restarted while the agent — and the shell it owns — kept running.
    expect(listHostSessionsForUser(USER_ADOPT)).toEqual([]);

    await reconcileHostSessionsForUser(USER_ADOPT);

    const adopted = listHostSessionsForUser(USER_ADOPT);
    expect(adopted.map((session) => session.id)).toContain(ADOPTED_SESSION_ID);
    expect(adopted.find((s) => s.id === ADOPTED_SESSION_ID)?.agentId).toBe(AGENT_ID);
  });

  it('does not adopt from an agent the user is not listed for', async () => {
    // `listAgents` returns nothing for this user — the agent is not theirs. The
    // agent still reports a session, and it must stay invisible: adoption asks
    // the agent what it holds, but which agents may be asked is the backend's
    // decision, not the agent's.
    queryMock.mockResolvedValue(agentRows([]));
    agentSessions = [sessionRecord(ADOPTED_SESSION_ID)];

    await reconcileHostSessionsForUser(USER_UNAUTHORIZED);

    expect(listHostSessionsForUser(USER_UNAUTHORIZED)).toEqual([]);
  });
});
