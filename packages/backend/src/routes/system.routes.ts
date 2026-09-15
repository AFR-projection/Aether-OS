import { paginationSchema } from '@aether/shared';
import { z } from 'zod';

import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  ALLOWED_PROCESS_SIGNALS,
  getSystemInfo,
  listProcesses,
  signalProcess,
} from '../services/system.service.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance } from 'fastify';

const processQuerySchema = paginationSchema.extend({
  sortBy: z.enum(['memory', 'pid', 'name']).default('memory'),
  search: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

const processParamsSchema = z.object({
  pid: z.coerce.number().int().min(1).max(4_194_304),
});

const signalBodySchema = z.object({
  signal: z.enum(ALLOWED_PROCESS_SIGNALS).default('SIGTERM'),
});

const settingsUpdateSchema = z.object({
  settings: z.record(z.unknown()),
});

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/system/info',
    { preHandler: [authenticate, requirePermission('system:read')] },
    async () => ({
      data: await getSystemInfo(),
    })
  );

  app.get(
    '/api/system/processes',
    { preHandler: [authenticate, requirePermission('process:read')] },
    async (request) => {
      const queryParams = parseOrThrow(processQuerySchema, request.query, 'process query');

      // One `/proc` sweep serves both the table and the running count; the count
      // is computed inside `listProcesses` before filtering and paging.
      const listing = await listProcesses({
        limit: queryParams.limit,
        sortBy: queryParams.sortBy,
        ...(queryParams.search !== undefined ? { search: queryParams.search } : {}),
      });

      return { data: listing };
    }
  );

  /**
   * Signals a process.
   *
   * The permission is separate from `process:read` on purpose: being allowed to
   * look at the process table is a long way from being allowed to end `sshd`.
   * The service re-checks everything the client was told via `signalable`, so a
   * hand-crafted request cannot reach a protected pid.
   */
  app.post(
    '/api/system/processes/:pid/signal',
    { preHandler: [authenticate, requirePermission('process:manage')] },
    async (request) => {
      const principal = requirePrincipal(request);
      const params = parseOrThrow(processParamsSchema, request.params, 'process id');
      const body = parseOrThrow(signalBodySchema, request.body ?? {}, 'signal');

      try {
        await signalProcess(params.pid, body.signal);

        await recordAuditEvent({
          action: 'process.signalled',
          outcome: 'success',
          actorUserId: principal.user.id,
          actorUsername: principal.user.username,
          sessionId: principal.sessionId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          metadata: { pid: params.pid, signal: body.signal },
        });

        return { data: { pid: params.pid, signal: body.signal, delivered: true } };
      } catch (error) {
        // Refusals are security-relevant, so they are audited too — including
        // attempts on pids the server protects.
        await recordAuditEvent({
          action: 'process.signalled',
          outcome: 'failure',
          actorUserId: principal.user.id,
          actorUsername: principal.user.username,
          sessionId: principal.sessionId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          metadata: {
            pid: params.pid,
            signal: body.signal,
            reason: error instanceof Error ? error.message : 'unknown',
          },
        });

        throw error;
      }
    }
  );

  app.get(
    '/api/system/settings',
    { preHandler: [authenticate, requirePermission('system:read')] },
    async () => {
      const result = await query<{ key: string; value: unknown; updated_at: Date }>(
        'SELECT key, value, updated_at FROM aether.settings ORDER BY key ASC'
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
    }
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
          [key, JSON.stringify(value), principal.user.id]
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
    }
  );

  /** Instance identity used by the Settings app's "About" panel. */
  app.get('/api/system/instance', async () => {
    const row = await queryOne<{ value: unknown }>(
      "SELECT value FROM aether.settings WHERE key = 'instance'"
    );

    return {
      data: {
        // Read from validated configuration rather than `process.env` so an
        // unvalidated value can never reach a response body.
        instanceId: config.AETHER_INSTANCE_ID ?? 'unprovisioned',
        configured: row !== undefined,
      },
    };
  });
}
