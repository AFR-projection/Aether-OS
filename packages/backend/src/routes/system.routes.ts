import { paginationSchema } from '@aether/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { getSystemInfo, listProcesses, processSummary } from '../services/system.service.js';
import { query, queryOne } from '../db/pool.js';
import { parseOrThrow } from '../utils/validate.js';

const processQuerySchema = paginationSchema.extend({
  sortBy: z.enum(['memory', 'pid', 'name']).default('memory'),
  search: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

const settingsUpdateSchema = z.object({
  settings: z.record(z.unknown()),
});

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/system/info', { preHandler: [authenticate, requirePermission('system:read')] }, async () => ({
    data: await getSystemInfo(),
  }));

  app.get(
    '/api/system/processes',
    { preHandler: [authenticate, requirePermission('process:read')] },
    async (request) => {
      const queryParams = parseOrThrow(processQuerySchema, request.query, 'process query');

      const [listing, summary] = await Promise.all([
        listProcesses({
          limit: queryParams.limit,
          sortBy: queryParams.sortBy,
          ...(queryParams.search !== undefined ? { search: queryParams.search } : {}),
        }),
        processSummary(),
      ]);

      return { data: { ...listing, running: summary.running } };
    },
  );

  app.get(
    '/api/system/settings',
    { preHandler: [authenticate, requirePermission('system:read')] },
    async () => {
      const result = await query<{ key: string; value: unknown; updated_at: Date }>(
        'SELECT key, value, updated_at FROM aether.settings ORDER BY key ASC',
      );

      return {
        data: {
          settings: result.rows.map((row) => ({
            key: row.key,
            value: row.value,
            updatedAt: row.updated_at.toISOString(),
          })),
        },
      };
    },
  );

  app.put(
    '/api/system/settings',
    { preHandler: [authenticate, requirePermission('settings:manage')] },
    async (request) => {
      const principal = requirePrincipal(request);
      const body = parseOrThrow(settingsUpdateSchema, request.body, 'settings update');

      const entries = Object.entries(body.settings);
      if (entries.length === 0) {
        return { data: { updated: 0 } };
      }

      for (const [key, value] of entries) {
        await query(
          `INSERT INTO aether.settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), principal.user.id],
        );
      }

      await recordAuditEvent({
        action: 'settings.updated',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        sessionId: principal.sessionId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        // Keys only — values may contain user-supplied configuration.
        metadata: { keys: entries.map(([key]) => key) },
      });

      return { data: { updated: entries.length } };
    },
  );

  /** Instance identity used by the Settings app's "About" panel. */
  app.get('/api/system/instance', async () => {
    const row = await queryOne<{ value: unknown }>(
      "SELECT value FROM aether.settings WHERE key = 'instance'",
    );

    return {
      data: {
        instanceId: process.env.AETHER_INSTANCE_ID ?? 'unprovisioned',
        configured: row !== undefined,
      },
    };
  });
}
