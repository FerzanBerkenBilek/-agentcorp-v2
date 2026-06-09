-- Migration: 001_initial
-- Purpose: Create core schema — enums, users, tasks, refresh_tokens — with FKs
--          and the core (non-RefreshToken-specific) indexes.
-- Reversible: see ./down.sql
--
-- Notes:
--  * UUID PKs (ADR-016). uuid generation is done by Prisma (@default(uuid()))
--    on the application side, so no DB extension (pgcrypto/uuid-ossp) is needed.
--    Column DEFAULTs are therefore intentionally NOT set on the id columns.
--  * Email case-insensitivity is handled in the service layer (lowercase-on-
--    write), NOT via citext — keeps a plain unique B-tree index (ADR-017,
--    data-lead open decision).
--  * RefreshToken-specific indexes (family/jti uniqueness, partial assignee
--    index) live in migration 002.

-- ─── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- ─── users ──────────────────────────────────────────────────────────────────
CREATE TABLE "users" (
    "id"            UUID         NOT NULL,
    "email"         VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(72)  NOT NULL,
    "name"          VARCHAR(100) NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Unique index for login lookup + email uniqueness invariant.
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");

-- ─── tasks ──────────────────────────────────────────────────────────────────
CREATE TABLE "tasks" (
    "id"          UUID           NOT NULL,
    "title"       VARCHAR(255)   NOT NULL,
    "description" TEXT,
    "status"      "TaskStatus"   NOT NULL DEFAULT 'TODO',
    "priority"    "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "created_at"  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3)   NOT NULL,
    "owner_id"    UUID           NOT NULL,
    "assignee_id" UUID,
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- Composite covers owner / owner+status / owner+status+priority (leftmost prefix).
CREATE INDEX "tasks_owner_id_status_priority_idx" ON "tasks" ("owner_id", "status", "priority");
-- owner + priority (priority is not a prefix of the 3-col index).
CREATE INDEX "tasks_owner_id_priority_idx" ON "tasks" ("owner_id", "priority");
-- "assigned to me". Replaced by a partial index in migration 002.
CREATE INDEX "tasks_assignee_id_idx" ON "tasks" ("assignee_id");

-- Foreign keys: owner CASCADE (deleting a user removes their tasks),
-- assignee SET NULL (deleting a user un-assigns but keeps the task).
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_assignee_id_fkey"
    FOREIGN KEY ("assignee_id") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── refresh_tokens ─────────────────────────────────────────────────────────
CREATE TABLE "refresh_tokens" (
    "id"           UUID         NOT NULL,
    "hashed_token" VARCHAR(64)  NOT NULL,
    "family"       UUID         NOT NULL,
    "jti"          UUID         NOT NULL,
    "user_id"      UUID         NOT NULL,
    "expires_at"   TIMESTAMP(3) NOT NULL,
    "revoked_at"   TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- A given SHA-256 token hash maps to exactly one row (uniqueness invariant).
-- (The family/jti and lookup indexes are added in migration 002.)
CREATE UNIQUE INDEX "refresh_tokens_hashed_token_key" ON "refresh_tokens" ("hashed_token");

-- Foreign key: deleting a user removes all their refresh tokens.
ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
