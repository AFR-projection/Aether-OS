import { AUDIT_ACTIONS, paginationSchema } from '@aether/shared';
import { z } from 'zod';

import { authenticate, requirePermission } from '../middleware/auth.js';
import { listAuditEvents } from '../services/audit.service.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance } from 'fastify';

const auditQuerySchema = paginationSchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorUserId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get(
    '/api/audit',
    { preHandler: [authenticate, requirePermission('audit:read')] },
    async (request) => {
      const params = parseOrThrow(auditQuerySchema, request.query, 'audit query');

      const rows = await listAuditEvents({
        limit: params.limit,
        offset: params.offset,
        ...(params.action !== undefined ? { action: params.action } : {}),
        ...(params.actorUserId !== undefined ? { actorUserId: params.actorUserId } : {}),
      });

      return {
        data: {
          events: rows.map((row) => ({
            id: row.id,
            at: row.at.toISOString(),
            action: row.action,
            outcome: row.outcome,
            actorUserId: row.actor_user_id,
            actorUsername: row.actor_username,
            sessionId: row.session_id,
            ipAddress: row.ip_address,
            userAgent: row.user_agent,
            target: row.target,
            metadata: row.metadata,
          })),
        },
      };
    }
  );
}
