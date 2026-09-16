import { ROLE_PERMISSIONS, type PublicUser, type Role, type User } from '@aether/shared';

import { query, queryOne } from '../db/pool.js';

/** A `users` row exactly as it comes back from PostgreSQL. */
export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: Role;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** Strips credential material and converts to the wire shape. */
export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
  };
}

/** Adds the resolved permission set for the client. */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    ...toUser(row),
    permissions: [...ROLE_PERMISSIONS[row.role]],
  };
}

const USER_COLUMNS = `id, username, email, password_hash, role, is_active, failed_login_attempts,
                      locked_until, last_login_at, password_changed_at, created_at, updated_at`;

export async function findUserById(id: string): Promise<UserRow | null> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM aether.users WHERE id = $1`, [
    id,
  ]);
  return row ?? null;
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM aether.users WHERE lower(username) = lower($1)`,
    [username]
  );
  return row ?? null;
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM aether.users');
  return row ? Number.parseInt(row.count, 10) : 0;
}

export interface CreateUserInput {
  username: string;
  email?: string | null;
  passwordHash: string;
  role: Role;
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const row = await queryOne<UserRow>(
    `INSERT INTO aether.users (username, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [input.username, input.email ?? null, input.passwordHash, input.role]
  );

  if (!row) throw new Error('INSERT INTO aether.users returned no row');
  return row;
}

export async function listUsers(): Promise<UserRow[]> {
  const result = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM aether.users ORDER BY username ASC`
  );
  return result.rows;
}

export interface UpdateUserInput {
  email?: string | null;
  role?: Role;
  isActive?: boolean;
  passwordHash?: string;
}

export async function updateUser(id: string, changes: UpdateUserInput): Promise<UserRow | null> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  const push = (column: string, value: unknown): void => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (changes.email !== undefined) push('email', changes.email);
  if (changes.role !== undefined) push('role', changes.role);
  if (changes.isActive !== undefined) push('is_active', changes.isActive);
  if (changes.passwordHash !== undefined) {
    push('password_hash', changes.passwordHash);
    assignments.push('password_changed_at = now()');
  }

  if (assignments.length === 0) {
    return findUserById(id);
  }

  assignments.push('updated_at = now()');
  params.push(id);

  const row = await queryOne<UserRow>(
    `UPDATE aether.users SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING ${USER_COLUMNS}`,
    params
  );
  return row ?? null;
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await query('DELETE FROM aether.users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Records the outcome of a login attempt.
 *
 * A failure increments the counter and locks the account for a short window
 * once a threshold is crossed. The lock is time-based rather than permanent so
 * an attacker cannot lock a legitimate user out indefinitely.
 */
export async function recordLoginOutcome(
  userId: string,
  outcome: 'success' | 'failure',
  lockThreshold: number,
  lockDurationMs: number
): Promise<void> {
  if (outcome === 'success') {
    await query(
      `UPDATE aether.users
          SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
        WHERE id = $1`,
      [userId]
    );
    return;
  }

  await query(
    `UPDATE aether.users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3::text)::interval
              ELSE locked_until
            END,
            updated_at = now()
      WHERE id = $1`,
    [userId, lockThreshold, `${Math.round(lockDurationMs / 1000)} seconds`]
  );
}
