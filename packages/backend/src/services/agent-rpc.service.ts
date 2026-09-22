import { randomUUID } from 'node:crypto';

import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  NotImplementedError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('agent-rpc');

/**
 * Backend → host-agent RPC client.
 *
 * The host agent is a full RPC *server*: it dials into `/ws/agent`, and once
 * paired it answers `files.*` / `terminal.*` / `system.*` request frames by
 * running them against the real host (its own filesystem and PTYs). This module
 * is the missing other half — it lets the backend *originate* those requests
 * against a connected agent and await the correlated reply, so a browser action
 * can reach the actual VPS host instead of the backend container's sandbox.
 *
 * Frame shapes (mirrored from `@aether/host-agent`'s protocol):
 * - request  (backend → agent): `{ id, type, params }`
 * - reply    (agent → backend): `{ id, ok: true, result }` | `{ id, ok: false, error: { code, message } }`
 * - terminal (agent → backend): `{ type: 'terminal.event', sessionId, event }`
 *
 * Correlation is per-agent: each connected agent owns a pending-request map keyed
 * by the request id we generated. State is per-process by nature — it tracks the
 * socket this replica holds — exactly like `agent-connections`.
 */

const REQUEST_TIMEOUT_MS = 20_000;

/** The subset of a `ws` socket this module needs; kept minimal to avoid a hard type dependency. */
export interface AgentSocket {
  send(data: string): void;
  readyState: number;
  readonly OPEN: number;
  /** Closes the underlying connection. Matches `ws`'s `close(code?, reason?)`. */
  close(code?: number, reason?: string): void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AgentChannel {
  socket: AgentSocket;
  pending: Map<string, PendingRequest>;
  /** sessionId → callback for streamed terminal events (Terminal host-scope). */
  terminalSubscribers: Map<string, (event: unknown) => void>;
  /**
   * unitId → callback for streamed unit events.
   *
   * Separate from `terminalSubscribers` even though sessions and units are the
   * same table on the agent: the two channels stream differently-shaped frames,
   * and one client may watch a unit as a unit while another watches the same
   * process as a session. Sharing one map would make the second subscriber
   * silently replace the first.
   */
  unitSubscribers: Map<string, (event: unknown) => void>;
}

const channels = new Map<string, AgentChannel>();

/** Rejects and clears every in-flight request on a channel. */
function drainPending(channel: AgentChannel, reason: string): void {
  for (const [, pending] of channel.pending) {
    clearTimeout(pending.timer);
    pending.reject(new ServiceUnavailableError(reason));
  }
  channel.pending.clear();
}

/**
 * Drops every stream subscriber on a channel, for a reason the caller states.
 *
 * Both channels go together, because the socket underneath them is what died:
 * a `unit.event` can no more arrive on a closed socket than a `terminal.event`
 * can. Leaving one map populated would keep a callback alive that can never
 * fire, and (worse) make a later re-subscribe look like it was already covered.
 */
function dropSubscribers(channel: AgentChannel): void {
  channel.terminalSubscribers.clear();
  channel.unitSubscribers.clear();
}

/**
 * Records the live socket for an agent so requests can be sent to it.
 *
 * A reconnecting agent replaces the previous channel: any request still waiting
 * on the old socket is failed rather than left to time out, and its terminal
 * subscribers are dropped (the browser side re-subscribes on reconnect).
 */
export function registerAgentSocket(agentId: string, socket: AgentSocket): void {
  const existing = channels.get(agentId);
  if (existing) {
    drainPending(existing, 'Agent reconnected before the request completed');
    dropSubscribers(existing);
  }
  channels.set(agentId, {
    socket,
    pending: new Map(),
    terminalSubscribers: new Map(),
    unitSubscribers: new Map(),
  });
  log.debug({ agentId }, 'agent rpc channel registered');
}

/** Removes the channel when its socket closes, unless a newer socket replaced it. */
export function unregisterAgentSocket(agentId: string, socket: AgentSocket): void {
  const channel = channels.get(agentId);
  if (!channel || channel.socket !== socket) return;
  drainPending(channel, 'Agent disconnected');
  dropSubscribers(channel);
  channels.delete(agentId);
  log.debug({ agentId }, 'agent rpc channel removed');
}

/** True when a live, open socket to the agent is held by this replica. */
export function isAgentRpcConnected(agentId: string): boolean {
  const channel = channels.get(agentId);
  return channel !== undefined && channel.socket.readyState === channel.socket.OPEN;
}

/**
 * Forcibly closes a live agent socket this replica holds, and tears down its
 * channel — used when an agent is revoked.
 *
 * Revocation must be more than a database flag. `authenticateAgent` already
 * refuses a revoked agent's *next* handshake, but a socket that is already
 * registered keeps serving `files.*`, `terminal.*` and `units.*` until it
 * happens to drop — so a revoked agent stays fully reachable, which is the
 * defect DoD #14 names. Closing the socket here makes the revocation take
 * effect on the live connection, not only on the next one.
 *
 * What this does, in order:
 * - **fails every in-flight request** with a clear reason, so a caller awaiting
 *   a reply gets an error rather than the 20s timeout;
 * - **drops every terminal subscriber**, so a browser stream bridged through
 *   this agent stops receiving output immediately rather than lingering;
 * - **deletes the channel** before the socket's async `close` event fires, so
 *   any request racing in between finds no channel and is refused (the same
 *   `ServiceUnavailableError` a disconnected agent gives);
 * - **closes the socket** with a policy-violation code and reason.
 *
 * Returns whether a live socket was found and closed. It is keyed strictly by
 * `agentId`, so it can never touch another agent's channel — and it says
 * nothing about other users: an agent's socket is shared infrastructure, and
 * closing it ends only *that agent's* reachability, not any user's session on a
 * different agent.
 *
 * Per-replica by nature, exactly like `agent-connections`: this closes the
 * socket held by *this* backend process. A multi-replica deployment where the
 * agent is connected to a different replica needs the revocation broadcast that
 * `KNOWN-LIMITATIONS.md` records is not built; the default single-replica
 * install has one socket, here.
 */
export function closeAgentSocket(agentId: string, code: number, reason: string): boolean {
  const channel = channels.get(agentId);
  if (!channel) return false;

  drainPending(channel, reason);
  dropSubscribers(channel);
  // Delete before the async close event so a request racing the close is
  // refused rather than sent into a socket that is going away.
  channels.delete(agentId);

  try {
    channel.socket.close(code, reason);
  } catch (error) {
    log.debug({ err: error, agentId }, 'failed to close revoked agent socket');
  }
  log.warn({ agentId }, 'agent rpc channel force-closed');
  return true;
}

/**
 * Maps an agent-reported error code onto the closest client-facing AppError.
 *
 * The agent and the backend share one error vocabulary (`@aether/shared`'s
 * `ERROR_CODES`), so a rejection keeps its meaning across the hop rather than
 * collapsing to a generic 503. That matters most for the two the execution-unit
 * surface leans on: `NOT_IMPLEMENTED` is how the agent refuses a `service` or
 * `worker` unit it has no supervisor for — a 501 a client must not retry — and
 * `VALIDATION_FAILED` is how it refuses a rejected env var or a bad command,
 * which is the caller's fault (400), not the host's (503).
 */
function agentErrorToAppError(code: string, message: string): AppError {
  switch (code) {
    case 'NOT_FOUND':
      return new NotFoundError(message);
    case 'CONFLICT':
      return new ConflictError(message);
    case 'VALIDATION_FAILED':
      return new ValidationError(message);
    case 'FORBIDDEN':
      return new ForbiddenError(message);
    case 'NOT_IMPLEMENTED':
      return new NotImplementedError(message);
    default:
      // The agent rejected the request for a reason we do not specifically model;
      // surface it as a service-level failure rather than pretending it succeeded.
      return new ServiceUnavailableError(message || 'The host agent rejected the request');
  }
}

/**
 * Sends one request to a connected agent and resolves with its `result`.
 *
 * Rejects with `ServiceUnavailableError` when the agent is not connected or the
 * reply does not arrive within the timeout, and with the mapped `AppError` when
 * the agent answers `{ ok: false }`.
 */
/**
 * Sends one correlated frame to a connected agent and resolves with its `result`.
 *
 * `frameFields` carries the frame's `type` plus any top-level fields the agent
 * reads (request frames put arguments under `params`; the terminal
 * subscribe/unsubscribe control frames put `sessionId` at the top level). A
 * fresh correlation `id` is generated and added here.
 */
function dispatch(agentId: string, frameFields: Record<string, unknown>): Promise<unknown> {
  const channel = channels.get(agentId);
  if (!channel || channel.socket.readyState !== channel.socket.OPEN) {
    return Promise.reject(new ServiceUnavailableError('The host agent is not connected'));
  }

  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.pending.delete(id);
      reject(new ServiceUnavailableError('The host agent did not respond in time'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();

    channel.pending.set(id, { resolve, reject, timer });

    try {
      channel.socket.send(JSON.stringify({ id, ...frameFields }));
    } catch (error) {
      clearTimeout(timer);
      channel.pending.delete(id);
      reject(
        new ServiceUnavailableError(
          error instanceof Error ? error.message : 'Failed to reach the host agent'
        )
      );
    }
  });
}

/**
 * Sends a `{ type, params }` request to a connected agent and awaits its reply.
 *
 * `ownerUserId` names the principal the request is made on behalf of, and the
 * agent acts as that principal. It is optional only because the whole RPC
 * surface does not need it equally:
 *
 * - `terminal.*` is per-user on the agent — sessions are keyed by owner, and
 *   `terminal.list` returns only that owner's sessions. Omitting the principal
 *   there makes the agent fall back to whoever paired the connection, which on
 *   an instance-scoped local agent means one user's `terminal.list` can answer
 *   with another user's shells. Every terminal call site passes it.
 * - `files.*` is role-gated over a single instance-wide workspace
 *   (`files:read`/`write`/`delete`), so there is no per-user split for the agent
 *   to enforce and the parameter is not load-bearing.
 * - `ports.*` is per-user on the agent (a tunnel carries the owner that opened
 *   it, and `ports.read`/`write`/`close` refuse a tunnel that is not the
 *   caller's). Every `agent-ports.service` call site now threads the requesting
 *   user through, so the agent's ownership check runs against the real principal
 *   rather than the paired-connection fallback.
 */
export function sendAgentRequest(
  agentId: string,
  type: string,
  params: Record<string, unknown>,
  ownerUserId?: string
): Promise<unknown> {
  return dispatch(agentId, {
    type,
    params,
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
  });
}

/** Ids of every agent this replica currently holds an open socket to. */
export function connectedAgentIds(): string[] {
  const ids: string[] = [];
  for (const [agentId, channel] of channels) {
    if (channel.socket.readyState === channel.socket.OPEN) ids.push(agentId);
  }
  return ids;
}

/**
 * Subscribes to a host terminal session's streamed output.
 *
 * Sends `terminal.subscribe` (the agent replays scrollback and then streams
 * `terminal.event` frames), routes each event to `onEvent`, and returns an
 * unsubscribe function that both stops routing and tells the agent to stop
 * streaming. Rejects if the subscribe handshake fails.
 *
 * `ownerUserId` is required here, unlike in `sendAgentRequest`: the agent checks
 * it against the session's owner before streaming, and a subscribe that named
 * nobody would silently succeed as the paired owner — the exact confusion this
 * parameter removes.
 */
export async function subscribeAgentTerminal(
  agentId: string,
  sessionId: string,
  ownerUserId: string,
  onEvent: (event: unknown) => void
): Promise<() => void> {
  const stopRouting = setTerminalSubscriber(agentId, sessionId, onEvent);
  try {
    await dispatch(agentId, { type: 'terminal.subscribe', sessionId, ownerUserId });
  } catch (error) {
    stopRouting();
    throw error;
  }
  return () => {
    stopRouting();
    void dispatch(agentId, { type: 'terminal.unsubscribe', sessionId }).catch(() => undefined);
  };
}

/** Registers a callback for a terminal session's streamed output; returns an unsubscribe fn. */
export function setTerminalSubscriber(
  agentId: string,
  sessionId: string,
  onEvent: (event: unknown) => void
): () => void {
  const channel = channels.get(agentId);
  if (!channel) return () => undefined;
  channel.terminalSubscribers.set(sessionId, onEvent);
  return () => {
    channels.get(agentId)?.terminalSubscribers.delete(sessionId);
  };
}

/**
 * Subscribes to an execution unit's event stream.
 *
 * The agent replays the unit's retained output and then streams live events, so
 * a client that attaches late still sees what the process already printed —
 * the property a browser refresh depends on. Returns an unsubscribe function
 * that stops routing *and* tells the agent to stop streaming; a stream nobody
 * reads should not keep a socket busy.
 *
 * `ownerUserId` is required, exactly as on the terminal path: the agent checks
 * it against the unit's owner before streaming, and a subscribe that named
 * nobody would silently succeed as the paired owner — on an instance-scoped
 * local agent that is one identity shared by every user of the instance.
 */
export async function subscribeAgentUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string,
  onEvent: (event: unknown) => void
): Promise<() => void> {
  const stopRouting = setUnitSubscriber(agentId, unitId, onEvent);
  try {
    // The unit channel names `unitId`; the terminal channel predates the unit
    // vocabulary and names `sessionId`. The agent reads the field its channel
    // uses, so sending the wrong one fails the subscribe rather than silently
    // streaming the wrong thing.
    await dispatch(agentId, { type: 'units.subscribe', unitId, ownerUserId });
  } catch (error) {
    stopRouting();
    throw error;
  }
  return () => {
    stopRouting();
    void dispatch(agentId, { type: 'units.unsubscribe', unitId }).catch(() => undefined);
  };
}

/** Registers a callback for a unit's streamed events; returns an unsubscribe fn. */
export function setUnitSubscriber(
  agentId: string,
  unitId: string,
  onEvent: (event: unknown) => void
): () => void {
  const channel = channels.get(agentId);
  if (!channel) return () => undefined;
  channel.unitSubscribers.set(unitId, onEvent);
  return () => {
    channels.get(agentId)?.unitSubscribers.delete(unitId);
  };
}

/**
 * Inspects an inbound agent frame. Returns `true` when the frame was a reply to
 * a backend-originated request or a terminal event we routed — in which case the
 * caller must NOT hand it to the (agent → backend) gateway. Returns `false` for
 * anything else (e.g. agent-originated requests) so the existing gateway path is
 * preserved.
 */
export function handleAgentFrame(agentId: string, frame: Record<string, unknown>): boolean {
  // Reply to one of our requests: `{ id, ok, result | error }`.
  if (typeof frame.id === 'string' && typeof frame.ok === 'boolean') {
    const channel = channels.get(agentId);
    const pending = channel?.pending.get(frame.id);
    if (channel && pending) {
      clearTimeout(pending.timer);
      channel.pending.delete(frame.id);
      if (frame.ok === true) {
        pending.resolve(frame.result);
      } else {
        const err = (frame.error ?? {}) as { code?: string; message?: string };
        pending.reject(agentErrorToAppError(err.code ?? 'INTERNAL_ERROR', err.message ?? ''));
      }
    }
    // Consume it either way: a stray reply has no home in the gateway.
    return true;
  }

  // Streamed terminal output for a subscribed session.
  if (frame.type === 'terminal.event' && typeof frame.sessionId === 'string') {
    const channel = channels.get(agentId);
    channel?.terminalSubscribers.get(frame.sessionId)?.(frame.event);
    return true;
  }

  // Streamed events for a subscribed unit. Consumed here for the same reason as
  // the terminal frames: this is backend-bound traffic, and handing it to the
  // agent → backend gateway would have the gateway parse it as a new request.
  if (frame.type === 'unit.event' && typeof frame.unitId === 'string') {
    const channel = channels.get(agentId);
    channel?.unitSubscribers.get(frame.unitId)?.(frame.event);
    return true;
  }

  return false;
}
