-- Aether Cloud OS -- Local host agent support
-- Make owner_user_id nullable and add scope column to distinguish local vs remote agents.

ALTER TABLE aether.host_agents
    ALTER COLUMN owner_user_id DROP NOT NULL,
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'remote';

-- Add a check constraint to ensure that if owner_user_id is NULL then scope must be 'local',
-- and if scope is 'remote' then owner_user_id must not be NULL.
ALTER TABLE aether.host_agents
    ADD CONSTRAINT host_agents_scope_owner_check
    CHECK (
        (scope = 'remote' AND owner_user_id IS NOT NULL) OR
        (scope = 'local' AND owner_user_id IS NULL)
    );