-- Aether Cloud OS — initial schema
--
-- Applied automatically by the backend migration runner at startup.
-- Every statement is idempotent so re-running is harmless.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS aether;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aether.users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              text NOT NULL,
  email                 text,
  password_hash         text NOT NULL,
  role                  text NOT NULL DEFAULT 'viewer',
  is_active             boolean NOT NULL DEFAULT true,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$'),
  CONSTRAINT users_username_length CHECK (char_length(username) BETWEEN 3 AND 32),
  CONSTRAINT users_role_valid CHECK (role IN ('owner', 'admin', 'operator', 'viewer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON aether.users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON aether.users (lower(email)) WHERE email IS NOT NULL;

-- Only one owner account may exist. Enforced in the database so a race between
-- two concurrent bootstrap requests cannot create two.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner_key ON aether.users ((role)) WHERE role = 'owner';

-- ---------------------------------------------------------------------------
-- sessions (refresh-token backed login sessions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aether.sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES aether.users (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  user_agent         text,
  ip_address         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_key
  ON aether.sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON aether.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON aether.sessions (expires_at);

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aether.audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  action         text NOT NULL,
  outcome        text NOT NULL,
  actor_user_id  uuid REFERENCES aether.users (id) ON DELETE SET NULL,
  actor_username text,
  session_id     uuid,
  ip_address     text,
  user_agent     text,
  target         text,
  metadata       jsonb,
  CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_events_at_idx ON aether.audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_at_idx ON aether.audit_events (action, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON aether.audit_events (actor_user_id, at DESC);

-- ---------------------------------------------------------------------------
-- settings (instance-level key/value store)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aether.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES aether.users (id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- host_agents (paired remote machines)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aether.host_agents (
  id              uuid PRIMARY KEY,
  label           text NOT NULL,
  token_hash      text NOT NULL,
  owner_user_id   uuid NOT NULL REFERENCES aether.users (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE INDEX IF NOT EXISTS host_agents_owner_idx ON aether.host_agents (owner_user_id);
