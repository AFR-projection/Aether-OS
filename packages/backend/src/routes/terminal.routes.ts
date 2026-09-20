import {
  createTerminalBodySchema,
  resizeBodySchema,
  terminalIdParamSchema,
  terminalInputBodySchema,
  type TerminalSessionSummary,
} from '@aether/shared';

import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { issueTicket } from '../security/ws-ticket.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  createHostSession,
  getOwnedHostSession,
  killHostSession,
  listHostSessionsForUser,
  reconcileHostSessionsForUser,
  resizeHostSession,
  writeHostInput,
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
    handler: async (request) => {
      const principal = requirePrincipal(request);

      // Before the list is built, so it describes what the agents still have. A
      // host shell that ended on its own — a typed `exit`, a killed process —
      // was otherwise reported running for as long as this process lived, since
      // the record here is written once from the create reply.
      await reconcileHostSessionsForUser(principal.user.id);

      // Workspace sessions carry no scope of their own — they are always
      // workspace-scoped — so they are tagged here to match the shape host
      // sessions already report, giving the client one uniformly-typed list it
      // can use to rebind a window to the right endpoint after a refresh.
      const workspace: TerminalSessionSummary[] = listSessionsForUser(principal.user.id).map(
        (session) => ({ ...session, scope: 'workspace' })
      );

      return {
        data: {
          sessions: [...workspace, ...listHostSessionsForUser(principal.user.id)],
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
            ...(body.command !== undefined ? { command: body.command } : {}),
          })
        : await createSession({
            ownerUserId: principal.user.id,
            cols: body.cols,
            rows: body.rows,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.shell !== undefined ? { shell: body.shell } : {}),
            ...(body.command !== undefined ? { command: body.command } : {}),
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

  // These three carry the same session id as the socket path and must serve
  // both scopes, exactly as the socket does. A host-scope session is a shell on
  // the agent, so it lives in host-terminal.service and not in the local
  // registry; looking it up locally only finds nothing and answers 404 for a
  // session the caller owns and can see in `GET /api/terminal/sessions`. The
  // delete handler below already branches this way.
  app.get('/api/terminal/sessions/:id', { preHandler: guards }, async (request) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');

    // Reconciled for the same reason the list is: this must not answer "running"
    // for a shell the agent has already watched exit, or the two endpoints
    // disagree about the same session. It only ever touches this caller's own
    // records, so an id that is not theirs still reaches the ownership check
    // below and 404s there.
    await reconcileHostSessionsForUser(principal.user.id);

    const hostRecord = getOwnedHostSession(params.id, principal.user.id);
    if (hostRecord !== null) return { data: hostRecord.session };

    return { data: getOwnedSession(params.id, principal.user.id) };
  });

  app.post('/api/terminal/sessions/:id/input', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');
    const body = parseOrThrow(terminalInputBodySchema, request.body, 'terminal input');

    // A host frame has to travel back over the agent connection, so it is
    // written asynchronously; a local one is applied to the in-process PTY.
    if (getOwnedHostSession(params.id, principal.user.id) !== null) {
      await writeHostInput(params.id, principal.user.id, body.data);
    } else {
      writeInput(params.id, principal.user.id, body.data);
    }
    return reply.status(204).send();
  });

  app.post('/api/terminal/sessions/:id/resize', { preHandler: guards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseOrThrow(terminalIdParamSchema, request.params, 'session id');
    const body = parseOrThrow(resizeBodySchema, request.body, 'terminal resize');

    if (getOwnedHostSession(params.id, principal.user.id) !== null) {
      await resizeHostSession(params.id, principal.user.id, body.cols, body.rows);
    } else {
      resizeSession(params.id, principal.user.id, body.cols, body.rows);
    }
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
