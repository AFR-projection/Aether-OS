
import { cache } from '../cache/index.js';
import { config } from '../config.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { findSessionById, isSessionActive, touchSession, verifyAccessToken } from '../services/auth.service.js';
import { toPublicUser, findUserById } from '../services/user.service.js';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';

import type { AuthenticatedPrincipal, Permission } from '@aether/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate`. Present on every route that requires auth. */
    principal?: AuthenticatedPrincipal;
  }
}

const SESSION_CACHE_TTL_MS = 5_000;

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * Fastify pre-handler that requires a valid access token.
 *
 * Two checks are performed. The JWT signature proves the token was issued by
 * this instance and has not expired. The session lookup proves the session has
 * not been revoked since — a stateless JWT alone cannot be revoked, which is
 * why logout and "revoke all sessions" would otherwise be cosmetic.
 *
 * The session row is cached for a few seconds; revocation therefore takes up to
 * five seconds to propagate. That is an explicit trade-off, documented in
 * `KNOWN-LIMITATIONS.md`.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new UnauthenticatedError('Authorization header is missing or malformed');
  }

  const claims = verifyAccessToken(token);

  const cacheKey = `session:${claims.sid}`;
  let active = await cache.get<boolean>(cacheKey);

  if (active === null) {
    const session = await findSessionById(claims.sid);
    active = session !== null && isSessionActive(session);
    await cache.set(cacheKey, active, SESSION_CACHE_TTL_MS);
  }

  if (!active) {
    throw new UnauthenticatedError('Session has been revoked or has expired', 'TOKEN_INVALID');
  }

  const user = await findUserById(claims.sub);
  if (!user || !user.is_active) {
    throw new UnauthenticatedError('Account is disabled or no longer exists');
  }

  request.principal = {
    user: toPublicUser(user),
    sessionId: claims.sid,
  };

  // Best-effort activity tracking; never blocks the request path.
  void touchSession(claims.sid).catch(() => undefined);
}

/** Returns the authenticated principal, or throws. Use inside authenticated routes. */
export function requirePrincipal(request: FastifyRequest): AuthenticatedPrincipal {
  if (!request.principal) {
    throw new UnauthenticatedError();
  }
  return request.principal;
}

/**
 * Builds a pre-handler that requires a permission.
 *
 * Must be registered *after* `authenticate` on the same route.
 */
export function requirePermission(permission: Permission) {
  return async function permissionGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const principal = requirePrincipal(request);

    if (!principal.user.permissions.includes(permission)) {
      await recordAuditEvent({
        action: 'permission.denied',
        outcome: 'failure',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        sessionId: principal.sessionId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        target: request.url,
        metadata: { requiredPermission: permission, role: principal.user.role },
      });

      throw new ForbiddenError(`This action requires the "${permission}" permission`, {
        requiredPermission: permission,
      });
    }
  };
}

/** Paths that never require authentication. */
export const PUBLIC_PATHS: readonly string[] = ['/health', '/api/health', '/api/auth/login', '/api/auth/refresh', '/api/auth/bootstrap-status'];

export function isPublicPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return PUBLIC_PATHS.includes(pathname);
}

/** Exposed for tests and diagnostics. */
export const authConfig = {
  trustProxyHops: config.TRUST_PROXY_HOPS,
  sessionCacheTtlMs: SESSION_CACHE_TTL_MS,
};
