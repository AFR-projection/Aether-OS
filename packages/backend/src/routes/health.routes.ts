import { checkDatabaseHealth } from '../db/pool.js';
import { isTerminalAvailable, terminalStats } from '../services/terminal.service.js';
import { AETHER_VERSION } from '../utils/version.js';

import type { FastifyInstance } from 'fastify';

/**
 * Liveness and readiness endpoints.
 *
 * `/health` is intentionally cheap and unauthenticated — it is polled by the
 * installer, by Docker's health check, and by the reverse proxy. It reports
 * dependency status without leaking connection strings or stack traces.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', () => ({
    status: 'ok',
    version: AETHER_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/health', async (_request, reply) => {
    const database = await checkDatabaseHealth();
    const terminal = terminalStats();

    const healthy = database.ok;

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      version: AETHER_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      checks: {
        database: {
          ok: database.ok,
          latencyMs: database.latencyMs,
          ...(database.ok ? {} : { error: database.error }),
        },
        terminal: {
          ok: terminal.available,
          activeSessions: terminal.active,
          maxSessionsPerUser: terminal.maxPerUser,
        },
      },
    });
  });

  /** Version-only probe used by the frontend to detect a backend upgrade. */
  app.get('/api/version', () => ({
    version: AETHER_VERSION,
    terminalAvailable: isTerminalAvailable(),
    node: process.version,
  }));
}
