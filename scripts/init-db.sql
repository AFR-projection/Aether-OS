-- Aether Cloud OS — development database bootstrap.
--
-- This runs once, when the PostgreSQL container first initialises its data
-- directory. It deliberately creates NO tables.
--
-- The schema has exactly one owner: the backend's migration runner
-- (packages/backend/migrations/*.sql, applied at startup by src/db/migrate.ts).
-- An earlier version of this file also defined `aether.users` and
-- `aether.sessions`. Because the migrations use `CREATE TABLE IF NOT EXISTS`,
-- those definitions won the race, the migrations then skipped them, and a
-- later statement (`users_single_owner_key ... WHERE role = 'owner'`)
-- referenced a column the stale table did not have — so a fresh development
-- database could not be migrated at all. Keeping this file to extensions and
-- grants is what prevents that class of drift from coming back.
--
-- The first user is created through the application's bootstrap flow
-- (AETHER_BOOTSTRAP_TOKEN + the first-run screen), not by seeding a row here.

-- gen_random_uuid() comes from pgcrypto; the migrations use it for every
-- primary key, so it must exist before the runner starts.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- The migrations create this too, but the grant below needs it to exist first
-- and the database owner is the only role that can create extensions.
CREATE SCHEMA IF NOT EXISTS aether;

-- The application connects as the `aether` role; it owns the schema and every
-- table the migrations create in it.
GRANT ALL PRIVILEGES ON SCHEMA aether TO aether;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA aether TO aether;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA aether TO aether;

-- Tables created by the migrations must be usable by the application role
-- without an explicit GRANT per migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA aether
    GRANT ALL PRIVILEGES ON TABLES TO aether;
ALTER DEFAULT PRIVILEGES IN SCHEMA aether
    GRANT ALL PRIVILEGES ON SEQUENCES TO aether;

DO $$
BEGIN
    RAISE NOTICE 'Aether: bootstrap complete — run the backend to apply migrations.';
END $$;
