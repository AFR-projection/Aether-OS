/**
 * Host-agent pairing and management.
 *
 * A host agent is a separate process (usually on another machine) that connects
 * back to the backend over `/ws/agent` and exposes host capabilities — system
 * info, processes, files, terminals. It authenticates with a pre-shared pairing
 * token, not with a user session.
 */

/**
 * A paired agent as returned by `GET /api/agents`.
 *
 * The pairing token is deliberately absent: the backend stores only its
 * SHA-256 hash, so the plaintext exists solely in the response to the pairing
 * request that created it.
 */
export interface HostAgent {
  agentId: string;
  label: string;
  /**
   * User who created the pairing; only they can list or revoke it.
   *
   * `null` for an instance-scoped agent — the one the installer pairs on the
   * machine the backend itself runs on, which every user of that instance can
   * see and use. Distinguished in `host_agents` by `scope = 'local'`.
   */
  ownerUserId: string | null;
  createdAt: string;
  /** Whether the agent currently holds an open `/ws/agent` connection. */
  connected: boolean;
  /** ISO timestamp of the current connection, or `null` when offline. */
  connectedAt: string | null;
}

/** The one-time response to `POST /api/agents/pair`. */
export interface AgentPairResult {
  agentId: string;
  /**
   * Plaintext pairing token, shown exactly once and never stored. It must be
   * copied into the agent's configuration before the dialog is dismissed.
   */
  token: string;
  label: string;
  message: string;
}
