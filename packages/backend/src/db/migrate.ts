import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('migrate');

/**
 * Minimal forward-only migration runner.
 *
 * Why a hand-rolled runner rather than a library: the backend needs exactly one
 * behaviour — apply every `.sql` file in `migrations/` that has not been applied
 * yet, in filename order, each inside its own transaction, and record a
 * checksum. That is ~80 lines and has no transitive dependency surface.
 *
 * Checksums guard against a released migration file being edited after it has
 * been applied: editing it changes the hash and the runner refuses to start
 * rather than silently diverging from a deployed database.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

interface MigrationFile {
  id: string;
  absolutePath: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query('CREATE SCHEMA IF NOT EXISTS aether');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aether.schema_migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const files: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const absolutePath = path.join(MIGRATIONS_DIR, name);
    const sql = await readFile(absolutePath, 'utf8');
    files.push({
      id: name.replace(/\.sql$/, ''),
      absolutePath,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return files;
}

async function loadAppliedMigrations(): Promise<Map<string, AppliedMigration>> {
  const result = await pool.query<AppliedMigration>('SELECT id, checksum FROM aether.schema_migrations');
  return new Map(result.rows.map((row) => [row.id, row]));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies all pending migrations.
 *
 * Throws if a previously applied migration's checksum no longer matches, which
 * means the file changed after deployment.
 */
export async function runMigrations(): Promise<MigrationResult> {
  await ensureMigrationsTable();

  const files = await loadMigrationFiles();
  const applied = await loadAppliedMigrations();

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const existing = applied.get(file.id);

    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          `Migration ${file.id} has been modified after it was applied ` +
            `(recorded ${existing.checksum.slice(0, 12)}, found ${file.checksum.slice(0, 12)}). ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      result.skipped.push(file.id);
      continue;
    }

    const startedAt = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(
        'INSERT INTO aether.schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file.id, file.checksum, Date.now() - startedAt],
      );
      await client.query('COMMIT');
      result.applied.push(file.id);
      log.info({ migration: file.id, durationMs: Date.now() - startedAt }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error({ err: error, migration: file.id }, 'migration failed');
      throw error;
    } finally {
      client.release();
    }
  }

  if (result.applied.length === 0) {
    log.info({ skipped: result.skipped.length }, 'database schema already up to date');
  }

  return result;
}

/** Entry point for `pnpm --filter @aether/backend db:migrate`. */
export async function runMigrationsCli(): Promise<void> {
  try {
    const result = await runMigrations();
    log.info({ applied: result.applied, skipped: result.skipped }, 'migrations complete');
  } finally {
    await pool.end();
  }
}
