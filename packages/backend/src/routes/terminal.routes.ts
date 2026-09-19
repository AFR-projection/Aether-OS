import {
  createTerminalBodySchema,
  resizeBodySchema,
  terminalIdParamSchema,
  terminalInputBodySchema,
} from '@aether/shared';

import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { issueTicket } from '../security/ws-ticket.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  createHostSession,
  getOwnedHostSession,
  killHostSession,
  listHostSessionsForUser,
} from '../services/host-terminal.service.js';
import {
  createSession,
  getOwnedSession,
  isTerminalAvailable,
  killSession,
  listSessionsForUser,
  resizeSession,
  terminalStats,
  writeInput,
} from '../services/terminal.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance } from 'fastify';

interface RequestScope {
  scope: 'workspace' | 'host';
  agentId: string | null;
}

/** Splits `scope`/`agentId` off a body so the strict schema sees only its own fields. */
function readScope(source: unknown): { scope: RequestScope; rest: Record<string, unknown> } {
  const record = (typeof source === 'object' && source !== null ? source : {}) as Record<
    string,
    unknown
  >;
  const { scope: scopeRaw, agentId: agentIdRaw, ...rest } = record;
  const scope = scopeRaw === 'host' ? 'host' : 'workspace';
  const agentId = typeof agentIdRaw === 'string' && agentIdRaw.length > 0 ? agentIdRaw : null;
  return { scope: { scope, agentId }, rest };
}

/** Authorizes access to a session in either scope; throws 404 when the caller does not own it. */
function assertOwnsSession(sessionId: string, userId: string): void {
  if (getOwnedHostSession(sessionId, userId) !== null) return;
  // Local check throws NotFoundError when the user does not own a local session.
  getOwnedSession(sessionId, userId);
}

/** Resolves the target agent id for a host-scope terminal, or fails with a clear reason. */
function requireAgentId(scope: RequestScope): string {
  if (scope.scope !== 'host' || scope.agentId === null) {
    throw new ValidationError('A host agent id is required for host-scope terminals');
  }
  return scope.agentId;
}

export function registerTerminalRoutes(app: FastifyInstance): void {
  const guards = [authenticate, requirePermission('terminal:create')];

  app.get('/api/terminal/status', { preHandler: [authenticate] }, () => ({
    data: terminalStats(),
  }));

  app.get('/api/terminal/sessions', {
    preHandler: guards,
    handler: (request) => {
      const principal = requirePrincipal(request);
      return {
        data: {
          sessions: [
            ...listSessionsForUser(principal.user.id),
            ...listHostSessionsForUser(principal.user.id),
          ],
        },
      };
    },
  });

  app.post('/api/terminal/sessions', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body ?? {});
    const body = parseOrThrow(createTerminalBodySchema, rest, 'terminal session');

    const session =
      scope.scope === 'host'
        ? await createHostSession(requireAgentId(scope), principal.user.id, {
            cols: body.cols,
            rows: body.rows,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.shell !== undefined ? { shell: body.shell } : {}),
          })
        : await createSession({
            ownerUserId: principal.user.id,
            cols: body.cols,
            rows: body.rows,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.shell !== undefined ? { shell: body.shell } : {}),
          });

    await recordAuditEvent({
      action: 'terminal.created',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: session.id,
      metadata: { shell: session.shell, pid: session.pid, scope: scope.scope },
    });

    return reply.status(201).send({ data: session });
  });

  app.get('/api/terminal/sessions/:id', { preHandler: guards }, (request) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');
    return { data: getOwnedSession(params.id, principal.user.id) };
  });

  app.post('/api/terminal/sessions/:id/input', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');
    const body = parseOrThrow(terminalInputBodySchema, request.body, 'terminal input');

    writeInput(params.id, principal.user.id, body.data);
    return reply.status(204).send();
  });

  app.post('/api/terminal/sessions/:id/resize', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');
    const body = parseOrThrow(resizeBodySchema, request.body, 'terminal resize');

    resizeSession(params.id, principal.user.id, body.cols, body.rows);
    return reply.status(204).send();
  });

  app.delete('/api/terminal/sessions/:id', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');

    // Ownership is checked before the kill so one user cannot terminate
    // another user's shell by guessing a session id.
    const hostRecord = getOwnedHostSession(params.id, principal.user.id);
    if (hostRecord !== null) {
      await killHostSession(params.id, principal.user.id);
    } else {
      getOwnedSession(params.id, principal.user.id);
      if (!killSession(params.id, 'user_requested')) {
        throw new NotFoundError('Terminal session does not exist', { sessionId: params.id });
      }
    }

    await recordAuditEvent({
      action: 'terminal.killed',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: params.id,
    });

    return reply.status(204).send();
  });

  app.get('/api/terminal/available', () => ({ data: { available: isTerminalAvailable() } }));

  /**
   * Issues a single-use ticket for the WebSocket handshake.
   *
   * The browser cannot set an `Authorization` header during a WebSocket
   * upgrade, so a short-lived ticket is fetched over an authenticated request
   * and presented as a query parameter. See `security/ws-ticket.ts`.
   */
  app.post(
    '/api/terminal/sessions/:id/ticket',
    { preHandler: [authenticate, requirePermission('terminal:attach')] },
    async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');

      assertOwnsSession(params.id, principal.user.id);

      return { data: await issueTicket(params.id, principal.user.id) };
    }
  );
}
