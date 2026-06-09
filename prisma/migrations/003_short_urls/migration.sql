-- Migration: 003_short_urls (URL Shortener feature)
-- Purpose: Create the short_urls table for the `urls` vertical module, with:
--            - UNIQUE (code)   — hot redirect lookup WHERE code = ? on every
--                                GET /:code + GET /:code/stats; also backs the
--                                ADR-022 insert-retry-on-collision uniqueness.
--            - (owner_id)      — owner-only authz on stats/delete + owner lists.
--            - FK owner_id -> users(id) ON DELETE CASCADE (no orphaned links).
-- Implements: ADR-022 (code-gen), ADR-023 (atomic click-count), ADR-024
--             (ShortUrl data model/indexes). Data-lead spec in brief.md
--             "Data-Lead Output (URL Shortener)".
-- Reversible: see ./down.sql
--
-- Notes:
--  * UUID PK (ADR-016). uuid generation is done by Prisma (@default(uuid())) on
--    the application side, so no DB extension (pgcrypto/uuid-ossp) is needed and
--    the id column intentionally carries no DEFAULT — matches migration 001.
--  * `code` is the public business key (6-char base62, CSPRNG-generated in the
--    service, ADR-022), NOT the PK. It is non-enumerable by design (enumeration
--    resistance, mirrors the UUID posture).
--  * `original_url` is TEXT (the 2048-byte abuse cap is enforced in SSRF
--    validation, ADR-019, not at the column).
--  * `last_accessed_at` is nullable: NULL until the first redirect, then set
--    atomically alongside the click_count increment (ADR-023).

-- ─── short_urls ─────────────────────────────────────────────────────────────
CREATE TABLE "short_urls" (
    "id"               UUID         NOT NULL,
    "code"             VARCHAR(6)   NOT NULL,
    "original_url"     TEXT         NOT NULL,
    "owner_id"         UUID         NOT NULL,
    "click_count"      INTEGER      NOT NULL DEFAULT 0,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3),
    "updated_at"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "short_urls_pkey" PRIMARY KEY ("id")
);

-- Unique index on the public code: HOT redirect lookup + collision-retry guard.
CREATE UNIQUE INDEX "short_urls_code_key" ON "short_urls" ("code");

-- Owner-scoped index: owner-only authz on stats/delete + "list my URLs".
CREATE INDEX "short_urls_owner_id_idx" ON "short_urls" ("owner_id");

-- Foreign key: deleting a user removes all their short URLs (no orphaned links).
ALTER TABLE "short_urls"
    ADD CONSTRAINT "short_urls_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- PRODUCTION NOTE (large tables > 1M rows):
--   For an already-populated table, build the indexes without an ACCESS
--   EXCLUSIVE lock using the CONCURRENTLY variants (they CANNOT run inside a
--   transaction block, so run via psql outside Prisma's migration transaction):
--     CREATE UNIQUE INDEX CONCURRENTLY "short_urls_code_key" ON "short_urls" ("code");
--     CREATE INDEX CONCURRENTLY "short_urls_owner_id_idx" ON "short_urls" ("owner_id");
--   For this initial create-table deploy the table is empty, so the plain
--   (atomic, transactional) forms above are correct.
