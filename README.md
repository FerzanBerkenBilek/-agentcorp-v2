# Task Management API

A production-ready REST API for managing tasks and users, with JWT-based authentication, object-level authorization, and task assignment between registered users. Built on Fastify, Prisma, and PostgreSQL with security, clean code, and maintainability as first-class priorities.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [API Overview](#api-overview)
- [URL Shortener](#url-shortener)
- [Documentation](#documentation)
- [Contributing](#contributing)

---

## Quick Start

From zero to a running API. Two paths are described: a database via Docker, then the app via npm.

### Prerequisites

- **Node.js 22 LTS** or newer (`node --version` should print `v22.x` or higher)
- **npm 10+** (ships with Node 22)
- **PostgreSQL 16** — either a local install or Docker (Docker is the simplest path)
- **Docker** (optional, recommended for the database)

### 1. Clone and install

```bash
git clone <repository-url>
cd agentcorp-v2
npm install
```

### 2. Start PostgreSQL 16

If you have Docker, the fastest way to get a matching PostgreSQL 16 is a one-line container:

```bash
docker run --name taskdb -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=taskmanagement -p 5432:5432 -d postgres:16-alpine
```

> No `docker-compose.yml` ships with this repository yet (see [Documentation Gaps](docs/runbook.md#known-gaps)). The single `docker run` above is the supported local-database path. If you already run PostgreSQL 16 locally, skip this step and point `DATABASE_URL` at your instance.

### 3. Configure environment

```bash
cp .env.example .env
```

Then edit `.env` and set **at minimum** two JWT secrets, each **at least 32 bytes**, or the process will refuse to start. Generate strong values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run it twice and paste the two outputs into `JWT_SECRET` and `JWT_REFRESH_SECRET`. See [Environment Variables](#environment-variables) for the full list.

### 4. Apply database migrations

```bash
npm run db:migrate
```

This creates the `users`, `tasks`, and `refresh_tokens` tables, the enums, and all indexes.

### 5. Run the API

```bash
npm run dev
```

The server starts on `http://localhost:3000`. Verify it is up:

```bash
curl http://localhost:3000/health
# {"success":true,"data":{"status":"ok"}}
```

You are now running. Continue to the [API Overview](#api-overview) or the full [API documentation](docs/api.md).

---

## Architecture Overview

The codebase follows a **strict 4-layer architecture** (ADR-010) organized into **3 vertical feature modules plus a shared core** (ADR-011). Dependencies point downward only: a layer may call the layer directly beneath it and never calls upward.

### Layers (top to bottom)

```
┌────────────────────────────────────────────────────────────┐
│  HTTP / Plugin layer  (app.ts, server.ts)                   │
│  helmet · CORS allowlist · cookie · rate-limit ·            │
│  global error handler · request logging                     │
└───────────────┬────────────────────────────────────────────┘
                │ registers
┌───────────────▼────────────────────────────────────────────┐
│  Route layer  (*.routes.ts)                                 │
│  URL + verb binding · Zod parse · auth guard preHandler ·   │
│  maps service results/errors → HTTP. NO business logic,     │
│  NO Prisma.                                                 │
└───────────────┬────────────────────────────────────────────┘
                │ plain TS function calls
┌───────────────▼────────────────────────────────────────────┐
│  Service layer  (*.service.ts, tasks.policy.ts)             │
│  business rules · object-level authorization · invariants · │
│  throws typed domain errors. NO HTTP types, NO Prisma.      │
└───────────────┬────────────────────────────────────────────┘
                │ calls
┌───────────────▼────────────────────────────────────────────┐
│  Repository layer  (*.repository.ts)                        │
│  the ONLY code that imports the Prisma client.              │
│  one method = one intent. NO business rules.                │
└───────────────┬────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│  Prisma 5  →  PostgreSQL 16                                  │
└────────────────────────────────────────────────────────────┘
```

### Modules (vertical slices)

```
                       ┌─────────────┐
                       │   shared    │  config · errors · logger ·
                       │   (core)    │  prisma client · jwt · http ·
                       └──────┬──────┘  csrf · audit · validate
        imported by everything (downward; never imports features)
        ┌──────────────┬──────┴───────┬──────────────┐
   ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
   │  auth   │    │  tasks  │    │  users  │
   │ module  │    │ module  │    │ module  │
   └────┬────┘    └────┬────┘    └────▲────┘
        │              │              │
        │ auth.service ───────────────┤ reads User by email/id
        │              │              │ via users.repository
        │              └──────────────┤ validates assignee exists
        └─────────────────────────────┘ via users.repository
```

- **`auth`** — registration, login, refresh-token rotation with reuse detection, logout, token issuance/verification, password hashing. Owns credentials and tokens.
- **`users`** — authorized profile read (`GET /users/me`) and the thin read methods other modules use. Owns the **User** aggregate. A read leaf: depends only on `shared`.
- **`tasks`** — task CRUD, assignment, filtering, and all object-level authorization (`tasks.policy`). Owns the **Task** aggregate.
- **`shared` (core)** — Prisma client singleton, domain error types, env config, logger, JWT helpers, auth guard, CSRF guard, validation, audit log, HTTP response envelope.

For the full rationale, see [`context/decisions.md`](context/decisions.md) (ADR-010, ADR-011).

---

## Environment Variables

All environment access happens in `src/config.ts`, which validates every variable at startup with Zod. **If any required variable is missing or malformed, the process refuses to boot** — it never runs half-configured. Copy `.env.example` to `.env` and fill it in.

| Variable | Type | Required | Default | Description |
|---|---|---|---|---|
| `PORT` | integer (1–65535) | No | `3000` | Port the HTTP server listens on. |
| `NODE_ENV` | `development` \| `test` \| `production` | No | `development` | Runtime mode. `production` enables `Secure` cookies, `trustProxy`, and JSON logging. |
| `DATABASE_URL` | string (connection URL) | **Yes** | — | PostgreSQL connection string. Carries the Prisma connection-pool params (`connection_limit`, `pool_timeout`, `connect_timeout`). See note below. |
| `JWT_SECRET` | string (≥ 32 bytes) | **Yes** | — | Secret for signing/verifying **access** tokens (HS256). Startup fails if shorter than 32 bytes. |
| `JWT_REFRESH_SECRET` | string (≥ 32 bytes) | **Yes** | — | Secret for signing **refresh** tokens. Must differ from `JWT_SECRET`. Startup fails if shorter than 32 bytes. |
| `ACCESS_TOKEN_TTL` | duration string | No | `15m` | Access-token lifetime (`15m`, `1h`, `30s`, etc.). |
| `REFRESH_TOKEN_TTL` | duration string | No | `7d` | Refresh-token lifetime; also the refresh cookie `Max-Age`. |
| `BCRYPT_ROUNDS` | integer (10–14) | No | `12` | bcrypt cost factor. `12` is the OWASP recommendation (ADR-008). |
| `CORS_ORIGINS` | comma-separated origins | No | `` (empty) | Allowlist of origins permitted to send credentialed cross-origin requests. Also drives the CSRF Origin/Referer check. Empty disables cross-origin requests and skips the CSRF origin check. **Never** use `*` with credentials. Example: `https://app.example.com,https://admin.example.com`. |

**Example `DATABASE_URL`:**

```
postgresql://user:password@localhost:5432/taskmanagement?schema=public&connection_limit=9&pool_timeout=10&connect_timeout=5
```

- `connection_limit` — max connections this instance opens. Formula: `(2 * cores) + spindles`. Must satisfy `connection_limit * instances <= Postgres max_connections`.
- `pool_timeout` — seconds Prisma waits for a free pooled connection (default `10`).
- `connect_timeout` — seconds to establish a new connection (default `5`).
- In production behind **PgBouncer** (transaction mode): add `&pgbouncer=true` and set `connection_limit=1` per instance.

---

## Available Scripts

| Script | Command | Purpose |
|---|---|---|
| Dev server | `npm run dev` | Run with hot reload via `tsx watch`. |
| Build | `npm run build` | Compile TypeScript to `dist/`. |
| Start (prod) | `npm start` | Run the compiled server from `dist/`. |
| Test | `npm test` | Run the full Vitest suite once. |
| Test (watch) | `npm run test:watch` | Run Vitest in watch mode. |
| Coverage | `npm run test:coverage` | Run tests with a V8 coverage report. |
| Migrate (dev) | `npm run db:migrate` | Create/apply migrations in development (`prisma migrate dev`). |
| Migrate (deploy) | `npm run db:migrate:deploy` | Apply pending migrations in production (`prisma migrate deploy`). |
| Generate client | `npm run db:generate` | Regenerate the Prisma client after a schema change. |
| Reset DB | `npm run db:reset` | Drop and re-create the database, then re-apply migrations. **Destroys all data.** |
| Studio | `npm run db:studio` | Open Prisma Studio (browser DB explorer). |
| Lint | `npm run lint` | Run ESLint over `src`. |
| Typecheck | `npm run typecheck` | Type-check without emitting (`tsc --noEmit`). |

---

## API Overview

All responses use a uniform envelope:

- Success: `{ "success": true, "data": ... }`
- Error: `{ "success": false, "error": { "code": "...", "message": "...", "details"?: ... } }`

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | None | Create an account; returns an access token (body) + refresh token (cookie). |
| `POST` | `/auth/login` | None | Authenticate with email + password; returns tokens. |
| `POST` | `/auth/refresh` | Refresh cookie | Rotate the refresh token and issue a new access token. |
| `POST` | `/auth/logout` | Refresh cookie | Revoke the refresh-token family and clear the cookie. |
| `GET` | `/tasks` | Bearer | List the caller's tasks (owned or assigned), with status/priority filters and pagination. |
| `POST` | `/tasks` | Bearer | Create a task owned by the caller. |
| `GET` | `/tasks/:id` | Bearer | Read a single task (owner or assignee only). |
| `PATCH` | `/tasks/:id` | Bearer | Update a task; reassign/unassign is owner-only. |
| `DELETE` | `/tasks/:id` | Bearer | Delete a task (owner only). |
| `GET` | `/users/me` | Bearer | Return the authenticated user's profile. |
| `POST` | `/shorten` | Bearer | Create a 6-char short code for a long URL (URL-safety validated). |
| `GET` | `/:code` | None | Resolve a short code; `302` redirect to the original URL. |
| `GET` | `/:code/stats` | Bearer | Click analytics for a short code (owner only). |
| `DELETE` | `/:code` | Bearer | Delete a short code (owner only). |
| `GET` | `/health` | None | Liveness probe; returns `{ status: "ok" }`. |

Full request/response schemas, error codes, and working `curl` examples are in **[`docs/api.md`](docs/api.md)**.

---

## URL Shortener

Turn a long URL into a short, 6-character base62 code, then resolve that code with an anonymous `302` redirect. Codes come from a cryptographically secure random source (not sequential), so they are not enumerable. Every submitted URL is validated against an SSRF / open-redirect policy at creation time — only `http`/`https`, default web ports, and public hosts are accepted; `localhost`, private/RFC1918, loopback, cloud-metadata (`169.254.169.254`), and IPv4-mapped-IPv6 equivalents are rejected (ADR-019). `POST`/`DELETE`/stats require auth; the redirect is public.

In the examples below, `$ACCESS_TOKEN` is an access token from `POST /auth/login`. Full schemas and error tables are in **[`docs/api.md`](docs/api.md#url-shortener)**.

### Endpoints

#### `POST /shorten`

- **Auth:** Bearer access token. **Rate limit:** 10 requests / min per IP.
- Create a short code for a long URL. The link is owned by the caller; `url` is the only accepted field (all other fields are set server-side).

```bash
curl -i -X POST http://localhost:3000/shorten \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/some/very/long/path?ref=newsletter"}'
```

```jsonc
// 201 Created
{ "success": true, "data": {
  "code": "aZ3xK9",
  "originalUrl": "https://example.com/some/very/long/path?ref=newsletter",
  "createdAt": "2026-06-09T12:00:00.000Z"
} }
```

#### `GET /:code`

- **Auth:** none (anonymous) — the only public shortener endpoint.
- Resolves the code and redirects to the original URL, incrementing its click count. Returns **`302 Found`** with `Cache-Control: no-store` (not `301`, so click tracking stays accurate and deletes take effect immediately — ADR-020). `404` if the code does not exist.

```bash
# -i shows the 302 + Location + Cache-Control headers; omit -L so curl does not auto-follow.
curl -i http://localhost:3000/aZ3xK9
```

```http
HTTP/1.1 302 Found
Location: https://example.com/some/very/long/path?ref=newsletter
Cache-Control: no-store
```

#### `GET /:code/stats`

- **Auth:** Bearer access token. **Owner only.**
- Returns click analytics. A non-owner (or missing code) gets `404`, not `403`, to prevent enumeration (ADR-021).

```bash
curl -s http://localhost:3000/aZ3xK9/stats \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

```jsonc
// 200 OK  (lastAccessedAt is null until the first redirect)
{ "success": true, "data": {
  "clickCount": 42,
  "createdAt": "2026-06-09T12:00:00.000Z",
  "lastAccessedAt": "2026-06-09T15:30:00.000Z"
} }
```

#### `DELETE /:code`

- **Auth:** Bearer access token. **Owner only.**
- Deletes the link; afterwards the redirect returns `404`. A non-owner (or missing code) gets `404`, not `403`.

```bash
curl -i -X DELETE http://localhost:3000/aZ3xK9 \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# 204 No Content
```

---

## Documentation

- **[API reference](docs/api.md)** — every endpoint with schemas, error codes, and curl examples.
- **[Runbook](docs/runbook.md)** — local setup, running tests, migrations, and the production deployment checklist.
- **[Architecture decisions](context/decisions.md)** — all ADRs (stack, security, data model).

---

## Contributing

### Where to start

1. Read this README, then the [architecture overview](#architecture-overview) above.
2. Skim [`context/decisions.md`](context/decisions.md) — every non-obvious choice has a recorded ADR.
3. Follow the [local development setup runbook](docs/runbook.md#runbook-local-development-setup).

### Rules of the road

- **Respect the layer boundaries.** Routes never import Prisma; services never import Fastify types; only repositories touch the Prisma client. (ADR-010)
- **Keep modules vertical.** A new capability is a new module under `src/` depending on `tasks.repository`/`users.repository` + `shared` — not edits scattered across folders. (ADR-011)
- **Validate every input with Zod**, using `.strict()` to reject unknown keys (mass-assignment defense).
- **Authorization is object-level**, centralized in `tasks.policy`. Return `404` (not `403`) for unauthorized resource access to avoid enumeration. (ADR-013)
- **Every decision gets a rationale.** Architectural choices go in `context/decisions.md` as an ADR; non-obvious code gets a comment explaining *why*.

### How to submit changes

1. Branch off the default branch.
2. Make your change with tests. Coverage gates: **line ≥ 80%, branch ≥ 70%**.
3. Run the local quality gate before pushing:
   ```bash
   npm run lint && npm run typecheck && npm run test:coverage
   ```
4. Open a pull request describing the change and linking any relevant ADR.
