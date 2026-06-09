# AgentCorp v2 🤖

> **Production-ready REST API built by a 20-agent AI system**

![Tests](https://img.shields.io/badge/tests-197%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-98%25%20lines-brightgreen)
![Branch](https://img.shields.io/badge/branch-95%25-brightgreen)
![Build](https://img.shields.io/badge/build-tsc%20exit%200-brightgreen)
![Node](https://img.shields.io/badge/Node.js-22%20LTS-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)
![Built by](https://img.shields.io/badge/built%20by-20%20AI%20agents-8957e5)

---

## ✨ What Makes This Different

This codebase was **built entirely by an orchestrated multi-agent AI system** (AgentCorp v2), not written by a human developer directly. Every line was produced by one of **20 specialized agents** working through a **3-tier hierarchy** — an orchestrator routes work to domain leads, who direct specialists. Context survives across sessions through a shared scratchpad and **persistent agentmemory**, and nothing merges without passing **real quality gates** (security, code-quality, tests, and a final quality-lead sign-off). The result is two shipped, tested API features with 24 recorded architecture decisions.

## 🏗️ Agent System

A request flows top-down through three tiers, and results flow back up to be synthesized:

- **Orchestrator** (Tier 5) — decomposes the goal, sequences agents, never writes code.
- **Domain Leads** (Tier 4) — `tech-lead`, `ai-lead`, `quality-lead`, `data-lead`, `frontend-lead` make architecture/strategy calls.
- **Specialists** (Tier 3) — 14 implementers/reviewers, each with a narrow expertise.
- **Handoff** — agents pass context through a shared `context/brief.md` scratchpad (read before starting, append after finishing).
- **Memory** — an `agentmemory` MCP server persists findings across sessions; agents recall prior decisions before each task.
- **Quality gates** — no code ships without `security-engineer` + `code-quality` + `qa-engineer` + `quality-lead` approval.

```
                          Orchestrator  (Tier 5)
                                │
        ┌───────────────┬───────┴───────┬───────────────┐
   tech-lead       ai-lead        quality-lead     data-lead / frontend-lead   (Tier 4 — leads)
        │
        ▼
  architect · backend-dev · security-engineer · qa-engineer · code-quality
  db-engineer · data-engineer · frontend-dev · mobile-dev · devops
  ml-engineer · prompt-engineer · maintainability · tech-writer            (Tier 3 — specialists)
```

## 🧠 Memory & Learning

| Store | What it holds | Current size |
|---|---|---|
| `agentmemory` (MCP) | Structured findings, recalled across sessions | **23 records** |
| `context/patterns.md` | Reusable patterns discovered during development | **19 patterns** |
| `context/brief.md` | Full handoff history — every agent's output | **1,322 lines, 33 sections** |
| `context/decisions.md` | Architecture Decision Records | **24 ADRs** |

Agents run a recall step before starting and a remember step after finishing, so a decision made in one session (e.g. "redirect uses 302, not 301") is available to the next.

## 🔒 Security First

- **Threat-modeled by default** — every feature begins with a STRIDE threat model and an OWASP Top 10 pass per endpoint, authored by `security-engineer` *before* implementation.
- **A real vulnerability was caught and fixed during development:** an **IPv4-mapped IPv6 SSRF bypass** — `http://[::ffff:127.0.0.1]/` is canonicalized by the URL parser to the hex form `::ffff:7f00:1`, which the original blocklist missed. QA found it, `backend-dev` fixed it (derive the embedded IPv4 → run the existing private-range checks, fail closed), and QA pinned it shut with a reject matrix.
- **404-not-403** everywhere authorization fails, so resources can't be enumerated.
- **Gate enforced** — `security-engineer` approval is required before merge; the SSRF bypass blocked the merge until closed.

## ✅ Test Results

All numbers below are read from the actual suite and coverage report — not estimates.

| Metric | Result |
|---|---|
| Total tests | **197 passing** (13 files, 0 failing, 0 flaky) |
| Line coverage | **98.74%** |
| Branch coverage | **95.00%** |
| Type check / build | **`tsc --noEmit` exit 0** |
| URL shortener module | **100%** lines / branches / functions |

```bash
npm run test:coverage   # reproduce the numbers above
```

## 🚀 Features

### Task Management API (v1.0.0)

- User registration & login with **JWT access tokens + refresh-token rotation** (replaying a stolen refresh token revokes the whole family).
- Full **CRUD on tasks** with **assignee** support (assignees can view/update; owners control delete & reassign).
- **Filter** by status (`TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`) and priority (`LOW`, `MEDIUM`, `HIGH`, `URGENT`), with pagination.
- **Rate limiting** (5 auth requests / 15 min / IP), **CSRF protection** on the cookie refresh, bcrypt password hashing, helmet + strict CORS.

### URL Shortener (v1.1.0)

- `POST /shorten`, `GET /:code` (**302** redirect), `GET /:code/stats`, `DELETE /:code`.
- **SSRF prevention** — scheme/port allowlist + resolved-IP range checks blocking loopback, private (RFC1918), cloud-metadata, CGNAT, IPv6 ULA/link-local, and **IPv4-mapped IPv6**; DNS fails closed.
- **Anonymous redirect, authenticated management** — resolving a code needs no auth; creating/inspecting/deleting does.
- **Click tracking** — every resolution atomically increments the click count and records last-accessed time.

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
# Auth — register, then log in and capture the access token (needs jq)
curl -s -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Sup3rSecret","name":"Alice"}'
ACCESS_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Sup3rSecret"}' | jq -r .data.accessToken)

# Tasks — create one
curl -s -X POST http://localhost:3000/tasks -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{"title":"Ship the README","priority":"HIGH"}'

# URL shortener — shorten, then resolve (302)
curl -s -X POST http://localhost:3000/shorten -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" -d '{"url":"https://example.com/a/very/long/path"}'
curl -i http://localhost:3000/aZ3xK9      # -> 302 Found, Location: <original>, Cache-Control: no-store
```

## 🛠️ Tech Stack

| Technology | Role |
|---|---|
| **Node.js 22 LTS** | Runtime. |
| **TypeScript 5** (strict) | Language; full static typing across all layers. |
| **Fastify 4** | HTTP framework — schema-first routes, plugins, low overhead. |
| **Prisma 5** | Type-safe ORM + migrations; the only layer that touches the DB. |
| **PostgreSQL 16** | Relational data store (users, tasks, refresh tokens, short URLs). |
| **Zod** | Runtime input validation (`.strict()` to block mass-assignment). |
| **Vitest** | Test runner + V8 coverage. |

## ⚡ Quick Start

```bash
# Clone and install
git clone https://github.com/FerzanBerkenBilek/-agentcorp-v2.git
cd -agentcorp-v2
npm install

# Configure
cp .env.example .env
# Edit .env with your database URL and two JWT secrets (each >= 32 bytes)

# Database
npx prisma migrate deploy

# Run
npm run dev
```

The server starts on `http://localhost:3000`. Verify with `curl http://localhost:3000/health`.

> Need a database fast? `docker run --name taskdb -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=taskmanagement -p 5432:5432 -d postgres:16-alpine`

## 📋 Architecture Decisions

This project has **24 ADRs** documenting every non-obvious decision (see [`context/decisions.md`](context/decisions.md)). A few of the more interesting ones:

| ADR | Decision |
|---|---|
| **ADR-012** | Refresh-token rotation with **reuse detection** — replaying a consumed token revokes the entire family. |
| **ADR-013** | Object-level authorization returns **404, not 403**, on unauthorized access to prevent enumeration. |
| **ADR-019** | SSRF / open-redirect URL validation — scheme/port allowlist + resolved-IP range checks, fail-closed DNS. |
| **ADR-020** | Redirect uses **HTTP 302 + `no-store`, not 301** — keeps click tracking accurate and makes takedown immediate. |
| **ADR-022** | Short codes from a **CSPRNG over base62**, UNIQUE constraint + bounded insert-retry (not enumerable). |
| **ADR-010 / 011** | Strict 4-layer architecture (route → service → repository → Prisma) in vertical feature modules. |

## 📈 Development Log

- **Built across 2 major sessions** (the first orchestrator run hit a session limit mid-flight and resumed from the `brief.md` checkpoint).
- **34 agent invocations** across task management, a health endpoint, and the URL shortener feature.
- **4 findings caught and fixed before merge** — a rate-limit handler returning `500` instead of `429`, two missing security-audit signals (token-reuse + logout actor), and a real **IPv4-mapped IPv6 SSRF bypass**.
- **19 reusable patterns** learned and **23 memory records** persisted for future sessions.

---

*Generated and maintained by AgentCorp v2 — a 20-agent software development system running on Claude Code.*
