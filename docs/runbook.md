# Operations Runbook

Step-by-step procedures for the Task Management API. Written for someone who has never seen this system. Each runbook lists when to use it, what you need, the exact commands, the output to expect, how to verify success, how to roll back, and when to escalate.

## Contents

- [Runbook: Local Development Setup](#runbook-local-development-setup)
- [Runbook: Running Tests](#runbook-running-tests)
- [Runbook: Database Migrations](#runbook-database-migrations)
- [Runbook: Production Deployment Checklist](#runbook-production-deployment-checklist)
- [Known Gaps](#known-gaps)

---

## Runbook: Local Development Setup

### When to use this

You are setting up the project on a fresh machine and want the API running locally against a real PostgreSQL 16 database.

### Prerequisites

- Node.js 22 LTS or newer, and npm 10+.
- Docker (recommended, for the database), **or** a local PostgreSQL 16 instance.
- A terminal in the repository root (`agentcorp-v2`).

### Steps

1. **Verify your toolchain.**
   ```bash
   node --version
   npm --version
   ```
   Expected output: `v22.x.x` (or higher) and `10.x.x` (or higher). If Node is older than 22, install Node 22 LTS before continuing.

2. **Install dependencies.**
   ```bash
   npm install
   ```
   Expected output: npm installs packages and ends with a summary line like `added 350 packages ... found 0 vulnerabilities`. A `postinstall` step may run `prisma generate`; if not, you will run it in step 6.

3. **Start PostgreSQL 16** (Docker path).
   ```bash
   docker run --name taskdb \
     -e POSTGRES_USER=user \
     -e POSTGRES_PASSWORD=password \
     -e POSTGRES_DB=taskmanagement \
     -p 5432:5432 -d postgres:16-alpine
   ```
   Expected output: a 64-character container ID. Confirm it is running:
   ```bash
   docker ps --filter name=taskdb
   ```
   Expected output: one row showing `taskdb`, image `postgres:16-alpine`, status `Up ...`.

   > Already running PostgreSQL 16 locally? Skip this step and adjust `DATABASE_URL` in step 4 to match your credentials, host, port, and database name.

4. **Create your environment file.**
   ```bash
   cp .env.example .env
   ```
   Expected output: none (a silent copy). On Windows PowerShell use `Copy-Item .env.example .env`.

5. **Set the two JWT secrets** (each must be at least 32 bytes, or the app will not start).
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Expected output: a long random string. Run it twice and paste the two distinct values into `JWT_SECRET` and `JWT_REFRESH_SECRET` in `.env`. If you used the Docker command above verbatim, the default `DATABASE_URL` already matches and needs no change.

6. **Generate the Prisma client.**
   ```bash
   npm run db:generate
   ```
   Expected output: `Generated Prisma Client ... in <time>`.

7. **Apply the database migrations.**
   ```bash
   npm run db:migrate
   ```
   Expected output: Prisma reports the migrations being applied and ends with `Your database is now in sync with your schema.` (it may prompt for a migration name on first run in a fresh project — accept the default).

8. **Start the dev server.**
   ```bash
   npm run dev
   ```
   Expected output: a JSON/pretty log line indicating the server is listening on port `3000`, e.g. `Server listening at http://0.0.0.0:3000`.

   > If startup fails with `Environment configuration invalid: JWT_SECRET must be at least 32 bytes`, return to step 5.

### Verify success

```bash
curl http://localhost:3000/health
```

Expected output:

```json
{"success":true,"data":{"status":"ok"}}
```

Then run a full smoke flow (register → token → create task) from [the API end-to-end example](api.md#end-to-end-example). A `201` on task creation confirms the database, auth, and routing all work.

### Rollback

To tear the local environment down completely:

```bash
docker stop taskdb && docker rm taskdb   # remove the database container + its data
rm .env                                    # remove local secrets/config
rm -rf node_modules                        # remove installed dependencies
```

(On PowerShell: `Remove-Item .env`, `Remove-Item -Recurse -Force node_modules`.)

### Common failure modes

| Symptom | Cause | Resolution |
|---|---|---|
| `Environment configuration invalid: JWT_SECRET ...` at startup | Secret shorter than 32 bytes or unset. | Regenerate secrets (step 5) and set both `JWT_SECRET` and `JWT_REFRESH_SECRET`. |
| `Can't reach database server at localhost:5432` | PostgreSQL not running, or wrong `DATABASE_URL`. | Confirm `docker ps` shows `taskdb`; check host/port/credentials in `DATABASE_URL`. |
| `port 5432 ... already allocated` (Docker) | Another PostgreSQL already binds 5432. | Stop the other instance, or map a different host port (`-p 5433:5432`) and update `DATABASE_URL`. |
| `EADDRINUSE :::3000` | Port 3000 is taken. | Set `PORT` in `.env` to a free port, or stop the conflicting process. |
| `@prisma/client did not initialize yet` | Prisma client not generated. | Run `npm run db:generate` (step 6). |

---

## Runbook: Running Tests

### When to use this

Before pushing changes, when reviewing a pull request, or to verify the quality gates (line coverage ≥ 80%, branch coverage ≥ 70%).

### Prerequisites

- Dependencies installed (`npm install`).
- **No database required.** The suite uses an in-memory Prisma fake, and the test setup injects valid test environment variables automatically. You do **not** need a `.env` file or a running PostgreSQL to run tests.

### Steps

1. **Run the unit + integration suite.**
   ```bash
   npm test
   ```
   Expected output: Vitest runs every `src/**/*.test.ts` file and ends with a green summary, e.g. `Test Files  9 passed (9)` and `Tests  98 passed (98)`, exit code `0`.

2. **Run with a coverage report** (this is the gate-checking command).
   ```bash
   npm run test:coverage
   ```
   Expected output: the test summary followed by a coverage table. Global numbers should comfortably exceed the thresholds — at last run: **Lines ~98%, Branches ~94%, Functions ~97%**. The command exits non-zero if any configured threshold (lines 80 / branches 70 / functions 80 / statements 80) is not met.

3. **Run in watch mode while developing** (optional).
   ```bash
   npm run test:watch
   ```
   Expected output: Vitest stays running and re-runs affected tests on file save. Press `q` to quit.

### Verify success

- `npm test` exits `0` with all tests passing.
- `npm run test:coverage` exits `0` and the coverage table shows Lines ≥ 80% and Branches ≥ 70% globally.

### Rollback

Tests do not mutate any persistent state (the DB is in-memory per run), so there is nothing to undo. If watch mode is running, press `q` to stop it.

### Escalate if

- A test is **flaky** (passes/fails across identical runs) — the suite must be deterministic. Re-run twice; if results differ, capture the seed/output and raise it with the QA owner.
- Coverage drops below a gate threshold and you cannot raise it without testing dead code — bring it to quality-lead rather than lowering the threshold.

---

## Runbook: Database Migrations

### When to use this

You changed `prisma/schema.prisma` and need to create/apply a migration, you are bringing a fresh database up to date, or you need to undo the most recent migration.

### Prerequisites

- A reachable PostgreSQL 16 and a valid `DATABASE_URL`.
- For destructive steps (rollback/reset), a backup or the certainty that the data is disposable.

### Apply migrations

**Development** (creates a new migration from schema changes and applies it):

```bash
npm run db:migrate
```

Expected output: Prisma generates a timestamped migration folder under `prisma/migrations/`, applies it, regenerates the client, and prints `Your database is now in sync with your schema.`

**Production / CI** (applies already-committed migrations without generating new ones):

```bash
npm run db:migrate:deploy
```

Expected output: `N migrations applied` (or `No pending migrations to apply.`). This command never prompts and never creates migrations — safe for automated pipelines.

### Verify success

```bash
docker exec -it taskdb psql -U user -d taskmanagement -c "\dt"
```

Expected output: a table list including `users`, `tasks`, `refresh_tokens`, and `_prisma_migrations`. Check enums too:

```bash
docker exec -it taskdb psql -U user -d taskmanagement -c "\dT+"
```

Expected output: `TaskStatus` (`TODO, IN_PROGRESS, DONE, CANCELLED`) and `TaskPriority` (`LOW, MEDIUM, HIGH, URGENT`).

### Rollback

This project ships **hand-written reversible migrations**: each migration folder under `prisma/migrations/` contains both `migration.sql` (up) and `down.sql` (down). Prisma's CLI does not run `down.sql` automatically, so rolling back is a manual `psql` apply of the appropriate `down.sql`, most recent first.

To undo the most recent migration only (example: revert `002_indexes`):

```bash
docker exec -i taskdb psql -U user -d taskmanagement < prisma/migrations/002_indexes/down.sql
```

To revert the entire schema to empty, apply the down scripts in reverse order:

```bash
docker exec -i taskdb psql -U user -d taskmanagement < prisma/migrations/002_indexes/down.sql
docker exec -i taskdb psql -U user -d taskmanagement < prisma/migrations/001_initial/down.sql
```

Expected output: `DROP INDEX` / `DROP TABLE` / `DROP TYPE` confirmations with no errors. Re-applying the up migrations afterward must succeed cleanly (reversibility was verified end-to-end by the db-engineer).

> **Nuclear option (development only — destroys all data):**
> ```bash
> npm run db:reset
> ```
> Drops the database, re-creates it, and re-applies every migration. Never run against production.

### Escalate if

- `down.sql` errors out partway (the schema is now in an inconsistent state) — stop, do not run further migrations, and restore from backup.
- A migration must run against production data with no tested rollback — get db-engineer and quality-lead sign-off first; migrations must be reversible (project constraint).

---

## Runbook: Production Deployment Checklist

### When to use this

You are deploying the API to a production (or staging) environment.

### Prerequisites

- Built artifact or source on the target, with `npm ci` run for a clean dependency install.
- A managed PostgreSQL 16 instance reachable from the app.
- A secrets manager or platform env-var mechanism (never commit secrets — project constraint).
- HTTPS termination (load balancer or reverse proxy) in front of the app — required because production cookies are `Secure`.

### Steps

1. **Set every required environment variable** in the target environment:

   | Variable | Production guidance |
   |---|---|
   | `NODE_ENV` | Must be `production` (enables `Secure` cookies, `trustProxy`, JSON logging). |
   | `PORT` | The port your platform expects (often injected). |
   | `DATABASE_URL` | Points at the managed PostgreSQL 16. Behind PgBouncer (transaction mode), append `&pgbouncer=true` and set `connection_limit=1` per instance. |
   | `JWT_SECRET` | A unique, high-entropy value ≥ 32 bytes. **Different** from every other environment. |
   | `JWT_REFRESH_SECRET` | A unique, high-entropy value ≥ 32 bytes, **different** from `JWT_SECRET`. |
   | `ACCESS_TOKEN_TTL` | Default `15m` unless you have a reason to change it. |
   | `REFRESH_TOKEN_TTL` | Default `7d` unless policy dictates otherwise. |
   | `BCRYPT_ROUNDS` | `12` (OWASP). Raise only after profiling. |
   | `CORS_ORIGINS` | The exact production frontend origin(s), comma-separated. **Never** `*`. Required so the CSRF Origin/Referer check is active. |

2. **Install dependencies and build.**
   ```bash
   npm ci
   npm run build
   ```
   Expected output: a clean install, then `tsc` compiles to `dist/` with no errors.

3. **Apply migrations** (non-interactive).
   ```bash
   npm run db:migrate:deploy
   ```
   Expected output: `N migrations applied` or `No pending migrations to apply.` Run this before starting/serving traffic from new instances.

4. **Start the server.**
   ```bash
   npm start
   ```
   Expected output: a JSON log line indicating the server is listening. (`npm start` runs `node dist/server.js`.)

5. **Confirm the health check.**
   ```bash
   curl https://<your-domain>/health
   ```
   Expected output: `{"success":true,"data":{"status":"ok"}}`. Wire this endpoint into your platform's liveness/readiness probe.

### Verify success

- `/health` returns `200` with `status: ok`.
- A login from the production frontend succeeds and sets a `Secure; HttpOnly; SameSite=Strict` `refresh_token` cookie (inspect in browser dev tools).
- A cross-origin request from a non-allowlisted origin to `/auth/refresh` is rejected with `403`.
- Logs contain **no** plaintext passwords, tokens, cookies, or `Authorization` headers (redaction is on).

### Rollback

1. Redeploy the previous known-good release/image and restart instances.
2. If a migration is implicated, follow the [migration rollback](#rollback-2) steps (apply the relevant `down.sql`) — only with a verified backup.
3. If a refresh-secret was rotated, expect all existing sessions to be invalidated; users simply re-login (acceptable).

### Escalate if

- `/health` does not return `200` after deploy and a restart does not fix it.
- A migration fails in production, or its rollback errors partway.
- Rate-limit counters behave inconsistently across instances — multi-instance deployments need a shared store (Redis); the in-memory limiter is per-instance only (ADR-014). Raise with devops.

---

## Known Gaps

These are documentation-discovered gaps that an operator should know about. They do not block running the system but warrant a follow-up fix.

1. **No `docker-compose.yml` / Dockerfile in the repository.** The README and this runbook use a single `docker run` for the local database. A committed Compose file (app + db) and a Dockerfile would make the quick start one command and are recommended for devops follow-up.

2. **Rate limiting is in-memory (single-instance).** Correct distributed counting across multiple instances requires a shared store (Redis), per ADR-014. Acceptable for single-instance/dev; plan Redis before horizontal scale.
