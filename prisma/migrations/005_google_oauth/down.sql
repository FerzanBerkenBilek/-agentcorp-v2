-- Down migration: 005_google_oauth
-- Reverts EVERYTHING created by ./migration.sql, in the exact reverse order
-- (unique index → columns). Dropping the columns is reversible with no data loss
-- beyond the OAuth links themselves (which by definition only exist after this
-- feature shipped). No enum types, tables, or FKs were introduced, so there is
-- nothing else to unwind.

-- ─── 2'. Drop the UNIQUE(google_id) backstop index ────────────────────────────
DROP INDEX IF EXISTS "users_google_id_key";

-- ─── 1'. Drop the Google-identity columns (reverse add order) ─────────────────
ALTER TABLE "users" DROP COLUMN IF EXISTS "google_email";
ALTER TABLE "users" DROP COLUMN IF EXISTS "google_id";

-- PRODUCTION NOTE: on a populated users table, drop the index without an ACCESS
-- EXCLUSIVE lock using the CONCURRENTLY variant (outside a transaction block):
--   DROP INDEX CONCURRENTLY IF EXISTS "users_google_id_key";
-- The two DROP COLUMNs are metadata-only and safe in the plain form above.
