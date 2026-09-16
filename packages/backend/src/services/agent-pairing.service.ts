import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('agent-pairing');

export interface AgentRecord {
  agentId: string;
  label: string;
  ownerUserId: string;
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

/** Revokes an agent so its token stops working immediately. */
export async function revokeAgent(agentId: string, ownerUserId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM aether.host_agents WHERE id = $1 AND owner_user_id = $2`,
    [agentId, ownerUserId]
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) log.warn({ agentId }, 'host agent revoked');
  return revoked;
}

export async function listAgents(ownerUserId: string): Promise<AgentRecord[]> {
  const result = await query<{
    id: string;
    label: string;
    owner_user_id: string;
    created_at: string;
  }>(
    `SELECT id, label, owner_user_id, created_at
     FROM aether.host_agents WHERE owner_user_id = $1 ORDER BY created_at DESC`,
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
    owner_user_id: string;
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

  void config;
  return {
    agentId: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
