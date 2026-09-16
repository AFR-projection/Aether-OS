import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { toPublicUser, type UserRow } from './user.service.js';
import { query, queryOne } from '../db/pool.js';
import { parseDurationMs } from '../utils/duration.js';
import { UnauthenticatedError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('auth');

/** bcrypt cost. 12 keeps a single hash in the ~250 ms range on server hardware. */
const BCRYPT_COST = 12;

/**
 * A pre-computed hash of a random string.
 *
 * When a login attempt names a user that does not exist we still run a bcrypt
 * comparison against this value. Without it, "unknown user" would return in
 * microseconds while "wrong password" takes ~250 ms, letting an attacker
 * enumerate valid usernames by timing alone.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO1XwZ8Z2YQ5gQ4lQ0lQ0lQ0lQ0lQ0lQ0';

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verifies a password against a bcrypt hash.
 *
 * Returns `false` rather than throwing for malformed hashes so a corrupted row
 * cannot be distinguished from a wrong password by the caller's error handling.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/** Runs a bcrypt comparison against a throwaway hash to equalise timing. */
export async function burnPasswordComparison(plaintext: string): Promise<void> {
  await bcrypt.compare(plaintext, DUMMY_HASH).catch(() => false);
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  username: string;
  role: string;
}

const ACCESS_TOKEN_TTL_MS = parseDurationMs(config.JWT_ACCESS_TOKEN_EXPIRY);
const REFRESH_TOKEN_TTL_MS = parseDurationMs(config.JWT_REFRESH_TOKEN_EXPIRY);

export function signAccessToken(claims: AccessTokenClaims): { token: string; expiresIn: number } {
  const expiresInSeconds = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

  const token = jwt.sign(
    { sub: claims.sub, sid: claims.sid, username: claims.username, role: claims.role },
    config.JWT_SECRET,
    // A numeric lifetime avoids parsing the configured string a second time
    // and keeps the token's `exp` exactly in step with `parseDurationMs`.
    { algorithm: 'HS256', expiresIn: expiresInSeconds, issuer: 'aether' }
  );

  return { token, expiresIn: expiresInSeconds };
}

/**
 * Verifies and decodes an access token.
 *
 * The algorithm is pinned to HS256: accepting whatever the token's header
 * claims is the classic `alg: none` / algorithm-confusion vulnerability.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'aether',
    });

    if (typeof decoded === 'string') {
      throw new UnauthenticatedError('Malformed token');
    }

    const { sub, sid, username, role } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      throw new UnauthenticatedError('Malformed token payload', 'TOKEN_INVALID');
    }

    return {
      sub,
      sid,
      username: typeof username === 'string' ? username : '',
      role: typeof role === 'string' ? role : '',
    };
  } catch (error) {
    if (error instanceof UnauthenticatedError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthenticatedError('Access token expired', 'TOKEN_EXPIRED');
    }
    throw new UnauthenticatedError('Invalid access token', 'TOKEN_INVALID');
  }
}

/** Refresh tokens are opaque 256-bit random values, not JWTs. */
function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Refresh tokens are stored as a SHA-256 digest.
 *
 * A database dump therefore does not hand an attacker usable session tokens.
 * SHA-256 (not bcrypt) is correct here: the input is already 256 bits of
 * entropy, so there is nothing to brute-force and lookups must be fast.
 */
function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function createSession(params: {
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO aether.sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.userId, hashRefreshToken(refreshToken), params.userAgent, params.ipAddress, expiresAt]
  );

  if (!row) throw new Error('INSERT INTO aether.sessions returned no row');

  return { sessionId: row.id, refreshToken, expiresAt };
}

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function findSessionById(sessionId: string): Promise<SessionRow | null> {
  const row = await queryOne<SessionRow>(
    `SELECT id, user_id, refresh_token_hash, user_agent, ip_address,
            created_at, last_seen_at, expires_at, revoked_at
       FROM aether.sessions WHERE id = $1`,
    [sessionId]
  );
  return row ?? null;
}

/** Looks a session up by its refresh token. Uses the unique index on the hash. */
export async function findSessionByRefreshToken(refreshToken: string): Promise<SessionRow | null> {
  const row = await queryOne<SessionRow>(
    `SELECT id, user_id, refresh_token_hash, user_agent, ip_address,
            created_at, last_seen_at, expires_at, revoked_at
       FROM aether.sessions WHERE refresh_token_hash = $1`,
    [hashRefreshToken(refreshToken)]
  );
  return row ?? null;
}

/** True when the session exists, is not revoked, and has not expired. */
export function isSessionActive(session: SessionRow): boolean {
  return session.revoked_at === null && session.expires_at.getTime() > Date.now();
}

export function sessionMatchesRefreshToken(session: SessionRow, refreshToken: string): boolean {
  const expected = Buffer.from(session.refresh_token_hash, 'hex');
  const actual = Buffer.from(hashRefreshToken(refreshToken), 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function touchSession(sessionId: string): Promise<void> {
  await query('UPDATE aether.sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await query(
    `UPDATE aether.sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason]
  );
}

export async function revokeAllSessionsForUser(userId: string, reason: string): Promise<number> {
  const result = await query(
    `UPDATE aether.sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  );
  return result.rowCount ?? 0;
}

export async function listSessionsForUser(userId: string): Promise<SessionRow[]> {
  const result = await query<SessionRow>(
    `SELECT id, user_id, refresh_token_hash, user_agent, ip_address,
            created_at, last_seen_at, expires_at, revoked_at
       FROM aether.sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Rotation: a refresh consumes the old token and issues a new one.
 *
 * If a token that was already rotated is presented again, the whole session is
 * revoked. That is the standard reuse-detection heuristic: it means either the
 * token was stolen, or the legitimate client is replaying — both warrant a
 * forced re-login.
 */
export async function rotateSession(
  session: SessionRow,
  presentedToken: string
): Promise<IssuedSession> {
  const nextToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const row = await queryOne<{ id: string }>(
    `UPDATE aether.sessions
        SET refresh_token_hash = $2, expires_at = $3, last_seen_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND refresh_token_hash = $4
      RETURNING id`,
    [session.id, hashRefreshToken(nextToken), expiresAt, hashRefreshToken(presentedToken)]
  );

  if (!row) {
    log.warn({ sessionId: session.id }, 'refresh token reuse detected; revoking session');
    await revokeSession(session.id, 'refresh_token_reuse');
    throw new UnauthenticatedError('Session is no longer valid', 'TOKEN_INVALID');
  }

  return { sessionId: session.id, refreshToken: nextToken, expiresAt };
}

export function buildLoginResponse(
  user: UserRow,
  session: IssuedSession
): {
  user: ReturnType<typeof toPublicUser>;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
} {
  const { token, expiresIn } = signAccessToken({
    sub: user.id,
    sid: session.sessionId,
    username: user.username,
    role: user.role,
  });

  return {
    user: toPublicUser(user),
    accessToken: token,
    refreshToken: session.refreshToken,
    expiresIn,
    tokenType: 'Bearer',
  };
}

export const SESSION_TTL = {
  accessTokenMs: ACCESS_TOKEN_TTL_MS,
  refreshTokenMs: REFRESH_TOKEN_TTL_MS,
};
