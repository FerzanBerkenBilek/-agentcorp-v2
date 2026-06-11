-- Migration: 005_google_oauth ("Sign in with Google" — OAuth2 social login)
-- Purpose: Add the two Google-identity columns to the existing users table:
--            - google_id     VARCHAR(255) NULLABLE UNIQUE — the Google `sub`
--                            (immutable join key); UNIQUE is the account-takeover
--                            backstop (ADR-036 §5 / G6).
--            - google_email  VARCHAR(320) NULLABLE — store-only audit/display
--                            (ADR-036 §6); NOT unique, NOT indexed.
-- Implements: ADR-041 (data model: nullable @unique google_id + store-only
--             google_email on the existing User aggregate; no new entity, no new
--             store) + ADR-036 (the @unique(google_id) takeover backstop).
--             Data-lead spec in brief.md "Implementation Spec for db-engineer
--             (OA-3)".
-- Reversible: see ./down.sql
--
-- This migration is the GENTLEST class of change: two NULLABLE ADD COLUMNs with
-- NO DEFAULT and NO backfill (every existing row is left NULL = "password-only,
-- not Google-linked"), plus ONE unique index over an all-NULL column. It is
-- strictly gentler than migration 004's `role` (which added a NOT NULL DEFAULT,
-- backfilling every row). It is purely ADDITIVE — nothing is dropped, no query
-- loses an index, no constraint tightens on existing data.
--
-- Notes:
--  * Nullable ADD COLUMN with NO default is a metadata-only catalog change on all
--    supported Postgres versions — no table rewrite, no long lock. The columns
--    intentionally carry no DEFAULT (an absent Google link IS NULL, not a value).
--  * Postgres treats NULLs as DISTINCT under a plain UNIQUE constraint, so the
--    entire (large) population of password-only users — all with google_id NULL —
--    coexist freely, while every NON-NULL google_id is unique. A partial unique
--    index `WHERE google_id IS NOT NULL` is therefore unnecessary: plain @unique
--    already gives exactly that property (verified live in migration 004 via the
--    multi-NULL FlaggedUrl.proposed_code precedent). This UNIQUE is the security
--    backstop that prevents two accounts ever binding the same Google identity
--    (ADR-036 §5 / OA-F8 / G6).
--  * The index name `users_google_id_key` is exactly what Prisma derives for a
--    field-level `@unique` (`<table>_<column>_key`), so the hand-written DDL
--    byte-matches what `prisma migrate diff` would emit (drift-checked below).
--  * google_email is deliberately NOT unique and NOT indexed: no query is keyed
--    by it (login joins on google_id; link joins on the existing primary `email`
--    UNIQUE). It exists only for audit/display (ADR-036 §6).

-- ─── 1. Google-identity columns on users (both NULLABLE, no DEFAULT) ───────────
ALTER TABLE "users" ADD COLUMN "google_id"    VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "google_email" VARCHAR(320);

-- ─── 2. UNIQUE(google_id) — the takeover backstop (ADR-036 §5 / G6) ───────────
-- Plain UNIQUE: NULLs are distinct, so all password-only rows coexist; every
-- non-null Google `sub` is unique. Also backs the hot login lookup
-- (WHERE google_id = $sub on every OAuth callback → Index Scan).
CREATE UNIQUE INDEX "users_google_id_key" ON "users" ("google_id");

-- PRODUCTION NOTE (the users table is already populated in prod):
--   Build the unique index without an ACCESS EXCLUSIVE lock using the
--   CONCURRENTLY variant (it CANNOT run inside a transaction block — run via psql
--   OUTSIDE Prisma's migration transaction):
--     CREATE UNIQUE INDEX CONCURRENTLY "users_google_id_key" ON "users" ("google_id");
--   The two ADD COLUMNs are metadata-only (nullable, no default) and safe in the
--   plain transactional form above even on a large populated table. The unique
--   index builds trivially here because every existing google_id is NULL (no
--   non-null values to check for collisions).
