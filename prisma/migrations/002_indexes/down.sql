-- Down migration: 002_indexes
-- Reverts ./migration.sql: drops the RefreshToken-specific indexes and restores
-- the plain (non-partial) tasks(assignee_id) index created in migration 001.

-- Restore the original full assignee index (drop the partial one first).
DROP INDEX IF EXISTS "tasks_assignee_id_idx";
CREATE INDEX "tasks_assignee_id_idx" ON "tasks" ("assignee_id");

-- Drop RefreshToken lookup indexes.
DROP INDEX IF EXISTS "refresh_tokens_expires_at_idx";
DROP INDEX IF EXISTS "refresh_tokens_user_id_idx";

-- Drop RefreshToken uniqueness / reuse-detection indexes.
DROP INDEX IF EXISTS "refresh_tokens_jti_key";
DROP INDEX IF EXISTS "refresh_tokens_family_jti_key";

-- Prod (populated table) equivalent for all of the above:
--   DROP INDEX CONCURRENTLY IF EXISTS ...;
--   CREATE INDEX CONCURRENTLY "tasks_assignee_id_idx" ON "tasks" ("assignee_id");
-- (CONCURRENTLY cannot run inside a transaction block.)
