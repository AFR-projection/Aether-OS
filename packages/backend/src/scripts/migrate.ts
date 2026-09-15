/**
 * CLI wrapper around the migration runner.
 *
 * Used by `pnpm --filter @aether/backend db:migrate` during development and by
 * the installer before it starts the backend container for the first time.
 * Exits non-zero on failure so a shell script can detect it.
 */
import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  try {
    const result = await runMigrations();
    logger.info(
      { applied: result.applied, skipped: result.skipped },
      result.applied.length > 0 ? 'migrations applied' : 'no pending migrations',
    );
  } catch (error) {
    logger.fatal({ err: error }, 'migration run failed');
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}

void main();
