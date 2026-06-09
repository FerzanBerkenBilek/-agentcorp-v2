-- Migration: 002_indexes (RefreshToken-specific indexes + partial assignee index)
-- Purpose:
--   1. RefreshToken uniqueness/reuse-detection indexes (ADR-012):
--        - UNIQUE (family, jti)  — reuse detection within a rotation chain
--        - UNIQUE (jti)          — jti is the unique business key per token
--   2. RefreshToken lookup indexes:
--        - (user_id)   — revoke-all-by-user / logout-all-devices
--        - (expires_at)— expired-token cleanup cron
--   3. Replace the plain tasks(assignee_id) index from migration 001 with a
--      PARTIAL index WHERE assignee_id IS NOT NULL (skips unassigned rows,
--      smaller index, less write amplification on unassigned tasks).
-- Reversible: see ./down.sql
--
-- PRODUCTION NOTE (large tables > 1M rows):
--   Use CREATE INDEX CONCURRENTLY / DROP INDEX CONCURRENTLY to avoid taking an
--   ACCESS EXCLUSIVE lock that blocks writes. CONCURRENTLY statements CANNOT run
--   inside a transaction block, so this migration must be applied OUTSIDE a
--   transaction. Prisma wraps migrations in a transaction by default; to run
--   concurrently in prod, execute this file via psql directly (or split it).
--   For the initial empty-table deploy, the plain (non-concurrent) forms below
--   are correct and atomic. The concurrent variants are documented inline.

-- ── RefreshToken: uniqueness / reuse detection ───────────────────────────────
-- UNIQUE composite (family, jti): catches replay of a consumed token in a chain.
CREATE UNIQUE INDEX "refresh_tokens_family_jti_key"
    ON "refresh_tokens" ("family", "jti");
-- Prod (populated table) equivalent:
--   CREATE UNIQUE INDEX CONCURRENTLY "refresh_tokens_family_jti_key"
--     ON "refresh_tokens" ("family", "jti");

-- UNIQUE jti: unique business key per individual token.
CREATE UNIQUE INDEX "refresh_tokens_jti_key"
    ON "refresh_tokens" ("jti");
-- Prod equivalent:
--   CREATE UNIQUE INDEX CONCURRENTLY "refresh_tokens_jti_key"
--     ON "refresh_tokens" ("jti");

-- ── RefreshToken: lookups ────────────────────────────────────────────────────
-- Tokens-by-user: revoke-all / logout-all-devices.
CREATE INDEX "refresh_tokens_user_id_idx"
    ON "refresh_tokens" ("user_id");
-- Prod equivalent:
--   CREATE INDEX CONCURRENTLY "refresh_tokens_user_id_idx"
--     ON "refresh_tokens" ("user_id");

-- Expired-token cleanup cron: DELETE FROM refresh_tokens WHERE expires_at < now().
CREATE INDEX "refresh_tokens_expires_at_idx"
    ON "refresh_tokens" ("expires_at");
-- Prod equivalent:
--   CREATE INDEX CONCURRENTLY "refresh_tokens_expires_at_idx"
--     ON "refresh_tokens" ("expires_at");

-- ── tasks: partial assignee index ────────────────────────────────────────────
-- Replace the full (assignee_id) index with a partial one that excludes the
-- common NULL (unassigned) rows. The "assigned to me" query always filters
-- assignee_id = <uuid>, which is never NULL, so the partial index fully serves it.
DROP INDEX IF EXISTS "tasks_assignee_id_idx";
CREATE INDEX "tasks_assignee_id_idx"
    ON "tasks" ("assignee_id")
    WHERE "assignee_id" IS NOT NULL;
-- Prod equivalent:
--   DROP INDEX CONCURRENTLY IF EXISTS "tasks_assignee_id_idx";
--   CREATE INDEX CONCURRENTLY "tasks_assignee_id_idx"
--     ON "tasks" ("assignee_id") WHERE "assignee_id" IS NOT NULL;
