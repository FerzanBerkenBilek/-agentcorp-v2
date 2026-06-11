-- Migration: 004_abuse_prevention (URL Shortener — Abuse Prevention subsystem)
-- Purpose: Add the abuse-prevention data model on top of the existing schema:
--            - UserRole enum + users.role column  (ADR-030)
--            - blocked_domains table               (ADR-031)
--            - FlagState enum + flagged_urls table (ADR-032)
--            - short_urls index swap for the daily-quota range COUNT (ADR-032)
-- Implements: ADR-030 (unforgeable role column), ADR-031 (bypass-proof
--             registrable-domain blocklist, equality match), ADR-032 (FlaggedUrl
--             state machine, SMALLINT confidence band, FK SET-NULL/CASCADE split,
--             daily-quota counting over existing short_urls rows). Data-lead spec
--             in brief.md "Implementation Spec for db-engineer (migration 004)".
-- Reversible: see ./down.sql
--
-- This migration is ADDITIVE (new enums, new NOT-NULL-DEFAULT column, new tables,
-- one index swap). The only "destructive" element is dropping the now-redundant
-- short_urls(owner_id) index — its leftmost prefix is subsumed by the new
-- composite (owner_id, created_at), so no query loses an index. Net index count
-- on short_urls stays flat.
--
-- Notes:
--  * UUID PKs (ADR-016). uuid generation is done by Prisma (@default(uuid())) on
--    the application side, so no DB extension (pgcrypto/uuid-ossp) is needed and
--    the id columns intentionally carry no DEFAULT — matches migrations 001/003.
--  * Order matters: enum TYPEs must exist before columns/tables reference them;
--    tables must exist before their indexes/FKs. The short_urls index swap runs
--    last (it only touches the pre-existing table).
--  * users.role uses NOT NULL DEFAULT 'USER'. On Postgres 11+ adding a NOT NULL
--    column with a constant DEFAULT is a metadata-only catalog change (no table
--    rewrite, no long lock) and BACKFILLS every existing row to USER. This is
--    what keeps the existing test suite green — no row becomes an admin
--    implicitly. Admin bootstrap is an explicit out-of-band UPDATE (commented
--    below; intentionally NOT auto-run by this migration).
--  * confidence_score is SMALLINT with a CHECK(0..100): an exact integer band for
--    deterministic threshold comparisons (ADR-032), not a float/Decimal.
--  * FK action split (ADR-032):
--      blocked_domains.added_by_user_id  -> SET NULL (block outlives curator)
--      flagged_urls.owner_id             -> CASCADE  (submitter owns the row)
--      flagged_urls.reviewed_by_user_id  -> SET NULL (preserve review decision)

-- ─── 1. New enum types ────────────────────────────────────────────────────────
CREATE TYPE "UserRole"  AS ENUM ('USER', 'ADMIN');
CREATE TYPE "FlagState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ─── 2. users.role column ─────────────────────────────────────────────────────
-- NOT NULL DEFAULT backfills all existing rows to USER (back-compat; see notes).
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

-- ─── 3. blocked_domains ───────────────────────────────────────────────────────
CREATE TABLE "blocked_domains" (
    "id"               UUID         NOT NULL,
    "domain"           VARCHAR(253) NOT NULL,            -- canonical registrable (lowercase + punycode + eTLD+1)
    "note"             TEXT,
    "added_by_user_id" UUID,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blocked_domains_pkey" PRIMARY KEY ("id")
);

-- HOT bypass-proof equality probe (WHERE domain = $canonical) + uniqueness.
CREATE UNIQUE INDEX "blocked_domains_domain_key" ON "blocked_domains" ("domain");

-- Curator FK: SET NULL so the block outlives the admin who added it.
ALTER TABLE "blocked_domains"
    ADD CONSTRAINT "blocked_domains_added_by_user_id_fkey"
    FOREIGN KEY ("added_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. flagged_urls ──────────────────────────────────────────────────────────
CREATE TABLE "flagged_urls" (
    "id"                  UUID         NOT NULL,
    "candidate_url"       TEXT         NOT NULL,
    "proposed_code"       VARCHAR(6),
    "owner_id"            UUID         NOT NULL,
    "confidence_score"    SMALLINT     NOT NULL,
    "state"               "FlagState"  NOT NULL DEFAULT 'PENDING',
    "flagged_reason"      TEXT         NOT NULL,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at"         TIMESTAMP(3),
    "reviewed_by_user_id" UUID,
    CONSTRAINT "flagged_urls_pkey" PRIMARY KEY ("id"),
    -- Exact integer confidence band [0,100] for deterministic threshold compares.
    CONSTRAINT "flagged_urls_confidence_score_check" CHECK ("confidence_score" BETWEEN 0 AND 100)
);

-- Reserved short code: UNIQUE-when-present (Postgres allows multiple NULLs).
CREATE UNIQUE INDEX "flagged_urls_proposed_code_key" ON "flagged_urls" ("proposed_code");

-- Admin review queue: PARTIAL on PENDING, ordered by created_at (oldest-first).
-- The partial predicate excludes terminal (APPROVED/REJECTED) rows, keeping the
-- index small; the (state, created_at) order serves "PENDING oldest-first" with
-- NO Sort node. (Mirrors the tasks(assignee_id) partial index in migration 002.
-- The partial predicate is hand-written here, beyond what `prisma migrate diff`
-- emits for @@index([state, createdAt]) — same intentional drift as migration 002.)
CREATE INDEX "flagged_urls_state_created_at_idx"
    ON "flagged_urls" ("state", "created_at")
    WHERE "state" = 'PENDING';

-- "my flagged submissions" + supports the owner CASCADE FK.
CREATE INDEX "flagged_urls_owner_id_idx" ON "flagged_urls" ("owner_id");

-- Submitter FK: CASCADE (deleting the user removes their pending submissions).
ALTER TABLE "flagged_urls"
    ADD CONSTRAINT "flagged_urls_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Reviewer FK: SET NULL (preserve the review decision if the admin is deleted).
ALTER TABLE "flagged_urls"
    ADD CONSTRAINT "flagged_urls_reviewed_by_user_id_fkey"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 5. short_urls index swap (daily-quota range COUNT, ADR-032) ──────────────
-- Add the composite (owner_id, created_at) that serves the per-user calendar-day
-- COUNT range scan, then drop the now-redundant standalone (owner_id) — its
-- leftmost prefix is subsumed by the composite, so owner-only authz and "list my
-- URLs" still get an index. Net short_urls index count is unchanged.
CREATE INDEX "short_urls_owner_id_created_at_idx" ON "short_urls" ("owner_id", "created_at");
DROP INDEX "short_urls_owner_id_idx";

-- PRODUCTION NOTE (large/populated tables):
--   short_urls already holds data in prod, so build/drop its index without an
--   ACCESS EXCLUSIVE lock using the CONCURRENTLY variants (they CANNOT run inside
--   a transaction block — run via psql outside Prisma's migration transaction):
--     CREATE INDEX CONCURRENTLY "short_urls_owner_id_created_at_idx"
--       ON "short_urls" ("owner_id", "created_at");
--     DROP INDEX CONCURRENTLY "short_urls_owner_id_idx";
--   The new blocked_domains / flagged_urls tables are created empty, so their
--   indexes (incl. the partial PENDING index and the UNIQUE/CHECK constraints)
--   are correct in the plain transactional form above. Adding users.role with a
--   constant DEFAULT is metadata-only on Postgres 11+ (no rewrite).
--
-- OPTIONAL admin bootstrap (NOT run by this migration — operational, out-of-band):
--   UPDATE "users" SET "role" = 'ADMIN' WHERE "email" = lower('admin@example.com');
