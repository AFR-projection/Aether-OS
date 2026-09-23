import {
  DEFAULT_EXECUTION_UNIT_LIMITS,
  createUnitBodySchema,
  hasRequestedRlimits,
  unitIdParamSchema,
  unitLogQuerySchema,
  unitScopedQuerySchema,
  unitSignalBodySchema,
  unitsQuerySchema,
  type UnitListResponse,
  type UnitLogResponse,
  type UnitResponse,
} from '@aether/shared';

import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { issueTicket } from '../security/ws-ticket.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  assertMayUseRequestedLimits,
  createHostUnit,
  getHostUnit,
  killHostUnit,
  listHostUnits,
  readHostUnitLog,
  restartHostUnit,
  signalHostUnit,
} from '../services/host-units.service.js';
import { ForbiddenError } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The execution-unit API — the HTTP surface over the agent's `units.*` verbs.
 *
 * A unit is a real process on a connected host: a shell, a one-shot command, and
 * (once their supervisors exist) a worker or a service. This is the one surface
 * the Terminal, Code Studio's Run panel, and later workers/services/deployments
 * all reach through, so the ownership and permission rules live here once rather
 * than being re-derived per consumer.
 *
 * ## Why every route names its host in the query
 *
 * A unit id is unique to the agent that holds it, and the backend keeps no unit
 * bookkeeping (see `host-units.service` for why that statelessness is the right
 * answer to backend-restart recovery). So a request that targets one unit says
 * which host it means — `?agentId=` — rather than the backend guessing.
 *
 * ## Permissions, and the two conditional ones
 *
 * The `execution:*` split mirrors how reversible each act is: reading state is
 * `execution:read`, sending a signal is `execution:signal`, ending a unit is
 * `execution:delete`, and creating (or restarting, which creates a fresh
 * process) is `execution:create`. Two are conditional and cannot be a static
 * route guard:
 * - `scope=all` on the list drops the owner filter so an administrator can see
 *   what a shared host is running. Gated by `execution:manage-others` here,
 *   before the unfiltered list is ever requested from the agent.
 * - Limits above the instance defaults need `execution:limits:raise`. Checked in
 *   the service (`assertMayUseRequestedLimits`), because a request that stays
 *   within the defaults needs no such permission and a guard cannot express
 *   "only when you asked for more".
 */
export function registerUnitRoutes(app: FastifyInstance): void {
  app.get('/api/units', {
    preHandler: [authenticate, requirePermission('execution:read')],
    handler: async (request) => {
      const principal = requirePrincipal(request);
      const query = parseOrThrow(unitsQuerySchema, request.query, 'unit query');

      // `all` is a privileged view of everyone's units, so the permission is
      // checked before the unfiltered request is sent — never after, which would
      // leak the list to the agent round-trip even on a refusal.
      if (
        query.scope === 'all' &&
        !principal.user.permissions.includes('execution:manage-others')
      ) {
        throw new ForbiddenError(
          'Listing every user\'s units requires the "execution:manage-others" permission',
          { requiredPermission: 'execution:manage-others' }
        );
      }

      const units = await listHostUnits(query.agentId, principal.user.id, query.scope);
      const body: UnitListResponse = { units, total: units.length, agentId: query.agentId };
      return { data: body };
    },
  });

  app.get('/api/units/:id', {
    preHandler: [authenticate, requirePermission('execution:read')],
    handler: async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');
      const query = parseOrThrow(unitScopedQuerySchema, request.query, 'unit query');

      const unit = await getHostUnit(query.agentId, params.id, principal.user.id);
      const body: UnitResponse = { unit };
      return { data: body };
    },
  });

  app.get('/api/units/:id/log', {
    preHandler: [authenticate, requirePermission('execution:read')],
    handler: async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');
      const scoped = parseOrThrow(unitScopedQuerySchema, request.query, 'unit query');
      const query = parseOrThrow(unitLogQuerySchema, request.query, 'unit log query');

      const read = await readHostUnitLog(scoped.agentId, params.id, principal.user.id, query);
      const body: UnitLogResponse = {
        unitId: params.id,
        contentBase64: read.contentBase64,
        offset: read.offset,
        retainedBytes: read.retainedBytes,
        droppedBytes: read.droppedBytes,
        ended: read.ended,
      };
      return { data: body };
    },
  });

  app.post('/api/units', {
    preHandler: [authenticate, requirePermission('execution:create')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = parseOrThrow(createUnitBodySchema, request.body, 'unit');

      // Refused before the unit exists, not after: a caller asking for a bigger
      // output ring or a higher restart ceiling than the instance default is
      // told to change the request rather than handed a smaller unit silently.
      assertMayUseRequestedLimits(
        body,
        principal.user.permissions.includes('execution:limits:raise')
      );

      const unit = await createHostUnit(principal.user.id, body);

      void recordUnitAudit(request, 'unit.created', unit.id, {
        agentId: body.agentId,
        kind: unit.kind,
        pid: unit.process.pid,
        requestId: body.requestId ?? null,
      });

      const hasNonDefaultWallClock = body.wallClockMs !== null;
      const hasNonDefaultOutput =
        body.maxOutputBytes !== DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes;
      const hasNonDefaultRestart =
        (body.restart?.policy ?? 'never') !== 'never' || (body.restart?.maxAttempts ?? 0) > 0;
      const requestedRlimits = {
        addressSpaceBytes: body.rlimits?.addressSpaceBytes ?? null,
        cpuSeconds: body.rlimits?.cpuSeconds ?? null,
        maxOpenFiles: body.rlimits?.maxOpenFiles ?? null,
        coreDumpBytes: body.rlimits?.coreDumpBytes ?? null,
      };
      const hasNonDefaultRlimits = hasRequestedRlimits(requestedRlimits);
      const hasNonDefaultLimit =
        hasNonDefaultWallClock ||
        hasNonDefaultOutput ||
        hasNonDefaultRestart ||
        hasNonDefaultRlimits;

      // Audit limit application when non-default limits were requested and applied.
      // "limit-change" means a limit that was explicitly set, not merely the
      // defaults — and it fires even when the caller held `limits:raise`,
      // because the permission being used is part of what the audit records.
      // `effective.rlimits.enforced` records whether the host actually applied
      // the ulimits (false on Windows, or when none were requested), so the log
      // never claims a bound is in force when the platform could not set it.
      if (hasNonDefaultLimit) {
        void recordUnitAudit(request, 'unit.limits-applied', unit.id, {
          agentId: body.agentId,
          requested: {
            wallClockMs: body.wallClockMs,
            maxOutputBytes: body.maxOutputBytes,
            restartPolicy: body.restart?.policy ?? 'never',
            restartMaxAttempts: body.restart?.maxAttempts ?? 0,
            rlimits: requestedRlimits,
          },
          effective: {
            wallClockMs: unit.limits.wallClockMs,
            maxOutputBytes: unit.limits.maxOutputBytes,
            graceMs: unit.limits.graceMs,
            rlimits: {
              addressSpaceBytes: unit.limits.addressSpaceBytes,
              cpuSeconds: unit.limits.cpuSeconds,
              maxOpenFiles: unit.limits.maxOpenFiles,
              coreDumpBytes: unit.limits.coreDumpBytes,
              enforced: unit.limits.enforced,
            },
          },
          usedRaisePermission: principal.user.permissions.includes('execution:limits:raise'),
        });
      }

      const payload: UnitResponse = { unit };
      return reply.status(201).send({ data: payload });
    },
  });

  app.post('/api/units/:id/signal', {
    preHandler: [authenticate, requirePermission('execution:signal')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');
      const query = parseOrThrow(unitScopedQuerySchema, request.query, 'unit query');
      const body = parseOrThrow(unitSignalBodySchema, request.body, 'unit signal');

      const result = await signalHostUnit(
        query.agentId,
        params.id,
        principal.user.id,
        body.signal,
        body.escalateAfterMs
      );

      await recordUnitAudit(request, 'unit.signalled', params.id, {
        agentId: query.agentId,
        signal: body.signal,
        escalated: result.escalated,
      });

      return reply.status(200).send({ data: result });
    },
  });

  // Restart creates a fresh process from the same spec, so it is gated by
  // `execution:create`, not merely `execution:signal`: it is the create verb
  // pointed at a unit that already exists, and the old process ending is
  // incidental to that. A signal permission alone must not be able to conjure a
  // new process.
  app.post('/api/units/:id/restart', {
    preHandler: [authenticate, requirePermission('execution:create')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');
      const query = parseOrThrow(unitScopedQuerySchema, request.query, 'unit query');

      const unit = await restartHostUnit(query.agentId, params.id, principal.user.id);

      await recordUnitAudit(request, 'unit.restarted', params.id, {
        agentId: query.agentId,
        pid: unit.process.pid,
      });

      const payload: UnitResponse = { unit };
      return reply.status(200).send({ data: payload });
    },
  });

  app.delete('/api/units/:id', {
    preHandler: [authenticate, requirePermission('execution:delete')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');
      const query = parseOrThrow(unitScopedQuerySchema, request.query, 'unit query');

      const killed = await killHostUnit(query.agentId, params.id, principal.user.id);

      // Audited whether or not a unit was ended: an attempt to end a unit that is
      // not the caller's (answered identically to one that never existed) is
      // exactly the event an audit log exists to record.
      await recordUnitAudit(request, 'unit.killed', params.id, {
        agentId: query.agentId,
        killed,
      });

      return reply.status(204).send();
    },
  });

  /**
   * Issues a single-use ticket for the unit stream's WebSocket handshake.
   *
   * A browser cannot set an `Authorization` header during a WebSocket upgrade,
   * so the ticket is fetched over an authenticated request — the same mechanism,
   * and the same `security/ws-ticket.ts`, the terminal stream uses.
   *
   * Gated by `execution:read` rather than by a permission of its own: the ticket
   * grants nothing except the right to redeem it once for this unit as this
   * user, and the frame schema on the stream admits no control verb. What the
   * caller may do with the unit is decided by the same permission the read
   * routes require and by the agent's own ownership check, so a ticket cannot
   * get anyone further than a `GET /api/units/:id` already could.
   *
   * The unit is deliberately *not* read here. The backend holds no unit
   * bookkeeping, so proving the unit exists would mean a round trip to the agent
   * to answer a question the handshake asks again a moment later — and the agent
   * is the authority on it either way. A ticket for a unit that is gone, or is
   * someone else's, is issued and then refused at the handshake.
   */
  app.post('/api/units/:id/ticket', {
    preHandler: [authenticate, requirePermission('execution:read')],
    handler: async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(unitIdParamSchema, request.params, 'unit id');

      return { data: await issueTicket(params.id, principal.user.id) };
    },
  });
}

/** Writes a unit lifecycle audit event, carrying the acting principal and request context. */
async function recordUnitAudit(
  request: FastifyRequest,
  action:
    'unit.created' | 'unit.signalled' | 'unit.restarted' | 'unit.killed' | 'unit.limits-applied',
  unitId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const principal = requirePrincipal(request);
  await recordAuditEvent({
    action,
    outcome: 'success',
    actorUserId: principal.user.id,
    actorUsername: principal.user.username,
    sessionId: principal.sessionId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    target: unitId,
    metadata,
  });
}
