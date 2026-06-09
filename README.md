# AgentCorp v2

> Production-ready task management and URL shortening API

![Tests](https://img.shields.io/badge/tests-197%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/lines-98.74%25-brightgreen)
![Branch](https://img.shields.io/badge/branch-95%25-brightgreen)
![Build](https://img.shields.io/badge/tsc-0%20errors-brightgreen)
![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)
![License](https://img.shields.io/badge/version-1.1.0-blue)

A REST API combining a JWT-secured **task manager** and an SSRF-hardened **URL shortener**, built on Node.js 22, TypeScript (strict), Fastify, Prisma, and PostgreSQL. It is production-ready by construction: a strict layered architecture (route → service → repository), object-level authorization on every resource, threat-modeled security on every feature, **197 tests at 98.74% line coverage**, and **24 Architecture Decision Records** documenting every non-obvious choice.

---

## ✨ Features

### 📋 Task Management
- 🔐 JWT authentication with refresh-token rotation (and reuse detection)
- ✏️ Create, update, delete tasks
- 👥 Assign tasks to other users (assignees can view and update)
- 🔎 Filter by status (`TODO` / `IN_PROGRESS` / `DONE` / `CANCELLED`) and priority (`LOW` / `MEDIUM` / `HIGH` / `URGENT`)
- 🛡️ Rate limiting, CSRF protection, audit logging

### 🔗 URL Shortener
- ✂️ Shorten any URL, get a 6-character alphanumeric code
- 🔀 Anonymous redirect (`302`, click-tracking compatible)
- 📊 Per-URL statistics: click count, created date, last accessed
- 🔒 Owner-only management (read stats, delete)
- ⏱️ Rate limited: 10 requests/minute per IP

---

## 🏗️ Architecture

### Project Structure

```
src/
├── auth/          # JWT auth, refresh token rotation + reuse detection
├── tasks/         # Task CRUD, assignment, filtering, ownership policy
├── urls/          # URL shortener, SSRF validation, click tracking
├── users/         # User profile reads
└── shared/        # Errors, JWT utils, logger, validation, audit, url-safety
```

Each feature module is a vertical slice with the same internal layers:

```
*.routes.ts   → HTTP binding, Zod parse, auth guard      (no business logic, no Prisma)
*.service.ts  → business rules + authorization            (no HTTP types, no Prisma)
*.policy.ts   → object-level authorization (owner/assignee)
*.repository.ts → the ONLY code that touches the Prisma client
```

### Design Principles
- 🧱 **Clean architecture** — strict route → service → repository separation (ADR-010)
- 🚫 **Business logic in the service layer, never in controllers**
- 💉 **Dependency injection** throughout (repositories injected into services, services into routes)
- 📝 **Every public function documented** with JSDoc (`@param` / `@returns` / `@throws`)
- 🔢 **No magic numbers** — all constants named (`CODE_LENGTH`, `MAX_URL_LENGTH`, `DNS_TIMEOUT_MS`, …)

### Architecture Decisions (ADRs)

This project documents **24 architecture decisions** in [`context/decisions.md`](context/decisions.md). Each records the context, the decision, the alternatives, and the trade-off.

| ADR | Decision | Why |
|-----|----------|-----|
| ADR-001 | Node.js 22 LTS + TypeScript 5 (strict) | Type-safe, well-supported runtime; strict mode catches errors at compile time. |
| ADR-002 | Fastify as the web framework | Schema-first validation, plugin model, low overhead vs Express. |
| ADR-003 | Prisma 5 as the ORM | Type-safe client + first-class migrations; schema as single source of truth. |
| ADR-004 | PostgreSQL 16 as the only store | Relational data with ACID integrity; partial indexes, strong JSONB. |
| ADR-005 | JWT access + refresh tokens | Stateless access checks; short access TTL limits blast radius of theft. |
| ADR-006 | Zod for validation | TypeScript inference from one schema; `.strict()` blocks mass-assignment. |
| ADR-007 | Vitest as the test framework | Native ESM/TS, fast, built-in V8 coverage. |
| ADR-008 | bcrypt (12 rounds) for passwords | OWASP-recommended cost factor; widely audited. |
| ADR-009 | Defense-in-depth security architecture | Rate limits + parameterized queries + helmet + CORS + validation layered. |
| ADR-010 | 4-layer architecture (route/service/repo/Prisma) | Downward-only dependencies keep modules testable and decoupled. |
| ADR-011 | Vertical feature modules + shared core | Capabilities are self-contained; no logic scattered across folders. |
| ADR-012 | Refresh-token rotation + reuse detection | Replaying a stolen, consumed token revokes the whole family. |
| ADR-013 | Object-level authorization (404-not-403) | Prevents IDOR and resource enumeration via guessed IDs. |
| ADR-014 | Per-route rate-limit thresholds | Brute-force and abuse protection sized per endpoint risk. |
| ADR-015 | CSRF protection on the cookie refresh | SameSite + Origin/Referer check on the only cookie-driven endpoint. |
| ADR-016 | UUID surrogate primary keys | Non-sequential IDs are not enumerable (supports ADR-013). |
| ADR-017 | 3NF schema with native enums, no denormalization | Integrity by construction; no in-scope read pattern justifies duplication. |
| ADR-018 | Single PostgreSQL store; Redis deferred | One transactional boundary; add Redis only at multi-instance scale. |
| ADR-019 | SSRF / open-redirect URL validation | Allowlist-by-construction blocks internal/metadata targets at write time. |
| ADR-020 | Redirect uses HTTP 302, not 301 | A cached 301 breaks click tracking and makes takedown irretractable. |
| ADR-021 | Short-link stats are owner-only (404-not-403) | Stats reveal usage; non-owners must not learn a code exists. |
| ADR-022 | CSPRNG base62 codes + unique-retry | Random (not sequential) codes are unguessable; collisions retried, not raced. |
| ADR-023 | Atomic in-place click increment | Avoids the lost-update race of read-modify-write under concurrency. |
| ADR-024 | ShortUrl data model (3NF, UUID PK, code + owner indexes) | Hot redirect lookup and owner authz both hit an index. |

---

## 🔒 Security

### Threat Model
- 🎯 **STRIDE threat modeling** applied to every feature before implementation
- ✅ **OWASP Top 10** checked for every endpoint

### Authentication
- 🔑 JWT **HS256 with a pinned algorithm** — forged `alg:none` tokens are rejected
- ♻️ **Refresh-token rotation** with `family` / `jti` **reuse detection** (replay revokes the family)
- 🍪 Refresh tokens delivered as **httpOnly, Secure, SameSite=Strict cookies** (XSS-resistant)
- 📏 **32-byte minimum secret** enforced from the environment at startup (the process refuses to boot otherwise)

### Authorization
- 🚷 **IDOR prevention** — resource ownership verified on every read/update/delete
- 🕵️ **`404` instead of `403`** for unauthorized resources (prevents enumeration)
- 📜 Owner/assignee scope checked at the policy layer (`tasks.policy.ts`, `urls.policy.ts`)

### SSRF Prevention (URL Shortener)
Implemented in [`src/shared/url-safety.ts`](src/shared/url-safety.ts), validated at **write time** before a URL is ever stored:

- 🚫 **Blocks IPv4:** `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8` (loopback), `169.254.0.0/16` (link-local incl. `169.254.169.254` metadata), `172.16.0.0/12`, `192.168.0.0/16`, `255.255.255.255`
- 🚫 **Blocks IPv6:** loopback (`::1`), unspecified (`::`), link-local (`fe80::/10`), unique-local (`fc00::/7`)
- 🚫 **Blocks IPv4-mapped IPv6** (`::ffff:x.x.x.x`) in **both** dotted-decimal **and** compressed-hex form (`::ffff:7f00:1`) — caught as a real bypass during QA review and closed with a reject matrix
- 🔐 **Scheme/port allowlist:** only `http`/`https`, only ports 80/443, no embedded credentials, 2048-byte cap
- 🧮 **Encoding-proof:** decimal/hex/octal IPv4 literals (e.g. `http://2130706433/`) are normalized before the range check
- ⛔ **Fail-closed:** DNS resolution failure or 3s timeout rejects the request

### Rate Limiting
- 🔐 Auth endpoints: **5 requests / 15 min per IP** (brute-force prevention)
- ✂️ URL shortening: **10 requests / min per IP**
- 🌐 Global authenticated default: **100 requests / min per IP**
- 🙈 **Generic error messages** on auth failure (no account enumeration)

### Input Validation
- 🧾 **Zod** schemas on every endpoint, `.strict()` to reject unknown keys
- 🔗 **URL validation:** structure + SSRF range-check before storage
- 💉 **SQL injection:** prevented by Prisma parameterized queries (no raw string SQL)

---

## ✅ Testing

### Results

| Metric | Value |
|--------|-------|
| Total tests | 197 |
| Passing | 197 (100%) |
| Line coverage | 98.74% |
| Branch coverage | 95.00% |
| Function coverage | 98.16% |
| TypeScript errors | 0 |

### Test Strategy
- 🧩 **Unit tests** — pure functions and services, isolated, fast
- 🔁 **Integration tests** — full HTTP request/response cycle against an in-memory Prisma stand-in (`src/test/fake-prisma.ts`) so CI needs no live database
- 🧾 **Schema validation** tested with both valid and invalid inputs
- 🛡️ **Security tests** — SSRF bypass matrix, auth edge cases, rate-limit behavior, refresh-token reuse detection

### Running Tests

```bash
npm test                    # run all tests
npm run test:coverage       # with coverage report
npm test -- src/auth/       # a specific module
```

---

## 🧭 Hierarchy & Memory System

This repository ships an optional **multi-agent orchestration system** (`.agents/`) used to plan and review work on the codebase. A top-level **orchestrator** decomposes a request, routes it to **domain leads**, who direct **specialists**; results flow back up to be synthesized. Context is handed off through a shared scratchpad rather than re-sent between steps.

### Agent Hierarchy (3 tiers)

```
Orchestrator
├── tech-lead      → backend-dev, devops, architect
├── ai-lead        → ml-engineer, prompt-engineer
├── quality-lead   → qa-engineer, code-quality, security-engineer
├── data-lead      → db-engineer, data-engineer
└── frontend-lead  → frontend-dev, mobile-dev, maintainability, tech-writer
```

### Memory & Context
- 🧠 **agentmemory MCP** — lifecycle hooks persist and recall compressed, per-agent context across sessions
- 📋 **`context/brief.md`** — shared scratchpad holding handoff state between agents
- 📐 **`context/decisions.md`** — the permanent ADR store (24 records)
- 🔁 **`context/patterns.md`** — reusable patterns discovered during development (19 entries)

### Token Efficiency
- Only the relevant compressed context is injected per agent, instead of loading the full `CLAUDE.md` every time
- The shared scratchpad prevents re-transmitting context between agents
- Each agent reads only the `decisions.md` sections relevant to its domain
- Net effect: agents keep full project context without loading every file

---

## ⚙️ Setup

### Prerequisites
- Node.js 22 LTS
- PostgreSQL 16+
- Claude Code (`npm install -g @anthropic-ai/claude-code`) — only needed for the agent system

### Installation

```bash
git clone https://github.com/FerzanBerkenBilek/-agentcorp-v2.git
cd -agentcorp-v2
npm install
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/agentcorp"
JWT_SECRET="minimum-32-characters-secret-here"
JWT_REFRESH_SECRET="different-minimum-32-characters-secret"
PORT=3000
```

```bash
npx prisma migrate deploy
npm run dev
```

The server starts on `http://localhost:3000`. Verify with `curl http://localhost:3000/health`.

> 💡 Need a database fast? `docker run --name taskdb -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=agentcorp -p 5432:5432 -d postgres:16-alpine`

### Install the Agent System (optional)

If you want to use the AgentCorp orchestration system:

```bash
# Linux/macOS
bash .agents/install.sh

# Windows (PowerShell)
.\.agents\install.ps1
```

This installs the 20 agent definitions to `~/.claude/agents/` and the global `CLAUDE.md`.

**Required MCP for the agent system:**

| MCP | Why it's needed | How to install |
|-----|----------------|----------------|
| agentmemory | Agents persist memory across sessions. Without it, each session starts fresh — agents won't recall previous decisions, patterns, or context. | `claude mcp add plugin:agentmemory:agentmemory` |

After installing, start Claude Code and hand work to the orchestrator:

```
claude
```
```
Use the orchestrator agent to handle this: [your task]
```

---

## 📡 API Reference

All responses use a uniform envelope — `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code", "message", "details"? } }`.

| Method | Path | Auth | Rate limit | Description |
|--------|------|------|-----------|-------------|
| `POST` | `/auth/register` | None | 5 / 15 min | Create an account; returns access token + refresh cookie. |
| `POST` | `/auth/login` | None | 5 / 15 min | Authenticate; returns tokens. |
| `POST` | `/auth/refresh` | Refresh cookie | 30 / 15 min | Rotate the refresh token, issue a new access token. |
| `POST` | `/auth/logout` | Refresh cookie | Global | Revoke the refresh-token family. |
| `GET` | `/tasks` | Bearer | Global | List owned/assigned tasks (filter + paginate). |
| `POST` | `/tasks` | Bearer | Global | Create a task. |
| `GET` | `/tasks/:id` | Bearer | Global | Read a task (owner or assignee). |
| `PATCH` | `/tasks/:id` | Bearer | Global | Update a task (reassign is owner-only). |
| `DELETE` | `/tasks/:id` | Bearer | Global | Delete a task (owner only). |
| `GET` | `/users/me` | Bearer | Global | Authenticated user's profile. |
| `POST` | `/shorten` | Bearer | 10 / min | Create a 6-char short code. |
| `GET` | `/:code` | None | Global | Resolve a code; `302` redirect. |
| `GET` | `/:code/stats` | Bearer | Global | Click analytics (owner only). |
| `DELETE` | `/:code` | Bearer | Global | Delete a short code (owner only). |
| `GET` | `/health` | None | Global | Liveness probe. |

> Global default rate limit is **100 requests / min per IP**. Full schemas, error tables, and more examples are in [`docs/api.md`](docs/api.md).

**Register:**
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"securepassword123","name":"User"}'
```

**Login:**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"securepassword123"}'
```

**Create task:**
```bash
curl -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix bug","priority":"HIGH","status":"TODO"}'
```

**Shorten URL:**
```bash
curl -X POST http://localhost:3000/shorten \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/very/long/path"}'
```

**Redirect:**
```bash
curl -L http://localhost:3000/abc123
```

---

## 🛠️ Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 22 LTS |
| Language | TypeScript | 5.x |
| Framework | Fastify | 4.x |
| ORM | Prisma | 5.x |
| Database | PostgreSQL | 16 |
| Validation | Zod | 3.x |
| Testing | Vitest | 1.x |
| Auth | jsonwebtoken + bcrypt | — |

---

## 📓 Changelog

Recent releases (full history in [`CHANGELOG.md`](CHANGELOG.md)):

### [1.1.0] — 2026-06-09
- **Added:** URL shortener — `POST /shorten`, `GET /:code` (302), `GET /:code/stats`, `DELETE /:code`; 6-char CSPRNG codes; click analytics; 10/min shorten rate limit.
- **Security:** SSRF-hardened URL validation (scheme/port allowlist, private/metadata/IPv4-mapped-IPv6 blocking, fail-closed DNS); owner-only stats/delete (404-not-403); 302 + `no-store` redirects.

### [1.0.0] — 2026-06-09
- **Added:** Task Management API — registration/login, JWT sessions with refresh-token rotation, task CRUD + assignment, status/priority filtering, pagination; 10 endpoints.
- **Security:** object-level authorization (no IDOR), refresh-token reuse detection, generic auth errors, bcrypt + HS256-pinned JWT + helmet + CORS + audit logging.
