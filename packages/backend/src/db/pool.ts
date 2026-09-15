import pg from 'pg';

import { config } from '../config.js';
import { subsystemLogger } from '../utils/logger.js';

const { Pool } = pg;
const log = subsystemLogger('database');

/**
 * PostgreSQL connection pool.
 *
 * The pool is lazily connected: importing this module does not open a socket,
 * so unit tests that never touch the database do not need one running.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
  application_name: 'aether-backend',
});

pool.on('error', (error) => {
  // An idle client erroring is not fatal for the pool, but it must be visible.
  log.error({ err: error }, 'idle database client error');
});

/** Runs a parameterised query. Never interpolate user input into `text`. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const startedAt = Date.now();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const durationMs = Date.now() - startedAt;
    if (durationMs > 1_000) {
      log.warn({ durationMs, sql: firstLine(text) }, 'slow query');
    }
    return result;
  } catch (error) {
    log.error({ err: error, sql: firstLine(text) }, 'query failed');
    throw error;
  }
}

/** Convenience wrapper returning the first row, or `undefined`. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await query<T>(text, params);
  return result.rows[0];
}

export type TransactionClient = pg.PoolClient;

/**
 * Runs `fn` inside a transaction.
 *
 * Commits on success, rolls back on any thrown error, and always returns the
 * client to the pool. Errors are re-thrown unchanged so callers can map them to
 * HTTP responses.
 */
export async function withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      log.error({ err: rollbackError }, 'transaction rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Cheap liveness probe used by `/health` and the installer health checks. */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      // Message only — a connection string in a health response would leak
      // the database password to anyone who can reach the endpoint.
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}

/** Closes every pooled connection. Called during graceful shutdown. */
export async function closePool(): Promise<void> {
  await pool.end();
}

function firstLine(sql: string): string {
  const [line = ''] = sql.split('\n');
  return line.trim().slice(0, 200);
}
