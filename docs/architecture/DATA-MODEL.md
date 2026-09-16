# Data model

All durable state lives in PostgreSQL, in a dedicated `aether` schema. There is no ORM: the backend
uses `pg` with parameterized SQL, and the schema is defined by SQL files under
`packages/backend/migrations/`.

---

## Tables

### `aether.users`

| Column                  | Type          | Notes                                                            |
| ----------------------- | ------------- | ---------------------------------------------------------------- |
| `id`                    | uuid PK       | `gen_random_uuid()`                                              |
| `username`              | text          | Unique, case-insensitive. `^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$`, 3–32 chars. |
| `email`                 | text          | Optional. Unique when present.                                    |
| `password_hash`         | text          | bcrypt                                                           |
| `role`                  | text          | `owner` \| `admin` \| `operator` \| `viewer`                     |
| `is_active`             | boolean       | Defaults true.                                                    |
| `failed_login_attempts` | integer       | Drives lockout.                                                   |
| `locked_until`          | timestamptz   | Set when the attempt limit is hit.                                |
| `last_login_at`         | timestamptz   |                                                                  |
| `password_changed_at`   | timestamptz   |                                                                  |
| `created_at` / `updated_at` | timestamptz |                                                                 |

Three indexes carry real weight:

- `users_username_key` on `lower(username)` — uniqueness is case-insensitive, so `Aldo` cannot be
  registered alongside `aldo`.
- `users_email_key` on `lower(email) WHERE email IS NOT NULL` — a partial index, because
  `email` is optional and multiple NULLs must be allowed.
- `users_single_owner_key` on `(role) WHERE role = 'owner'` — **the database, not the application,
  enforces that only one owner exists.** Two concurrent bootstrap requests cannot both win; one
  gets a unique-violation.

### `aether.sessions`

One row per login session, backed by a refresh token.

| Column               | Type        | Notes                                                     |
| -------------------- | ----------- | --------------------------------------------------------- |
| `id`                 | uuid PK     |                                                            |
| `user_id`            | uuid FK     | `ON DELETE CASCADE`                                        |
| `refresh_token_hash` | text        | Unique. The token itself is never stored.                  |
| `user_agent`         | text        | Shown on Settings → Sessions so you can recognize a device. |
| `ip_address`         | text        |                                                            |
| `created_at` / `last_seen_at` | timestamptz |                                                   |
| `expires_at`         | timestamptz |                                                            |
| `revoked_at`         | timestamptz | NULL means live.                                           |
| `revoked_reason`     | text        |                                                            |

**Why the table exists at all.** A JWT is stateless and therefore cannot be revoked. Without a
server-side session row, "log out", "log out everywhere", and "revoke that device" would be
cosmetic — the token would keep working until it expired. Every authenticated request therefore
checks that its session is still live. That check is cached for a few seconds, which is why
revocation is *near*-instant rather than instant — see
[Known limitations](../status/KNOWN-LIMITATIONS.md#2-session-revocation-takes-up-to-five-seconds-to-take-effect).

### `aether.audit_events`

| Column                         | Type        | Notes                                    |
| ------------------------------ | ----------- | ---------------------------------------- |
| `id`                           | uuid PK     |                                          |
| `at`                           | timestamptz |                                          |
| `action`                       | text        | e.g. `auth.login`, `files.delete`         |
| `outcome`                      | text        | `success` \| `failure`                    |
| `actor_user_id`                | uuid FK     | `ON DELETE SET NULL` — the log outlives the account |
| `actor_username`               | text        | Denormalized so a deleted user is still identifiable |
| `session_id`, `ip_address`, `user_agent` |      |                                          |
| `target`                       | text        | What was acted on                        |
| `metadata`                     | jsonb       | Extra context                            |

Indexed by `at DESC`, `(action, at DESC)`, and `(actor_user_id, at DESC)` — the three ways the
Security Center queries it.

The denormalized `actor_username` and `ON DELETE SET NULL` are deliberate: deleting a user must not
erase the record of what they did.

### `aether.settings`

Instance-level key/value store: `key` (PK), `value` (jsonb), `updated_at`, `updated_by`.

### `aether.host_agents`

| Column          | Type        | Notes                                                        |
| --------------- | ----------- | ------------------------------------------------------------ |
| `id`            | uuid PK     | Supplied by the application, not generated — the agent id is minted at pair time. |
| `label`         | text        | Operator-facing name.                                         |
| `token_hash`    | text        | SHA-256 of the pairing token. **The token is shown once, at pair time, and never stored in the clear.** |
| `owner_user_id` | uuid FK     | `ON DELETE CASCADE`                                           |
| `created_at`    | timestamptz |                                                              |
| `revoked_at`    | timestamptz | Soft revoke.                                                  |

Revocation is a **soft** revoke (`UPDATE … SET revoked_at = now()`), not a delete. `listAgents`
filters `WHERE revoked_at IS NULL`. Keeping the row means the audit trail of what was once paired
survives the revocation.

### `aether.schema_migrations`

Bookkeeping for the migration runner, described below.

---

## The migration runner

`packages/backend/src/db/migrate.ts` — about 80 lines, no dependency. It runs automatically at
backend startup, and can be run alone with:

```bash
pnpm --filter @aether/backend db:migrate
```

Behaviour:

1. Ensures `aether.schema_migrations` exists.
2. Reads every `.sql` file in `migrations/`, sorted by filename.
3. For each: if already applied, **verify its checksum**; if not applied, run it inside its own
   transaction and record `(id, checksum, duration_ms)`.
4. Any failure rolls back that one migration and stops startup.

### Why hand-rolled

The requirement is exactly one behaviour: apply unapplied `.sql` files in order, each in a
transaction, with a checksum. A library would add a transitive dependency surface — and its own
opinions about rollbacks and shadow databases — to cover a case that does not arise here.

### The checksum rule

**Never edit a migration that has been applied.** Editing changes its SHA-256, and the runner
refuses to start:

```
Migration 001_init has been modified after it was applied
(recorded 4a1c2f9e3b7d, found 9e0b6c41af22).
Create a new migration instead of editing an applied one.
```

That failure is the feature. Without it, a deployed database and the repository would silently
describe different schemas, and the divergence would surface later as a confusing runtime error.

### Adding a migration

```bash
# 1. Create the next file. Numbering is zero-padded so filename sort is numeric sort.
touch packages/backend/migrations/002_add_something.sql

# 2. Write idempotent DDL.
cat >> packages/backend/migrations/002_add_something.sql <<'SQL'
ALTER TABLE aether.users ADD COLUMN IF NOT EXISTS theme text;
SQL

# 3. Apply it.
pnpm --filter @aether/backend db:migrate
```

Use `IF NOT EXISTS` / `IF EXISTS` throughout. The runner tracks what it applied, but idempotent DDL
means a half-applied migration (or a database restored from an older backup) can be brought forward
without hand-repair.

### There is no rollback

The runner is forward-only, by design. Undoing a schema change is not mechanically inferable from
the change itself — "drop this column" does not imply "and restore the data that was in it". If a
release must be undone, restore the backup taken before it. That is why `aether update` always takes
one first: see [BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

---

## A failure this design has already had

`scripts/init-db.sql` originally created `aether.users` and `aether.sessions` itself, duplicating
the migration. Because the migrations use `CREATE TABLE IF NOT EXISTS`, the bootstrap definition won
the race, the migration skipped those tables, and a later statement
(`users_single_owner_key … WHERE role = 'owner'`) referenced a column the stale table did not have.
A fresh development database could not be migrated at all.

`scripts/init-db.sql` now creates **no tables** — only the `pgcrypto` extension, the schema, and
grants. The migration runner is the sole owner of the schema. If you are adding a table, add a
migration; do not add it to `init-db.sql`.
