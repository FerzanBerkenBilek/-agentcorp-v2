# AgentCorp v2

> Production-ready task management and URL shortening API

![Tests](https://img.shields.io/badge/tests-616%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/lines-99.38%25-brightgreen)
![Branch](https://img.shields.io/badge/branch-97.5%25-brightgreen)
![Build](https://img.shields.io/badge/tsc-0%20errors-brightgreen)
![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)
![License](https://img.shields.io/badge/version-1.6.0-blue)

## 🤖 Built with Claude Code Agents

This project was designed and implemented using AgentCorp v2 — an orchestrated system of 20 specialized Claude Code agents working in a 3-tier hierarchy. Each agent has a defined role, communicates via a shared scratchpad (brief.md), and persists memory across sessions using the agentmemory MCP.

The agent system is included in this repo (.agents/) and can be installed to replicate the same development workflow on any machine.

A REST API combining a JWT-secured **task manager** and an SSRF-hardened **URL shortener**, built on Node.js 22, TypeScript (strict), Fastify, Prisma, and PostgreSQL. It is production-ready by construction: a strict layered architecture (route → service → repository), object-level authorization on every resource, threat-modeled security on every feature, **616 tests at 99.38% line coverage**, and **49 Architecture Decision Records** documenting every non-obvious choice.

---

## ✨ Features

### 📋 Task Management
- JWT authentication with refresh-token rotation (and reuse detection)
- Create, update, delete tasks
- **Bulk operations** — create / update / delete up to 50 tasks per request, with per-item partial-success results (no rollback) and the same per-item authorization
- Assign tasks to other users (assignees can view and update)
- Filter by status (`TODO` / `IN_PROGRESS` / `DONE` / `CANCELLED`) and priority (`LOW` / `MEDIUM` / `HIGH` / `URGENT`)
- Rate limiting, CSRF protection, audit logging

### 🔗 URL Shortener
- Shorten any URL, get a 6-character alphanumeric code
- Anonymous redirect (`302`, click-tracking compatible)
- Per-URL statistics: click count, created date, last accessed
- Owner-only management (read stats, delete)
- Rate limited: 10 requests/minute per IP

### WebSocket Real-Time Updates (v1.2.0)
- Real-time task updates via WebSocket
- JWT auth on connection, IDOR-proof subscriptions
- Max 10 concurrent connections per user
- 85 new tests

### URL Shortener Abuse Prevention (v1.3.0)
- Domain blocklist with canonical form matching
- Homograph/typosquatting detection for top 50 domains
- 100 URLs/day per user quota
- Confidence score flagging system
- Admin endpoints: blocklist management, flag review
- 89 new tests

### OAuth2 Google Login (v1.4.0)
- PKCE flow (S256 only, no plain)
- State parameter CSRF protection
- Account merge: links Google to existing email
- email_verified enforcement (prevents account takeover)
- 50 new tests

### Bulk Task Operations (v1.5.0)
- POST /tasks/bulk-create (max 50)
- PATCH /tasks/bulk-update (max 50)
- DELETE /tasks/bulk-delete (max 50)
- Partial success: { succeeded[], failed[] }
- Rate limiting: each task counts as 1 request
- 60 new tests

### Immutable Audit Log (v1.6.0)
- Tracks 20 event types across auth/tasks/urls/admin
- PostgreSQL trigger enforces append-only at DB level
- Admin-only query API with filtering and pagination
- Non-blocking: audit failure never breaks main operation
- 58 new tests

---

## 🏗️ Architecture

### Project Structure

```
src/
├── auth/          # JWT auth, refresh token rotation + reuse detection, OAuth2 (PKCE)
├── tasks/         # Task CRUD, assignment, filtering, bulk ops, ownership policy
├── urls/          # URL shortener, SSRF validation, abuse prevention, click tracking
├── admin/         # Blocklist management, flag review, role administration
├── audit/         # Immutable append-only audit log (routes, service, repository)
├── ws/            # WebSocket real-time task updates (JWT auth, IDOR-proof)
├── users/         # User profile reads
└── shared/        # Errors, JWT utils, logger, validation, audit, url-safety, result
```

Each feature module is a vertical slice with the same internal layers:

```
*.routes.ts   → HTTP binding, Zod parse, auth guard      (no business logic, no Prisma)
*.service.ts  → business rules + authorization            (no HTTP types, no Prisma)
*.policy.ts   → object-level authorization (owner/assignee)
*.repository.ts → the ONLY code that touches the Prisma client
```

### Design Principles
- **Clean architecture** — strict route → service → repository separation (ADR-010)
- **Business logic in the service layer, never in controllers**
- **Dependency injection** throughout (repositories injected into services, services into routes)
- **Every public function documented** with JSDoc (`@param` / `@returns` / `@throws`)
- **No magic numbers** — all constants named (`CODE_LENGTH`, `MAX_URL_LENGTH`, `DNS_TIMEOUT_MS`, …)

### Architecture Decisions (ADRs)

This project documents **49 architecture decisions** in [`context/decisions.md`](context/decisions.md). Each records the context, the decision, the alternatives, and the trade-off. The table below lists the foundational decisions (ADR-001…024); later ADRs (025–049) cover WebSocket auth, abuse prevention, OAuth2/PKCE, bulk-operation rate weighting, the repository Result pattern, and audit-log immutability.

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
- **STRIDE threat modeling** applied to every feature before implementation
- **OWASP Top 10** checked for every endpoint

### Authentication
- JWT **HS256 with a pinned algorithm** — forged `alg:none` tokens are rejected
- **Refresh-token rotation** with `family` / `jti` **reuse detection** (replay revokes the family)
- Refresh tokens delivered as **httpOnly, Secure, SameSite=Strict cookies** (XSS-resistant)
- **32-byte minimum secret** enforced from the environment at startup (the process refuses to boot otherwise)

### Authorization
- **IDOR prevention** — resource ownership verified on every read/update/delete
- **`404` instead of `403`** for unauthorized resources (prevents enumeration)
- Owner/assignee scope checked at the policy layer (`tasks.policy.ts`, `urls.policy.ts`)

### SSRF Prevention (URL Shortener)
Implemented in [`src/shared/url-safety.ts`](src/shared/url-safety.ts), validated at **write time** before a URL is ever stored:

- **Blocks IPv4:** `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8` (loopback), `169.254.0.0/16` (link-local incl. `169.254.169.254` metadata), `172.16.0.0/12`, `192.168.0.0/16`, `255.255.255.255`
- **Blocks IPv6:** loopback (`::1`), unspecified (`::`), link-local (`fe80::/10`), unique-local (`fc00::/7`)
- **Blocks IPv4-mapped IPv6** (`::ffff:x.x.x.x`) in **both** dotted-decimal **and** compressed-hex form (`::ffff:7f00:1`) — caught as a real bypass during QA review and closed with a reject matrix
- **Scheme/port allowlist:** only `http`/`https`, only ports 80/443, no embedded credentials, 2048-byte cap
- **Encoding-proof:** decimal/hex/octal IPv4 literals (e.g. `http://2130706433/`) are normalized before the range check
- **Fail-closed:** DNS resolution failure or 3s timeout rejects the request

### Rate Limiting
- Auth endpoints: **5 requests / 15 min per IP** (brute-force prevention)
- URL shortening: **10 requests / min per IP**
- Global authenticated default: **100 requests / min per IP**
- **Generic error messages** on auth failure (no account enumeration)

### Input Validation
- **Zod** schemas on every endpoint, `.strict()` to reject unknown keys
- **URL validation:** structure + SSRF range-check before storage
- **SQL injection:** prevented by Prisma parameterized queries (no raw string SQL)

### Real Vulnerabilities Caught During Development

| Feature | Finding | Severity | Resolution |
|---------|---------|---------|------------|
| URL Shortener | IPv4-mapped IPv6 SSRF bypass (`::ffff:7f00:1` hex form) | HIGH | Dual-form validation, fail-closed |
| OAuth2 | Email-merge account takeover (unverified email) | CRITICAL | `email_verified===true` enforced |
| OAuth2 | PKCE downgrade attack | HIGH | S256 mandatory, plain rejected |
| OAuth2 | Callback CSRF via weak state | HIGH | Single-use signed state cookie |
| WebSocket | IDOR subscription bypass | HIGH | `canAccessTask` predicate on every publish |
| Bulk Operations | `z.intersection` strict rejection | P1 | `extend().refine()` pattern |
| Audit Log | Client-controlled `actor_id` | HIGH | Server-derived identity only |

---

## ✅ Testing

### Results

| Metric | Result |
|--------|--------|
| Total tests | 616 passing |
| Line coverage | 99.38% |
| Branch coverage | 97.5% |
| TypeScript build | ✅ exit 0 |
| Security gate | ✅ STRIDE + OWASP |
| Quality baseline | ✅ v1.4.0 |

### Test Strategy
- **Unit tests** — pure functions and services, isolated, fast
- **Integration tests** — full HTTP request/response cycle against an in-memory Prisma stand-in (`src/test/fake-prisma.ts`) so CI needs no live database
- **Schema validation** tested with both valid and invalid inputs
- **Security tests** — SSRF bypass matrix, auth edge cases, rate-limit behavior, refresh-token reuse detection

### Running Tests

```bash
npm test                    # run all tests
npm run test:coverage       # with coverage report
npm test -- src/auth/       # a specific module
```

---

## 🧹 Code Quality

### Standards Enforced
- Functions: max ~15 lines average, 40-line hard limit
- Cyclomatic complexity: flagged above 10, refactor required
- No magic numbers: all constants named and documented
- No dead code: unused imports, functions, branches removed
- Comments explain WHY, not WHAT
- Every public function has JSDoc

### What Gets Rejected
- Business logic in controllers (must be in service layer)
- God classes or files over 200 lines without clear justification
- Copy-paste duplication (DRY enforced)
- Speculative abstractions (YAGNI enforced)
- Wrapper functions that add no value
- Obvious comments ("// increment counter")

### Review Gate
Every implementation goes through a dedicated code-quality agent review before quality-lead approval. The gate checks:
- Cyclomatic complexity per function
- Duplication ratio
- Naming quality (variables, functions, classes)
- Abstraction level consistency
- AI-generated bloat patterns

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
- **agentmemory MCP** — lifecycle hooks persist and recall compressed, per-agent context across sessions
- **`context/brief.md`** — shared scratchpad holding handoff state between agents
- **`context/decisions.md`** — the permanent ADR store (49 records)
- **`context/patterns.md`** — reusable patterns discovered during development (47+ entries)

### Token Efficiency
- Only the relevant compressed context is injected per agent, instead of loading the full `CLAUDE.md` every time
- The shared scratchpad prevents re-transmitting context between agents
- Each agent reads only the `decisions.md` sections relevant to its domain
- Net effect: agents keep full project context without loading every file

### Recent Improvements (v2.1)

**GEL-1: Hierarchy Enforcement**
- Delegation matrix: only orchestrator spawns agents
- Structured receipt protocol: every agent writes `AGENT/STATUS/TIER/KEY_DECISIONS/RECOMMENDED_NEXT`
- Hierarchy Execution Log in brief.md
- Session limit CHECKPOINT mechanism

**GEL-2: Memory Integration**
- agentmemory worker crash guard (watchdog + scheduled task)
- Domain-specific recall queries per agent (4 queries each)
- SubagentStart/SubagentStop hooks verified end-to-end
- Cross-session learning: agents recall previous findings

**GEL-3: Security Gate**
- Mandatory security trigger matrix (auth/data/network/infra keywords)
- Differential risk classification (HIGH/MEDIUM/LOW/SKIP per file)
- Backend-dev pre-implementation security checklist
- quality-lead blocks SHIP IT if security gate not completed
- Structured SECURITY_PATTERN memory format

**GEL-4: Context Budget (~91% token reduction)**
- Section tagging: `<!-- agent: X -->` and `<!-- domain: X -->`
- Each agent reads only relevant sections of brief.md
- decisions.md filtered by domain tags
- Measured: backend-dev reads 4-10% of brief.md

**GEL-5: Quality Baseline**
- `.quality-baseline.json`: complexity metrics, coverage thresholds
- Baseline comparison on every review (complexity delta tracking)
- `check-slop.ps1`: automated AI slop detection (7 patterns)
- Baseline version increments on each major feature

---

## 🔧 Agent System Performance

### Token Efficiency (measured)
| Agent | Brief.md read | Total lines | Savings |
|-------|--------------|-------------|---------|
| backend-dev | ~210-690 lines | 4,774-6,547 | ~91% |
| qa-engineer | ~370 lines | ~4,930 | ~92% |
| db-engineer | 4 ADRs read | 49 total ADRs | ~92% |
| All agents | domain sections only | full file | ~91% avg |

### Memory System (verified)
- 48+ memories across sessions
- Cross-session recall verified: SSRF bypass finding recalled in subsequent feature (abuse prevention)
- SubagentStart/SubagentStop hooks: end-to-end verified
- Worker crash guard: watchdog script + Windows scheduled task

### Quality Gates (6 features, 0 bypassed)
| Feature | Security | Code Quality | Coverage | Ship |
|---------|---------|-------------|---------|------|
| WebSocket | ✅ | ✅ CLEAN | 98.46% | ✅ |
| Abuse Prevention | ✅ | ✅ CLEAN | 99.2% | ✅ |
| OAuth2 | ✅ | ✅ CLEAN | 99.28% | ✅ |
| Bulk Operations | ✅ | ✅ CLEAN | ~100% | ✅ |
| Result Refactor | ✅ | ✅ CLEAN | 97.35% | ✅ |
| Audit Log | ✅ | ✅ CLEAN | 99.38% | ✅ |

### Build Stats
| Stat | Value |
|------|-------|
| Agent invocations | 60+ (across 6 major features) |
| Security findings caught | 10+ (4 Critical/High pre-ship) |
| Patterns learned | 47+ |
| ADRs written | 49 |
| Lines of code | ~18,000 |
| Test files | 48 |
| Quality baseline version | v1.4.0 |

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

> Need a database fast? `docker run --name taskdb -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=agentcorp -p 5432:5432 -d postgres:16-alpine`

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
| `POST` | `/tasks/bulk-create` | Bearer | Global (N-weighted) | Create up to 50 tasks; partial-success result. |
| `PATCH` | `/tasks/bulk-update` | Bearer | Global (N-weighted) | Update up to 50 tasks; partial-success result. |
| `DELETE` | `/tasks/bulk-delete` | Bearer | Global (N-weighted) | Delete up to 50 tasks (owner-only per item); partial-success result. |
| `GET` | `/users/me` | Bearer | Global | Authenticated user's profile. |
| `GET` | `/audit-logs` | Bearer (admin) | Global | List audit entries (filter by event_type/actor_id/target_id/date range; newest first, max 100/page). |
| `POST` | `/shorten` | Bearer | 10 / min | Create a 6-char short code. |
| `GET` | `/:code` | None | Global | Resolve a code; `302` redirect. |
| `GET` | `/:code/stats` | Bearer | Global | Click analytics (owner only). |
| `DELETE` | `/:code` | Bearer | Global | Delete a short code (owner only). |
| `GET` | `/health` | None | Global | Liveness probe. |

> Global default rate limit is **100 requests / min per IP**. The bulk task endpoints share this budget but are **weighted by batch size** — an N-item batch costs N units (ADR-042/043). Full schemas, error tables, and more examples are in [`docs/api.md`](docs/api.md).

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

**Bulk-create tasks (up to 50):**
```bash
curl -X POST http://localhost:3000/tasks/bulk-create \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"title":"First"},{"title":"Second","priority":"HIGH"}]}'
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

### [1.6.0] — 2026-06-11
- **Added:** Immutable audit log — `GET /audit-logs` (admin-only, filterable, paginated); tracks 20 event types across auth/tasks/urls/admin; non-blocking fire-and-forget emit.
- **Security:** append-only enforced at the DB level via a PostgreSQL `BEFORE UPDATE OR DELETE` trigger; no cascade delete from users; server-derived `actor_id` (no client control).

### [1.5.0] — 2026-06-11
- **Added:** Bulk task operations — `POST /tasks/bulk-create`, `PATCH /tasks/bulk-update`, `DELETE /tasks/bulk-delete` (max 50 each); per-item partial-success results with no rollback.
- **Security:** per-item authorization reuse; batch-size-weighted rate limiting (N-item batch costs N units).

### [1.4.0] — 2026-06-10
- **Added:** OAuth2 Google login — PKCE (S256) flow, account merge to existing email.
- **Security:** `email_verified` enforcement (account-takeover prevention), single-use signed state cookie (callback CSRF), plain-PKCE rejected.

### [1.3.0] — 2026-06-09
- **Added:** URL shortener abuse prevention — domain blocklist, homograph/typosquatting detection, 100 URLs/day quota, confidence-score flagging, admin blocklist/flag-review endpoints.

### [1.2.0] — 2026-06-09
- **Added:** WebSocket real-time task updates — JWT auth on connection, IDOR-proof subscriptions, max 10 concurrent connections per user.

### [1.1.0] — 2026-06-09
- **Added:** URL shortener — `POST /shorten`, `GET /:code` (302), `GET /:code/stats`, `DELETE /:code`; 6-char CSPRNG codes; click analytics; 10/min shorten rate limit.
- **Security:** SSRF-hardened URL validation (scheme/port allowlist, private/metadata/IPv4-mapped-IPv6 blocking, fail-closed DNS); owner-only stats/delete (404-not-403); 302 + `no-store` redirects.

### [1.0.0] — 2026-06-09
- **Added:** Task Management API — registration/login, JWT sessions with refresh-token rotation, task CRUD + assignment, status/priority filtering, pagination; 10 endpoints.
- **Security:** object-level authorization (no IDOR), refresh-token reuse detection, generic auth errors, bcrypt + HS256-pinned JWT + helmet + CORS + audit logging.
