-- Down migration: 003_short_urls
-- Reverts everything created by ./migration.sql.
-- Dropping the table removes its indexes (short_urls_code_key,
-- short_urls_owner_id_idx) and the FK constraint (short_urls_owner_id_fkey)
-- automatically. CASCADE guards against any dependent objects added later.

DROP TABLE IF EXISTS "short_urls" CASCADE;
