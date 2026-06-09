# AgentCorp v2 🤖

> Production-ready REST API built entirely by a 20-agent AI system

![Tests](https://img.shields.io/badge/tests-197%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-98.7%25%20lines-brightgreen)
![Branch](https://img.shields.io/badge/branch-95%25-brightgreen)
![Build](https://img.shields.io/badge/build-tsc%20exit%200-brightgreen)
![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933)
![Built by](https://img.shields.io/badge/built%20by-20%20AI%20agents-8957e5)

## ✨ What Makes This Different

This codebase was designed and built by **AgentCorp v2** — an orchestrated system of **20 specialized AI agents** with persistent memory, real security gates, and a 3-tier hierarchy. No human wrote the implementation directly: an orchestrator decomposed each goal, routed it to domain leads and specialists, and synthesized their results. Every architectural choice is recorded as an ADR, every feature passes a security threat model before code is written, and nothing merges without four independent quality gates. The output is two shipped, tested API features backed by 24 architecture decisions.

## 🏗️ Agent System Architecture

- **Orchestrator** decomposes the goal and sequences agents — it never writes code itself.
- **Domain leads** (Tier 4) make architecture/strategy calls; **specialists** (Tier 3) implement and review.
- **Handoff** happens through a shared `context/brief.md` scratchpad — each agent reads it before starting and appends its output after finishing.
- **Quality gates** block merges: `security-engineer` + `code-quality` + `qa-engineer` + `quality-lead` must all sign off.

```
Orchestrator
├── tech-lead ──→ backend-dev, devops, architect
├── ai-lead ──→ ml-engineer, prompt-engineer
├── quality-lead ──→ qa-engineer, code-quality, security-engineer
├── data-lead ──→ db-engineer, data-engineer
└── frontend-lead ──→ frontend-dev, mobile-dev
maintainability, tech-writer
```

### Setting Up the Agent System

**Prerequisites:**
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`)
- Required MCP servers (see below)

**Install agents:**
```bash
# Linux/macOS
bash .agents/install.sh

# Windows (PowerShell)
.\.agents\install.ps1
```

The installer copies the 20 agent definitions to `~/.claude/agents/`, the global `CLAUDE.md` to `~/.claude/`, and creates the `context/` scratchpad.

**Required MCP servers:**

| MCP | Purpose | Install |
|-----|---------|---------|
| agentmemory | Persistent memory across sessions — agents recall previous decisions, patterns, and context | `claude mcp add agentmemory` |
| (optional) vercel | Deployment automation | `claude mcp add vercel` |

> ⚠️ **agentmemory is required.** Without it, agents cannot recall previous session context. The system still works, but it loses memory between sessions.

**After installing MCPs, start using:**
```
claude
```
```
Use the orchestrator agent to handle this: [your task]
```

## 🧠 Memory & Learning

- **agentmemory MCP** — persists agent decisions across sessions; agents recall before each task. **23 records** from this project.
- **brief.md scratchpad** — the handoff log: **1,322 lines, 33 agent output sections** across all features.
- **patterns.md** — reusable patterns discovered during development: **19 patterns**.
- **decisions.md** — **24 ADRs**, every non-obvious decision documented.

## 🔒 Security First

- Every feature begins with a **STRIDE threat model** authored by `security-engineer` *before* implementation, plus an OWASP Top 10 pass per endpoint.
- **A real vulnerability was caught during development:** an **IPv4-mapped IPv6 SSRF bypass** — `http://[::ffff:127.0.0.1]/` is canonicalized by the URL parser to the hex form `::ffff:7f00:1`, which the original blocklist missed. Caught by `qa-engineer`, fixed by `backend-dev` (derive the embedded IPv4 → run the existing private-range checks, fail closed), verified by `quality-lead`.
- **404-not-403** on every authorization failure, so resources cannot be enumerated.
- `security-engineer` sign-off is required before any code ships — the SSRF bypass blocked the merge until it was closed.

## ✅ Test Results

| Metric | Result |
|--------|--------|
| Total tests | 197 passing (13 files, 0 flaky) |
| Line coverage | 98.74% |
| Branch coverage | 95.00% |
| TypeScript build | ✅ `tsc --noEmit` exit 0 |
| Security gate | ✅ STRIDE + OWASP |

```bash
npm run test:coverage   # reproduce the numbers above
```

## 🚀 Features

### Task Management API (v1.0.0)
- User registration & login (JWT + refresh-token rotation with reuse detection)
- Create, update, delete tasks with priority and status
- Assign tasks to other users (assignees can view/update)
- Filter by status and priority, with pagination
- Rate limiting, CSRF protection, audit logging

### URL Shortener (v1.1.0)
- `POST /shorten` — create short URL (auth required)
- `GET /:code` — redirect to original (anonymous, **302**)
- `GET /:code/stats` — click count, created date (owner only)
- `DELETE /:code` — remove short URL (owner only)
- SSRF prevention: blocks localhost, private IPs, IPv4-mapped IPv6
- Rate limited: 10 requests/minute per IP

## 📡 API Reference

All responses use a uniform envelope: `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code", "message", "details"? } }`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | None | Create an account; returns access token + refresh cookie. |
| `POST` | `/auth/login` | None | Authenticate; returns tokens. |
| `POST` | `/auth/refresh` | Refresh cookie | Rotate the refresh token, issue a new access token. |
| `POST` | `/auth/logout` | Refresh cookie | Revoke the refresh-token family. |
| `GET` | `/tasks` | Bearer | List owned/assigned tasks (filters + pagination). |
| `POST` | `/tasks` | Bearer | Create a task. |
| `GET` | `/tasks/:id` | Bearer | Read a task (owner or assignee). |
| `PATCH` | `/tasks/:id` | Bearer | Update a task (reassign is owner-only). |
| `DELETE` | `/tasks/:id` | Bearer | Delete a task (owner only). |
| `GET` | `/users/me` | Bearer | Authenticated user's profile. |
| `POST` | `/shorten` | Bearer | Create a 6-char short code (10/min/IP). |
| `GET` | `/:code` | None | Resolve a code; `302` redirect. |
| `GET` | `/:code/stats` | Bearer | Click analytics (owner only). |
| `DELETE` | `/:code` | Bearer | Delete a short code (owner only). |
| `GET` | `/health` | None | Liveness probe. |

Full schemas, error tables, and every `curl` example live in **[`docs/api.md`](docs/api.md)**.

```bash
# 1. Register, then log in and capture the access token (needs jq)
curl -s -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Sup3rSecret","name":"Alice"}'
ACCESS_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Sup3rSecret"}' | jq -r .data.accessToken)

# 2. Create a task
curl -s -X POST http://localhost:3000/tasks -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{"title":"Ship the README","priority":"HIGH"}'

# 3. Shorten a URL, then resolve it (302 redirect)
curl -s -X POST http://localhost:3000/shorten -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{"url":"https://example.com/a/very/long/path"}'
curl -i http://localhost:3000/aZ3xK9      # -> 302 Found, Location: <original>, Cache-Control: no-store
```

## 🛠️ Tech Stack

| Technology | Purpose |
|-----------|---------|
| Node.js + TypeScript | Runtime + type safety (strict mode) |
| Fastify | HTTP framework |
| Prisma | ORM + migrations |
| PostgreSQL | Primary database |
| Vitest | Test runner + coverage |
| Zod | Schema validation (`.strict()`) |
| JWT + bcrypt | Authentication |

## ⚡ Quick Start

```bash
git clone https://github.com/FerzanBerkenBilek/-agentcorp-v2.git
cd -agentcorp-v2
npm install
cp .env.example .env
# Edit .env: DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET
npx prisma migrate deploy
npm run dev
```

The server starts on `http://localhost:3000`. Verify with `curl http://localhost:3000/health`.

> Need a database fast? `docker run --name taskdb -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=taskmanagement -p 5432:5432 -d postgres:16-alpine`

## 📋 Key Architecture Decisions

**24 ADRs** document every non-obvious decision (see [`context/decisions.md`](context/decisions.md)). Six of the more interesting:

| ADR | Decision |
|---|---|
| **ADR-012** | Refresh-token rotation with **reuse detection** — replaying a consumed token revokes the entire family. |
| **ADR-013** | Object-level authorization returns **404, not 403**, to prevent resource enumeration. |
| **ADR-019** | SSRF / open-redirect URL validation — scheme/port allowlist + resolved-IP range checks, fail-closed DNS. |
| **ADR-020** | Redirect uses **HTTP 302 + `no-store`, not 301** — keeps click tracking accurate and makes takedown immediate. |
| **ADR-022** | Short codes from a **CSPRNG over base62**, UNIQUE constraint + bounded insert-retry (not enumerable). |
| **ADR-010 / 011** | Strict 4-layer architecture (route → service → repository → Prisma) in vertical feature modules. |

## 📈 Build Stats

| Stat | Value |
|------|-------|
| Agent invocations | 34 (across 2 major features) |
| Findings caught & fixed before merge | 4 (rate-limit status bug, 2 audit-signal gaps, SSRF bypass) |
| Patterns learned | 19 |
| ADRs written | 24 |
| Lines of TypeScript | ~5,960 (incl. tests; ~3,260 source) |
| Tests | 197 passing |

---

*Generated and maintained by AgentCorp v2 — a 20-agent software development system running on Claude Code.*
