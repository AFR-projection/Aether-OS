import { listAgents } from './agent-pairing.service.js';
import {
  connectedAgentIds,
  isAgentRpcConnected,
  sendAgentRequest,
  subscribeAgentTerminal,
} from './agent-rpc.service.js';
import { NotFoundError, ServiceUnavailableError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

import type {
  TerminalServerMessage,
  TerminalSession,
  TerminalSessionSummary,
} from '@aether/shared';

const log = subsystemLogger('host-terminal');

/**
 * Host-scope terminal sessions.
 *
 * A host terminal is a real PTY spawned by a connected agent on the actual
 * machine, not a `node-pty` in this backend container. This module keeps the
 * backend-side bookkeeping — which agent owns each session and which user may
 * attach — and bridges the browser WebSocket to the agent's terminal RPC:
 * output streams in over `terminal.event`, input/resize/signal go out as agent
 * requests.
 *
 * Registration is per-process, like `terminal.service`'s local map: it records
 * the socket this replica holds. A session created here is addressable only
 * while its agent stays connected to this replica.
 *
 * Every request to the agent names the user it is made on behalf of. The agent
 * keys its sessions on the principal it is given, so a request that named nobody
 * would be answered as the agent's paired owner instead — and an instance-scoped
 * local agent pairs as itself (see `ws/agent.ws.ts`), which is one identity
 * shared by every user of the instance. The agent's ownership checks would then
 * compare against that shared identity and let every user see every session.
 * Passing the user on each call is what makes the agent's own check meaningful.
 */

interface HostSessionRecord {
  agentId: string;
  ownerUserId: string;
  session: TerminalSession;
}

const hostSessions = new Map<string, HostSessionRecord>();

export function isHostSession(sessionId: string): boolean {
  return hostSessions.has(sessionId);
}

export interface CreateHostSessionOptions {
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  command?: string;
}

export async function createHostSession(
  agentId: string,
  ownerUserId: string,
  options: CreateHostSessionOptions
): Promise<TerminalSession> {
  if (!isAgentRpcConnected(agentId)) {
    throw new ServiceUnavailableError('The selected host agent is not connected');
  }

  const reply = await sendAgentRequest(
    agentId,
    'terminal.create',
    {
      cols: options.cols,
      rows: options.rows,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.command !== undefined ? { command: options.command } : {}),
    },
    ownerUserId
  );

  const session = reply as TerminalSession;
  if (session === null || typeof session !== 'object' || typeof session.id !== 'string') {
    throw new ServiceUnavailableError('The host agent returned an invalid terminal session');
  }

  hostSessions.set(session.id, { agentId, ownerUserId, session });
  log.info({ sessionId: session.id, agentId }, 'host terminal session created');
  return session;
}

/** Returns the record only when `userId` owns the host session, else null. */
export function getOwnedHostSession(sessionId: string, userId: string): HostSessionRecord | null {
  const record = hostSessions.get(sessionId);
  if (!record || record.ownerUserId !== userId) return null;
  return record;
}

function requireOwned(sessionId: string, userId: string): HostSessionRecord {
  const record = getOwnedHostSession(sessionId, userId);
  if (!record) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }
  return record;
}

export function listHostSessionsForUser(userId: string): TerminalSessionSummary[] {
  const result: TerminalSessionSummary[] = [];
  for (const record of hostSessions.values()) {
    if (record.ownerUserId === userId) {
      result.push({ ...record.session, scope: 'host', agentId: record.agentId });
    }
  }
  return result;
}

export interface HostAttachResult {
  session: TerminalSession;
  unsubscribe: () => void;
}

/**
 * Applies one agent event to the backend's record of a session.
 *
 * Only `exit` changes anything the record carries. The agent sets the status and
 * the exit code before it broadcasts, so echoing them here is what keeps
 * `GET /api/terminal/sessions` from reporting a shell that an attached client has
 * just watched exit as still running.
 */
function recordSessionEvent(record: HostSessionRecord, event: unknown): void {
  if (typeof event !== 'object' || event === null) return;
  const frame = event as { type?: unknown; exitCode?: unknown };
  if (frame.type !== 'exit') return;

  record.session.status = 'exited';
  record.session.exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : null;
  record.session.pid = null;
}

/**
 * Attaches a subscriber to a host session's output.
 *
 * The agent replays this session's scrollback as `output` events on subscribe,
 * so the caller does not replay separately — it just forwards every event.
 */
export async function attachHostSession(
  sessionId: string,
  userId: string,
  onMessage: (message: TerminalServerMessage) => void
): Promise<HostAttachResult> {
  const record = requireOwned(sessionId, userId);
  const unsubscribe = await subscribeAgentTerminal(record.agentId, sessionId, userId, (event) => {
    recordSessionEvent(record, event);
    onMessage(event as TerminalServerMessage);
  });
  return { session: { ...record.session }, unsubscribe };
}

/**
 * The agents worth asking about this user's sessions.
 *
 * Two sources, because either alone is wrong. The records here know which agents
 * this user already has sessions on — but that is exactly what a backend restart
 * loses, and a session the agent still holds would then never be looked for. The
 * agent list knows which agents this user may use at all (their own, plus the
 * instance-scoped local agent, which is paired as itself and shared by everyone —
 * see `listAgents`). Only agents this replica actually holds a socket to are
 * added, because the ones it does not are unreachable from here.
 *
 * A failure to read the agent list is not fatal: the records already held are
 * still swept, which is what the previous behaviour did.
 */
async function candidateAgentIdsForUser(userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const record of hostSessions.values()) {
    if (record.ownerUserId === userId) ids.add(record.agentId);
  }

  try {
    const allowed = new Set((await listAgents(userId)).map((agent) => agent.agentId));
    for (const agentId of connectedAgentIds()) {
      if (allowed.has(agentId)) ids.add(agentId);
    }
  } catch (error) {
    log.warn({ err: error, userId }, 'could not list agents; reconciling known hosts only');
  }

  return ids;
}

/**
 * Brings this replica's records in line with the agents that own them.
 *
 * A host shell can end without anyone asking it to: the operator types `exit`, a
 * command terminates the shell, an idle timeout fires. The agent knows at once —
 * it sets the session's status and drops it from its own map 30 seconds later —
 * but this replica's record was written once, from the create reply, and nothing
 * revised it. A session the user had ended therefore stayed "running" in
 * `GET /api/terminal/sessions` for as long as the process lived.
 *
 * The agent is the authority on a PTY it owns, so this asks it: a session the
 * agent still reports is mirrored, exit code and status included, and a session
 * the agent no longer knows is dropped, because it does not exist any more.
 *
 * A session the agent reports that this replica has no record of is adopted. That
 * is the difference between "Aether restarted" and "sessions lost": the records
 * are per-process and the PTYs are not, so a restart of the backend alone left
 * live shells on the agent that nothing could reach. `terminal.list` is answered
 * for the user named on the request, so an adopted session is one the agent has
 * already confirmed belongs to this user — this step grants nothing.
 *
 * Best effort, deliberately. An agent that is not connected, or a request that
 * fails, leaves the records untouched: a backend that cannot ask must not invent
 * an answer, and a stale "running" is a smaller lie than a session reported dead
 * while its shell is still there.
 */
export async function reconcileHostSessionsForUser(userId: string): Promise<void> {
  const agentIds = await candidateAgentIdsForUser(userId);

  for (const agentId of agentIds) {
    if (!isAgentRpcConnected(agentId)) continue;

    let reply: unknown;
    try {
      reply = await sendAgentRequest(agentId, 'terminal.list', {}, userId);
    } catch (error) {
      log.warn(
        { err: error, agentId },
        'could not reconcile host terminal sessions with the agent'
      );
      continue;
    }

    const live = new Map<string, TerminalSession>();
    const reported = (reply as { sessions?: unknown } | null)?.sessions;
    if (Array.isArray(reported)) {
      for (const session of reported as TerminalSession[]) {
        if (session !== null && typeof session === 'object' && typeof session.id === 'string') {
          live.set(session.id, session);
        }
      }
    }

    for (const [sessionId, session] of live) {
      if (hostSessions.has(sessionId)) continue;
      hostSessions.set(sessionId, { agentId, ownerUserId: userId, session });
      log.info(
        { sessionId, agentId, status: session.status },
        'adopted a host terminal session this replica had no record of'
      );
    }

    for (const [sessionId, record] of hostSessions) {
      if (record.agentId !== agentId || record.ownerUserId !== userId) continue;

      const fromAgent = live.get(sessionId);
      if (fromAgent === undefined) {
        hostSessions.delete(sessionId);
        continue;
      }

      record.session.status = fromAgent.status;
      record.session.exitCode = fromAgent.exitCode;
      record.session.pid = fromAgent.pid;
      record.session.lastActivityAt = fromAgent.lastActivityAt;
    }
  }
}

export async function writeHostInput(
  sessionId: string,
  userId: string,
  data: string
): Promise<void> {
  const record = requireOwned(sessionId, userId);
  await sendAgentRequest(record.agentId, 'terminal.input', { id: sessionId, data }, userId);
}

export async function resizeHostSession(
  sessionId: string,
  userId: string,
  cols: number,
  rows: number
): Promise<void> {
  const record = requireOwned(sessionId, userId);
  await sendAgentRequest(record.agentId, 'terminal.resize', { id: sessionId, cols, rows }, userId);
}

export async function signalHostSession(
  sessionId: string,
  userId: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
): Promise<void> {
  const record = requireOwned(sessionId, userId);
  if (signal === 'SIGINT') {
    await sendAgentRequest(record.agentId, 'terminal.signal', { id: sessionId, signal }, userId);
    return;
  }
  // SIGTERM/SIGKILL end the shell for good; kill it on the agent and forget it.
  await sendAgentRequest(record.agentId, 'terminal.kill', { id: sessionId }, userId);
  hostSessions.delete(sessionId);
}

export async function killHostSession(sessionId: string, userId: string): Promise<boolean> {
  const record = getOwnedHostSession(sessionId, userId);
  if (!record) return false;
  try {
    await sendAgentRequest(record.agentId, 'terminal.kill', { id: sessionId }, userId);
  } catch (error) {
    log.warn({ err: error, sessionId }, 'failed to kill host terminal on the agent');
  }
  hostSessions.delete(sessionId);
  return true;
}
