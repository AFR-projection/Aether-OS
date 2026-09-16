import { closeCache, initCache, startCacheSweeper, stopCacheSweeper } from './cache/index.js';
import { config, describeConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closePool, checkDatabaseHealth } from './db/pool.js';
import { getWorkspaceRoot } from './security/workspace.js';
import { buildServer } from './server.js';
import { ensureUploadDirectory } from './services/files.service.js';
import { killAllSessions } from './services/terminal.service.js';
import { logger } from './utils/logger.js';

/**
 * Process entry point.
 *
 * Startup order matters: the workspace root is resolved first because every
 * filesystem and terminal operation depends on it, and the database is
 * migrated before the HTTP listener opens so the API never serves requests
 * against a half-migrated schema.
 */

async function main(): Promise<void> {
  logger.info({ config: describeConfig() }, 'aether backend starting');

  const app = await buildServer();

  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown requested');

    const killed = killAllSessions(`shutdown:${signal}`);
    if (killed > 0) logger.info({ killed }, 'terminated active terminal sessions');

    stopCacheSweeper();
    await closeCache();

    try {
      await app.close();
    } catch (error) {
      logger.error({ err: error }, 'error while closing the HTTP server');
    }

    try {
      await closePool();
    } catch (error) {
      logger.error({ err: error }, 'error while closing the database pool');
    }

    logger.info('shutdown complete');
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  // --- Preflight -----------------------------------------------------------
  try {
    const workspaceRoot = await getWorkspaceRoot();
    await ensureUploadDirectory();
    logger.info({ workspaceRoot }, 'workspace ready');
  } catch (error) {
    logger.fatal({ err: error }, 'workspace could not be prepared');
    process.exit(1);
  }

  try {
    const migrations = await runMigrations();
    logger.info(
      { applied: migrations.applied, skipped: migrations.skipped.length },
      'database schema ready'
    );
  } catch (error) {
    logger.fatal({ err: error }, 'database migration failed; refusing to start');
    process.exit(1);
  }

  const health = await checkDatabaseHealth();
  if (!health.ok) {
    logger.fatal({ latencyMs: health.latencyMs, error: health.error }, 'database is not reachable');
    process.exit(1);
  }
  logger.info({ latencyMs: health.latencyMs }, 'database reachable');

  // Selecting the cache backend is deliberately last in the preflight: it is
  // the only dependency whose absence degrades rather than blocks, so a Redis
  // outage must not prevent an otherwise healthy instance from starting.
  await initCache();

  startCacheSweeper();

  // --- Listen --------------------------------------------------------------
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    logger.fatal(
      { err: error, host: config.HOST, port: config.PORT },
      'failed to bind HTTP listener'
    );
    process.exit(1);
  }

  logger.info(
    { host: config.HOST, port: config.PORT, env: config.NODE_ENV, url: config.BASE_URL },
    'aether backend listening'
  );
}

void main();
