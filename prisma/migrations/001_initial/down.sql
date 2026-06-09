-- Down migration: 001_initial
-- Reverts everything created by ./migration.sql, in reverse dependency order.
-- Drop child tables (FK holders) before parents, then drop enum types.

-- Drop tables. Indexes and FK constraints are dropped automatically with the
-- tables. CASCADE guards against any dependent objects added later.
DROP TABLE IF EXISTS "refresh_tokens" CASCADE;
DROP TABLE IF EXISTS "tasks" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

-- Drop enum types last (tasks depended on them).
DROP TYPE IF EXISTS "TaskPriority";
DROP TYPE IF EXISTS "TaskStatus";
