import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { query } from '../db/pool.js';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('agent-pairing');

export interface AgentRecord {
  agentId: string;
  label: string;
  ownerUserId: string | null;
  createdAt: string;
}

/**
 * Host-agent pairing.
 *
 * Pairing tokens are pre-shared secrets: the installer (or an owner through the
 * API) generates one, stores only its SHA-256 hash in `aether.host_agents`,
 * and hands the plaintext to the agent exactly once. The agent presents the
 * plaintext on every `/ws/agent` handshake; the backend hashes and compares in
 * constant time. A leaked database therefore does not yield usable tokens, and
 * a leaked log line (hashes are never logged) does not either.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface PairAgentOptions {
  label: string;
  ownerUserId: string;
}

/** Generates a token, stores its hash, and returns the plaintext exactly once. */
export async function pairAgent(
  options: PairAgentOptions
): Promise<{ agentId: string; token: string }> {
  const agentId = randomBytes(16)
    .toString('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const token = `aether-agent_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashToken(token);

  await query(
    `INSERT INTO aether.host_agents (id, label, token_hash, owner_user_id)
     VALUES ($1, $2, $3, $4)`,
    [agentId, options.label, tokenHash, options.ownerUserId]
  );

  log.info({ agentId }, 'host agent paired');
  return { agentId, token };
}

/**
 * Registers (or re-registers) the host agent running on this same machine.
 *
 * The installer generates the agent id and token on the host and passes only
 * the token's SHA-256 hash here, so the plaintext never enters the backend
 * process. The row is instance-scoped: `owner_user_id` is NULL and
 * `scope = 'local'`, which is what lets every owner see it and what the
 * gateway maps to the `agent:<id>` principal for terminal ownership.
 *
 * Upsert rather than insert: re-running the installer, or repairing an agent,
 * must refresh the existing row instead of failing on the primary key or
 * leaving a second local agent behind.
 */
export async function registerLocalAgent(options: {
  agentId: string;
  label: string;
  tokenHash: string;
}): Promise<void> {
  await query(
    `INSERT INTO aether.host_agents (id, label, token_hash, owner_user_id, scope)
     VALUES ($1, $2, $3, NULL, 'local')
     ON CONFLICT (id) DO UPDATE
        SET label         = EXCLUDED.label,
            token_hash    = EXCLUDED.token_hash,
            scope         = 'local',
            owner_user_id = NULL,
            revoked_at    = NULL`,
    [options.agentId, options.label, options.tokenHash]
  );

  log.info({ agentId: options.agentId, scope: 'local' }, 'local host agent registered');
}

/**
 * Revokes an agent so its token stops working immediately.
 *
 * This is a soft revoke — `revoked_at` is stamped rather than the row deleted —
 * so the pairing stays in the audit history and cannot be silently reused.
 * `authenticateAgent` rejects any row carrying `revoked_at`, and `listAgents`
 * hides it, so a revoked agent is gone from every practical standpoint while
 * the record survives.
 */
export async function revokeAgent(agentId: string, ownerUserId: string): Promise<boolean> {
  const result = await query(
    `UPDATE aether.host_agents SET revoked_at = now()
     WHERE id = $1 AND (owner_user_id = $2 OR owner_user_id IS NULL) AND revoked_at IS NULL`,
    [agentId, ownerUserId]
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) log.warn({ agentId }, 'host agent revoked');
  return revoked;
}

/**
 * Lists an owner's active (non-revoked) agents, newest first.
 *
 * Local agents (`owner_user_id IS NULL`) are instance-scoped: they belong to no
 * single user, so they are listed for every owner rather than hidden from all.
 */
export async function listAgents(ownerUserId: string): Promise<AgentRecord[]> {
  const result = await query<{
    id: string;
    label: string;
    owner_user_id: string | null;
    created_at: string;
  }>(
    `SELECT id, label, owner_user_id, created_at
     FROM aether.host_agents
     WHERE (owner_user_id = $1 OR owner_user_id IS NULL) AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [ownerUserId]
  );
  return result.rows.map((row) => ({
    agentId: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * Authenticates an agent handshake. Throws `UnauthenticatedError` for unknown
 * ids and `ForbiddenError` for revoked agents so the two cases are
 * distinguishable in logs but both close the socket the same way.
 */
export async function authenticateAgent(agentId: string, token: string): Promise<AgentRecord> {
  const result = await query<{
    id: string;
    label: string;
    token_hash: string;
    owner_user_id: string | null;
    created_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id, label, token_hash, owner_user_id, created_at, revoked_at
     FROM aether.host_agents WHERE id = $1`,
    [agentId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new UnauthenticatedError('Unknown agent');
  }

  if (row.revoked_at) {
    throw new ForbiddenError('Agent has been revoked');
  }

  if (!safeEqualHex(hashToken(token), row.token_hash)) {
    throw new UnauthenticatedError('Invalid agent token');
  }

  return {
    agentId: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
