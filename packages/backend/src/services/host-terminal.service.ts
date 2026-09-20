import {
  isAgentRpcConnected,
  sendAgentRequest,
  subscribeAgentTerminal,
} from './agent-rpc.service.js';
import { NotFoundError, ServiceUnavailableError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

import type { TerminalServerMessage, TerminalSession } from '@aether/shared';

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

  const reply = await sendAgentRequest(agentId, 'terminal.create', {
    cols: options.cols,
    rows: options.rows,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.shell !== undefined ? { shell: options.shell } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
  });

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

export function listHostSessionsForUser(userId: string): TerminalSession[] {
  const result: TerminalSession[] = [];
  for (const record of hostSessions.values()) {
    if (record.ownerUserId === userId) result.push({ ...record.session });
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
  const unsubscribe = await subscribeAgentTerminal(record.agentId, sessionId, (event) => {
    recordSessionEvent(record, event);
    onMessage(event as TerminalServerMessage);
  });
  return { session: { ...record.session }, unsubscribe };
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
 * Best effort, deliberately. An agent that is not connected, or a request that
 * fails, leaves the records untouched: a backend that cannot ask must not invent
 * an answer, and a stale "running" is a smaller lie than a session reported dead
 * while its shell is still there.
 */
export async function reconcileHostSessionsForUser(userId: string): Promise<void> {
  const agentIds = new Set<string>();
  for (const record of hostSessions.values()) {
    if (record.ownerUserId === userId) agentIds.add(record.agentId);
  }

  for (const agentId of agentIds) {
    if (!isAgentRpcConnected(agentId)) continue;

    let reply: unknown;
    try {
      reply = await sendAgentRequest(agentId, 'terminal.list', {});
    } catch (error) {
      log.warn({ err: error, agentId }, 'could not reconcile host terminal sessions with the agent');
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
  await sendAgentRequest(record.agentId, 'terminal.input', { id: sessionId, data });
}

export async function resizeHostSession(
  sessionId: string,
  userId: string,
  cols: number,
  rows: number
): Promise<void> {
  const record = requireOwned(sessionId, userId);
  await sendAgentRequest(record.agentId, 'terminal.resize', { id: sessionId, cols, rows });
}

export async function signalHostSession(
  sessionId: string,
  userId: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
): Promise<void> {
  const record = requireOwned(sessionId, userId);
  if (signal === 'SIGINT') {
    await sendAgentRequest(record.agentId, 'terminal.signal', { id: sessionId, signal });
    return;
  }
  // SIGTERM/SIGKILL end the shell for good; kill it on the agent and forget it.
  await sendAgentRequest(record.agentId, 'terminal.kill', { id: sessionId });
  hostSessions.delete(sessionId);
}

export async function killHostSession(sessionId: string, userId: string): Promise<boolean> {
  const record = getOwnedHostSession(sessionId, userId);
  if (!record) return false;
  try {
    await sendAgentRequest(record.agentId, 'terminal.kill', { id: sessionId });
  } catch (error) {
    log.warn({ err: error, sessionId }, 'failed to kill host terminal on the agent');
  }
  hostSessions.delete(sessionId);
  return true;
}
