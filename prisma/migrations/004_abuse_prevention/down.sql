-- Down migration: 004_abuse_prevention
-- Reverts EVERYTHING created by ./migration.sql, in the exact reverse order
-- (index swap → tables → column → enum types). Dropping the new tables removes
-- their indexes, CHECK constraints, and FK constraints automatically; CASCADE
-- guards against any dependent objects added later. The enum TYPEs are dropped
-- last because the dropped column/tables referenced them.

-- ─── 5'. Reverse the short_urls index swap ────────────────────────────────────
-- Restore the original standalone (owner_id) index, then drop the composite.
CREATE INDEX "short_urls_owner_id_idx" ON "short_urls" ("owner_id");
DROP INDEX "short_urls_owner_id_created_at_idx";

-- ─── 4'. flagged_urls ─────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "flagged_urls" CASCADE;

-- ─── 3'. blocked_domains ──────────────────────────────────────────────────────
DROP TABLE IF EXISTS "blocked_domains" CASCADE;

-- ─── 2'. users.role column ────────────────────────────────────────────────────
ALTER TABLE "users" DROP COLUMN "role";

-- ─── 1'. enum types (dropped last — nothing references them now) ──────────────
DROP TYPE IF EXISTS "FlagState";
DROP TYPE IF EXISTS "UserRole";

-- PRODUCTION NOTE: on a populated short_urls the index swap reversal should use
-- the CONCURRENTLY variants (outside a transaction block):
--   CREATE INDEX CONCURRENTLY "short_urls_owner_id_idx" ON "short_urls" ("owner_id");
--   DROP INDEX CONCURRENTLY "short_urls_owner_id_created_at_idx";
