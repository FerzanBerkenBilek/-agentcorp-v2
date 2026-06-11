-- Down migration: 006_audit_logs
-- Reverts EVERYTHING created by ./migration.sql in exact reverse dependency
-- order: trigger → function → indexes → table → enum type. Every drop is guarded
-- with IF EXISTS so the down is idempotent (safe to re-run / safe if a partial up
-- failed midway). Dropping the table removes its indexes automatically, but the
-- indexes are dropped explicitly first to mirror the up migration 1:1 and to make
-- the reversal auditable step-by-step.

-- ─── 4'. Drop the immutability trigger, then its function ──────────────────────
-- Trigger before function: the trigger DEPENDS on the function.
DROP TRIGGER  IF EXISTS "audit_logs_no_update_delete" ON "audit_logs";
DROP FUNCTION IF EXISTS "audit_logs_prevent_mutation"();

-- ─── 3'. Drop the four indexes (reverse create order) ─────────────────────────
DROP INDEX    IF EXISTS "audit_logs_target_id_created_at_idx";
DROP INDEX    IF EXISTS "audit_logs_actor_id_created_at_idx";
DROP INDEX    IF EXISTS "audit_logs_event_type_created_at_idx";
DROP INDEX    IF EXISTS "audit_logs_created_at_idx";

-- ─── 2'. Drop the table ───────────────────────────────────────────────────────
-- CASCADE guards against any dependent object added later (mirrors 001 down).
DROP TABLE    IF EXISTS "audit_logs" CASCADE;

-- ─── 1'. Drop the enum type last (the table column depended on it) ────────────
DROP TYPE     IF EXISTS "AuditTargetType";
