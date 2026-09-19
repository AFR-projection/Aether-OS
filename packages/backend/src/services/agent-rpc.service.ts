import { randomUUID } from 'node:crypto';

import {
  AppError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
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
    existing.terminalSubscribers.clear();
  }
  channels.set(agentId, { socket, pending: new Map(), terminalSubscribers: new Map() });
  log.debug({ agentId }, 'agent rpc channel registered');
}

/** Removes the channel when its socket closes, unless a newer socket replaced it. */
export function unregisterAgentSocket(agentId: string, socket: AgentSocket): void {
  const channel = channels.get(agentId);
  if (!channel || channel.socket !== socket) return;
  drainPending(channel, 'Agent disconnected');
  channel.terminalSubscribers.clear();
  channels.delete(agentId);
  log.debug({ agentId }, 'agent rpc channel removed');
}

/** True when a live, open socket to the agent is held by this replica. */
export function isAgentRpcConnected(agentId: string): boolean {
  const channel = channels.get(agentId);
  return channel !== undefined && channel.socket.readyState === channel.socket.OPEN;
}

/** Maps an agent-reported error code onto the closest client-facing AppError. */
function agentErrorToAppError(code: string, message: string): AppError {
  switch (code) {
    case 'NOT_FOUND':
      return new NotFoundError(message);
    case 'CONFLICT':
      return new ConflictError(message);
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

/** Sends a `{ type, params }` request to a connected agent and awaits its reply. */
export function sendAgentRequest(
  agentId: string,
  type: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return dispatch(agentId, { type, params });
}

/**
 * Subscribes to a host terminal session's streamed output.
 *
 * Sends `terminal.subscribe` (the agent replays scrollback and then streams
 * `terminal.event` frames), routes each event to `onEvent`, and returns an
 * unsubscribe function that both stops routing and tells the agent to stop
 * streaming. Rejects if the subscribe handshake fails.
 */
export async function subscribeAgentTerminal(
  agentId: string,
  sessionId: string,
  onEvent: (event: unknown) => void
): Promise<() => void> {
  const stopRouting = setTerminalSubscriber(agentId, sessionId, onEvent);
  try {
    await dispatch(agentId, { type: 'terminal.subscribe', sessionId });
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

  return false;
}
