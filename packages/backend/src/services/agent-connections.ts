import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('agent-connections');

/**
 * In-memory registry of currently connected host agents.
 *
 * Connection state is inherently per-process: it describes an open WebSocket
 * held by *this* backend replica, so it is deliberately not stored in the
 * database or the shared cache. A replica that does not hold the socket would
 * only be guessing.
 *
 * The consequence is a known limitation of multi-replica deployments: with
 * more than one backend behind the proxy, `connected` in `GET /api/agents`
 * reflects the replica that answered the request. Pairing, listing, and
 * revoking are unaffected — only the live indicator is.
 */

interface ConnectionRecord {
  /** Epoch milliseconds of the handshake that established this connection. */
  connectedAt: number;
  /** Opens held by this agent. An agent may reconnect before the close fires. */
  sockets: number;
}

const connections = new Map<string, ConnectionRecord>();

/**
 * Records an open socket for an agent.
 *
 * Counts sockets rather than storing a boolean: a reconnecting agent can have
 * its new socket accepted before the old one's `close` event is delivered, and
 * a boolean would let that late event mark a live agent offline.
 */
export function markAgentConnected(agentId: string): void {
  const existing = connections.get(agentId);
  if (existing) {
    existing.sockets += 1;
    return;
  }
  connections.set(agentId, { connectedAt: Date.now(), sockets: 1 });
  log.debug({ agentId, total: connections.size }, 'agent marked connected');
}

/** Records that a socket closed, marking the agent offline on the last one. */
export function markAgentDisconnected(agentId: string): void {
  const existing = connections.get(agentId);
  if (!existing) return;

  existing.sockets -= 1;
  if (existing.sockets > 0) return;

  connections.delete(agentId);
  log.debug({ agentId, total: connections.size }, 'agent marked disconnected');
}

/** Whether the agent currently holds at least one open socket. */
export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}

/** ISO timestamp of the oldest open connection, or `null` when offline. */
export function agentConnectedAt(agentId: string): string | null {
  const record = connections.get(agentId);
  return record ? new Date(record.connectedAt).toISOString() : null;
}

/** Number of distinct connected agents. Reported by the readiness probe. */
export function connectedAgentCount(): number {
  return connections.size;
}

/** Clears the registry. Used by tests and during shutdown. */
export function resetAgentConnections(): void {
  connections.clear();
}
