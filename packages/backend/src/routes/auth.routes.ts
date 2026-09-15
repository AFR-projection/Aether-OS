import { timingSafeEqual } from 'node:crypto';

import {
  bootstrapRequestSchema,
  changePasswordRequestSchema,
  createUserRequestSchema,
  listSessionsResponseSchema,
  loginRequestSchema,
  paginationSchema,
  refreshRequestSchema,
  sessionIdParamSchema,
  updateUserRequestSchema,
  userIdParamSchema,
  type AuthSession,
} from '@aether/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  buildLoginResponse,
  burnPasswordComparison,
  createSession,
  findSessionById,
  findSessionByRefreshToken,
  hashPassword,
  isSessionActive,
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSession,
  rotateSession,
  sessionMatchesRefreshToken,
  verifyPassword,
} from '../services/auth.service.js';
import { killSessionsForUser } from '../services/terminal.service.js';
import {
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listUsers,
  recordLoginOutcome,
  toPublicUser,
  updateUser,
} from '../services/user.service.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validate.js';

/** Failed attempts before an account is temporarily locked. */
const LOCK_THRESHOLD = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;

function requestContext(request: FastifyRequest): { ipAddress: string; userAgent: string | null } {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Reports whether the instance still needs its first (owner) account.
   * Unauthenticated by necessity: the login screen needs it before any
   * credentials exist.
   */
  app.get('/api/auth/bootstrap-status', async () => {
    const users = await countUsers();
    return { data: { requiresBootstrap: users === 0 } };
  });

  /**
   * Creates the first owner account.
   *
   * Only permitted while zero users exist, and — when the installer has set
   * one — only with the correct bootstrap token. The installer writes the token
   * to a root-owned file and never prints it, so a remote attacker who finds an
   * unclaimed instance cannot claim it.
   */
  app.post('/api/auth/bootstrap', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const body = parseOrThrow(bootstrapRequestSchema, request.body, 'bootstrap request');
      const users = await countUsers();

      if (users > 0) {
        throw new ConflictError('This instance has already been set up');
      }

      if (config.AETHER_BOOTSTRAP_TOKEN) {
        const provided = request.headers['x-bootstrap-token'];
        const providedValue = Array.isArray(provided) ? provided[0] : provided;

        if (!providedValue || !constantTimeEquals(providedValue, config.AETHER_BOOTSTRAP_TOKEN)) {
          await recordAuditEvent({
            action: 'auth.bootstrap',
            outcome: 'failure',
            ...requestContext(request),
            metadata: { reason: 'invalid_bootstrap_token' },
          });
          throw new ForbiddenError('A valid bootstrap token is required');
        }
      }

      const passwordHash = await hashPassword(body.password);
      const user = await createUser({
        username: body.username,
        email: body.email ?? null,
        passwordHash,
        role: 'owner',
      });

      const session = await createSession({
        userId: user.id,
        userAgent: request.headers['user-agent'] ?? null,
        ipAddress: request.ip,
      });

      await recordAuditEvent({
        action: 'auth.bootstrap',
        outcome: 'success',
        actorUserId: user.id,
        actorUsername: user.username,
        sessionId: session.sessionId,
        ...requestContext(request),
      });

      return reply.status(201).send({ data: buildLoginResponse(user, session) });
    },
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const body = parseOrThrow(loginRequestSchema, request.body, 'login request');
      const user = await findUserByUsername(body.username);

      if (!user) {
        // Equalise timing so an unknown username is indistinguishable from a
        // wrong password.
        await burnPasswordComparison(body.password);
        await recordAuditEvent({
          action: 'auth.login.failure',
          outcome: 'failure',
          actorUsername: body.username,
          ...requestContext(request),
          metadata: { reason: 'unknown_user' },
        });
        throw new UnauthenticatedError('Invalid username or password', 'INVALID_CREDENTIALS');
      }

      if (!user.is_active) {
        await recordAuditEvent({
          action: 'auth.login.failure',
          outcome: 'failure',
          actorUserId: user.id,
          actorUsername: user.username,
          ...requestContext(request),
          metadata: { reason: 'account_disabled' },
        });
        throw new UnauthenticatedError('Invalid username or password', 'INVALID_CREDENTIALS');
      }

      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        await recordAuditEvent({
          action: 'auth.login.failure',
          outcome: 'failure',
          actorUserId: user.id,
          actorUsername: user.username,
          ...requestContext(request),
          metadata: { reason: 'account_locked' },
        });
        throw new UnauthenticatedError(
          'Account is temporarily locked after repeated failed sign-in attempts',
          'INVALID_CREDENTIALS',
        );
      }

      const passwordValid = await verifyPassword(body.password, user.password_hash);

      if (!passwordValid) {
        await recordLoginOutcome(user.id, 'failure', LOCK_THRESHOLD, LOCK_DURATION_MS);
        await recordAuditEvent({
          action: 'auth.login.failure',
          outcome: 'failure',
          actorUserId: user.id,
          actorUsername: user.username,
          ...requestContext(request),
          metadata: { reason: 'bad_password' },
        });
        throw new UnauthenticatedError('Invalid username or password', 'INVALID_CREDENTIALS');
      }

      await recordLoginOutcome(user.id, 'success', LOCK_THRESHOLD, LOCK_DURATION_MS);

      const session = await createSession({
        userId: user.id,
        userAgent: request.headers['user-agent'] ?? null,
        ipAddress: request.ip,
      });

      await recordAuditEvent({
        action: 'auth.login.success',
        outcome: 'success',
        actorUserId: user.id,
        actorUsername: user.username,
        sessionId: session.sessionId,
        ...requestContext(request),
      });

      const refreshed = await findUserById(user.id);
      return reply.send({ data: buildLoginResponse(refreshed ?? user, session) });
    },
  });

  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const body = parseOrThrow(refreshRequestSchema, request.body, 'refresh request');

      // The session id travels inside the access token, but an expired access
      // token is exactly the case this endpoint exists for. The refresh token
      // itself is looked up by its hash, which is unique per session.
      const session = await findSessionByRefreshToken(body.refreshToken);

      if (!session || !isSessionActive(session)) {
        throw new UnauthenticatedError('Session is no longer valid', 'TOKEN_INVALID');
      }

      if (!sessionMatchesRefreshToken(session, body.refreshToken)) {
        throw new UnauthenticatedError('Session is no longer valid', 'TOKEN_INVALID');
      }

      const user = await findUserById(session.user_id);
      if (!user || !user.is_active) {
        await revokeSession(session.id, 'account_unavailable');
        throw new UnauthenticatedError('Account is disabled or no longer exists');
      }

      const rotated = await rotateSession(session, body.refreshToken);

      await recordAuditEvent({
        action: 'auth.token.refresh',
        outcome: 'success',
        actorUserId: user.id,
        actorUsername: user.username,
        sessionId: rotated.sessionId,
        ...requestContext(request),
      });

      return reply.send({ data: buildLoginResponse(user, rotated) });
    },
  });

  app.post('/api/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    await revokeSession(principal.sessionId, 'user_logout');
    killSessionsForUser(principal.user.id, 'logout');

    await recordAuditEvent({
      action: 'auth.logout',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ...requestContext(request),
    });

    return reply.status(204).send();
  });

  /** Verifies the current access token and returns the caller's profile. */
  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    return { data: principal.user };
  });

  /** Lists the caller's active sessions, for the Settings app. */
  app.get('/api/auth/sessions', { preHandler: authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    const rows = await listSessionsForUser(principal.user.id);

    const sessions = rows.map(
      (row): AuthSession => ({
        id: row.id,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        current: row.id === principal.sessionId,
      }),
    );

    return { data: parseOrThrow(listSessionsResponseSchema, sessions) };
  });

  app.delete('/api/auth/sessions/:id', { preHandler: authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(sessionIdParamSchema, request.params, 'session id');

    const session = await findSessionById(params.id);
    if (!session || session.user_id !== principal.user.id) {
      // Same response whether the session is someone else's or does not exist.
      throw new NotFoundError('Session not found');
    }

    await revokeSession(params.id, 'user_revoked');

    await recordAuditEvent({
      action: 'auth.session.revoked',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      target: params.id,
      ...requestContext(request),
    });

    return reply.status(204).send();
  });

  app.post('/api/auth/password', { preHandler: authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseOrThrow(changePasswordRequestSchema, request.body, 'password change');

    const user = await findUserById(principal.user.id);
    if (!user) throw new NotFoundError('User not found');

    const valid = await verifyPassword(body.currentPassword, user.password_hash);
    if (!valid) {
      throw new UnauthenticatedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }

    await updateUser(user.id, { passwordHash: await hashPassword(body.newPassword) });

    // Every other session is revoked; the current one is kept alive so the user
    // is not thrown out of the tab they changed the password in.
    const revoked = await revokeAllSessionsForUser(user.id, 'password_changed');
    await createSession({
      userId: user.id,
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });

    await recordAuditEvent({
      action: 'settings.updated',
      outcome: 'success',
      actorUserId: user.id,
      actorUsername: user.username,
      sessionId: principal.sessionId,
      metadata: { change: 'password', sessionsRevoked: revoked },
      ...requestContext(request),
    });

    return reply.send({ data: { sessionsRevoked: revoked } });
  });
}

/** User administration. Requires the `users:manage` permission. */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/users',
    { preHandler: [authenticate, requirePermission('users:manage')] },
    async (request) => {
      const pagination = parseOrThrow(paginationSchema, request.query, 'pagination');
      const users = await listUsers();
      const slice = users.slice(pagination.offset, pagination.offset + pagination.limit);
      return { data: { users: slice.map(toPublicUser), total: users.length } };
    },
  );

  app.post(
    '/api/users',
    { preHandler: [authenticate, requirePermission('users:manage')] },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = parseOrThrow(createUserRequestSchema, request.body, 'user');

      if (body.role === 'owner') {
        throw new ForbiddenError('The owner role is created by the installer, not assigned here');
      }

      const existing = await findUserByUsername(body.username);
      if (existing) throw new ConflictError('That username is already taken');

      const user = await createUser({
        username: body.username,
        email: body.email ?? null,
        passwordHash: await hashPassword(body.password),
        role: body.role,
      });

      await recordAuditEvent({
        action: 'user.created',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        sessionId: principal.sessionId,
        target: user.id,
        metadata: { username: user.username, role: user.role },
        ...requestContext(request),
      });

      return reply.status(201).send({ data: toPublicUser(user) });
    },
  );

  app.patch(
    '/api/users/:id',
    { preHandler: [authenticate, requirePermission('users:manage')] },
    async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(userIdParamSchema, request.params, 'user id');
      const body = parseOrThrow(updateUserRequestSchema, request.body, 'user update');

      const target = await findUserById(params.id);
      if (!target) throw new NotFoundError('User not found');

      if (target.role === 'owner' && (body.role !== undefined || body.isActive === false)) {
        throw new ForbiddenError('The owner account cannot be demoted or disabled here');
      }

      const updated = await updateUser(params.id, {
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      });

      if (body.isActive === false) {
        await revokeAllSessionsForUser(params.id, 'account_disabled');
        killSessionsForUser(params.id, 'account_disabled');
      }

      await recordAuditEvent({
        action: 'user.updated',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        sessionId: principal.sessionId,
        target: params.id,
        metadata: { ...body },
        ...requestContext(request),
      });

      return { data: updated ? toPublicUser(updated) : null };
    },
  );

  app.delete(
    '/api/users/:id',
    { preHandler: [authenticate, requirePermission('users:manage')] },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(userIdParamSchema, request.params, 'user id');

      if (params.id === principal.user.id) {
        throw new ForbiddenError('You cannot delete your own account');
      }

      const target = await findUserById(params.id);
      if (!target) throw new NotFoundError('User not found');
      if (target.role === 'owner') {
        throw new ForbiddenError('The owner account cannot be deleted');
      }

      await deleteUser(params.id);

      await recordAuditEvent({
        action: 'user.deleted',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        sessionId: principal.sessionId,
        target: params.id,
        metadata: { username: target.username },
        ...requestContext(request),
      });

      return reply.status(204).send();
    },
  );
}

/** Constant-time string comparison that does not short-circuit on length. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  const length = Math.max(bufferA.length, bufferB.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  bufferA.copy(paddedA);
  bufferB.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && bufferA.length === bufferB.length;
}
