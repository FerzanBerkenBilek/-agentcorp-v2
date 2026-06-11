-- Migration: 006_audit_logs (append-only, DB-IMMUTABLE security/business audit log)
-- Purpose: Create the standalone `audit_logs` fact table that records WHO did
--          WHAT to WHICH object FROM WHERE WITH WHAT context and WHEN, hardened
--          against tampering at the DATABASE level (not just the app surface).
-- Implements: ADR-045 (dual-layer immutability: app has no UPDATE/DELETE surface,
--             DB has a BEFORE UPDATE/DELETE trigger that RAISES) + ADR-048 (data
--             model: standalone table, NO foreign keys, polymorphic
--             (target_id,target_type), created_at-leading composite indexes, NO
--             updated_at). Data-lead spec: brief.md "Data-Lead Output — Immutable
--             Audit Log §5". Security checklist S6 (real-PG trigger) + S7 (no
--             cascading FK from User → rows survive user deletion).
-- Reversible: see ./down.sql
--
-- This migration is purely ADDITIVE: one new enum type, one new table, four
-- indexes, one immutability function + trigger. Nothing existing is altered, no
-- existing index is dropped, no constraint tightens on existing data. The 558
-- existing tests stay green (they run on the in-memory fake-prisma, which never
-- touches this table; the new auditLog delegate is qa's, not this migration's).
--
-- Notes:
--  * UUID PK with NO column DEFAULT — uuid generation is done by Prisma
--    (@default(uuid())) on the application side, exactly like every other table
--    in this schema (001 users/tasks, 003 short_urls, 004 flagged_urls). No DB
--    extension (pgcrypto/uuid-ossp) is introduced.
--  * NO foreign-key constraints on actor_id / target_id (ADR-045 §no-FK, S7).
--    They are plain @db.Uuid string copies. This is the survives-user-deletion
--    mechanism: every existing User FK is ON DELETE CASCADE or SET NULL, either
--    of which would corrupt audit history (CASCADE deletes the deleted user's
--    trail — the single most forensically valuable data; SET NULL erases WHO).
--    A non-FK column keeps the id string verbatim after users.id is gone.
--  * target_id is POLYMORPHIC (task | url | user | blocklist_entry | none); a
--    single SQL FK cannot reference four tables, and four typed FKs for a
--    write-once log is rejected over-engineering. (target_id, target_type) is the
--    standard polymorphic shape — correct here precisely because we never JOIN it.
--  * IMMUTABILITY is a BEFORE UPDATE OR DELETE trigger that RAISES (the Postgres
--    path), chosen over CREATE RULE ... DO INSTEAD NOTHING (which would make a
--    tamper attempt a SILENT no-op — a dangerous failure mode for a security log)
--    and over a CHECK constraint (a CHECK cannot block DELETE). RAISE fails the
--    statement loudly with a clear SQLSTATE — the auditable, fail-closed behavior.
--    INSERT is left untouched: it is the ONLY legal write.
--  * Index names match what Prisma derives (<table>_<cols>_idx) so this
--    hand-written DDL byte-matches `prisma migrate diff` (drift-checked).

-- ─── 1. Native enum for target_type ───────────────────────────────────────────
-- Mirrors the TaskStatus / TaskPriority / FlagState native-enum pattern (ADR-017).
-- A closed, validated vocabulary; the DB rejects typos at the boundary.
CREATE TYPE "AuditTargetType" AS ENUM ('task', 'url', 'user', 'blocklist_entry');

-- ─── 2. audit_logs table ──────────────────────────────────────────────────────
-- id UUID PK (app-generated, no DEFAULT); event_type VARCHAR(100) NOT NULL
-- (app AUDIT_ACTION vocabulary, evolves without migration); actor_id/target_id
-- UUID NULL (NO FK — survives user delete, polymorphic target); target_type enum
-- NULL; ip_address VARCHAR(45) NULL; user_agent VARCHAR(512) NULL; metadata JSONB
-- NOT NULL DEFAULT '{}'; created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now().
-- DELIBERATELY NO updated_at (the row is immutable).
CREATE TABLE "audit_logs" (
    "id"          UUID              NOT NULL,
    "event_type"  VARCHAR(100)      NOT NULL,
    "actor_id"    UUID,
    "target_id"   UUID,
    "target_type" "AuditTargetType",
    "ip_address"  VARCHAR(45),
    "user_agent"  VARCHAR(512),
    "metadata"    JSONB             NOT NULL DEFAULT '{}',
    "created_at"  TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
-- NO foreign-key constraints. (intentional — ADR-045 §no-FK / security S7)

-- ─── 3. Indexes (created_at-DESC-leading; every read is ORDER BY created_at DESC) ─
-- Default newest-first list + date-range. Leading created_at DESC lets the
-- paginated "ORDER BY created_at DESC LIMIT 100" read straight off the b-tree
-- with NO Sort node; LIMIT short-circuits the scan.
CREATE INDEX "audit_logs_created_at_idx"            ON "audit_logs" ("created_at" DESC);
-- Filter: event_type = ? (+ newest-first). Composite: equality narrows, the
-- trailing created_at DESC supplies the order (and serves the range), no Sort.
CREATE INDEX "audit_logs_event_type_created_at_idx" ON "audit_logs" ("event_type", "created_at" DESC);
-- Filter: actor_id = ? ("everything user X did"). Composite, same rationale.
CREATE INDEX "audit_logs_actor_id_created_at_idx"   ON "audit_logs" ("actor_id",   "created_at" DESC);
-- Filter: target_id = ? ("everything that happened to object Y"). Composite.
CREATE INDEX "audit_logs_target_id_created_at_idx"  ON "audit_logs" ("target_id",  "created_at" DESC);
-- NO index on target_type (4 values + NULL = near-zero selectivity), ip_address,
-- user_agent, or metadata (no query keys on them) — index discipline, ADR-023/024.
--
-- PROD NOTE: this is a FRESH, empty table, so the plain (transactional) index
-- form above is correct and instant. On a POPULATED table you would instead build
-- each index OUTSIDE the migration transaction with the CONCURRENTLY variant to
-- avoid an ACCESS EXCLUSIVE lock, per the 005 precedent:
--   CREATE INDEX CONCURRENTLY "audit_logs_created_at_idx" ON "audit_logs" ("created_at" DESC);

-- ─── 4. IMMUTABILITY: BEFORE UPDATE OR DELETE trigger that RAISES ──────────────
-- The DB-level half of the dual-layer control (ADR-045 / security S6). Rejects
-- even a direct SQL UPDATE/DELETE on the app's own DB grant — so a compromised
-- app account or an SQLi through any app query CANNOT erase or alter evidence.
-- RAISE (not RULE DO INSTEAD NOTHING) so a tamper attempt FAILS LOUDLY with a
-- clear SQLSTATE, never a silent no-op. INSERT is untouched (the only legal write).
CREATE OR REPLACE FUNCTION "audit_logs_prevent_mutation"()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: % is not permitted (ADR-045)', TG_OP
    USING ERRCODE = 'restrict_violation';   -- SQLSTATE 23001
END;
$$;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "audit_logs_prevent_mutation"();
