# AgentCorp v2 — Operating System

This file is loaded at the start of every Claude Code session. It defines how AgentCorp v2 operates: how tasks are routed, how context is shared, how quality is enforced, and what principles govern all work.

---

## Agent Routing Table

| Agent ID | When to call | Cost Tier |
|---|---|---|
| `orchestrator` | First call for any new feature, bug, refactor, or project. Decomposes the goal and sequences the other agents. | 5 (Opus high) |
| `tech-lead` | Technology stack decisions, build system setup, dependency choices, resolving technical conflicts between specialists. NOT for implementation. | 4 (Opus medium) |
| `ai-lead` | AI/ML strategy, model selection, RAG architecture, agent design, prompt engineering strategy, inference infrastructure. | 4 (Opus medium) |
| `quality-lead` | After any implementation: defines test strategy, sets quality gates, issues the final ship-it or fix-it verdict. | 4 (Opus medium) |
| `data-lead` | Database design, data modeling, schema decisions, data pipeline architecture, storage strategy. | 4 (Sonnet medium) |
| `frontend-lead` | UI architecture, component hierarchy, state management strategy, design system, performance budgets. | 4 (Sonnet medium) |
| `architect` | System design, component boundaries, integration patterns, scalability planning, ADR authorship. | 3 (Sonnet high) |
| `backend-dev` | API implementation, business logic, auth systems, REST/GraphQL endpoints. | 3 (Sonnet medium) |
| `frontend-dev` | React/Vue/Next.js component implementation, UI features, API integration. | 3 (Sonnet medium) |
| `mobile-dev` | React Native, iOS (Swift), Android (Kotlin) implementation and platform-specific features. | 3 (Sonnet medium) |
| `security-engineer` | Security review for any feature touching auth, data, external APIs, or user input. Call proactively. | 3 (Sonnet medium) |
| `qa-engineer` | Writing unit, integration, and E2E tests per quality-lead's strategy. | 3 (Sonnet medium) |
| `ml-engineer` | Model training, fine-tuning, evaluation pipeline, inference optimization. | 3 (Sonnet medium) |
| `prompt-engineer` | System prompt design, few-shot selection, prompt versioning, eval design. | 3 (Sonnet medium) |
| `code-quality` | Post-implementation review: complexity, duplication, naming, dead code, AI slop detection. | 3 (Sonnet medium) |
| `db-engineer` | Schema migrations, index design, query optimization, connection pooling, backup configuration. | 3 (Sonnet medium) |
| `data-engineer` | ETL pipelines, data quality checks, batch/streaming jobs, pipeline monitoring. | 3 (Sonnet medium) |
| `devops` | CI/CD pipelines, Docker, infrastructure-as-code, deployment strategy, monitoring. | 3 (Sonnet medium) |
| `maintainability` | Dependency health, major version debt, technical debt inventory, upgrade roadmap. | 3 (Sonnet medium) |
| `tech-writer` | API docs, README, finalized ADRs, runbooks, setup guides, changelogs. | 3 (Sonnet low) |

---

## Handoff Protocol

Context does not live in agent memory alone — it lives in `brief.md`. Every agent reads it before starting and writes to it after finishing.

### Context Files

| File | Purpose |
|---|---|
| `C:\Users\Ferzan Bilek\agentcorp-v2\context\brief.md` | Active task state, goal, agent outputs, handoff status |
| `C:\Users\Ferzan Bilek\agentcorp-v2\context\decisions.md` | All architectural and technical decisions (ADRs) |
| `C:\Users\Ferzan Bilek\agentcorp-v2\context\patterns.md` | Reusable patterns discovered during work |

### BEFORE YOU START (every agent, every time)

```
1. Run: recall relevant context from agentmemory
2. Read: C:\Users\Ferzan Bilek\agentcorp-v2\context\brief.md
3. Read: C:\Users\Ferzan Bilek\agentcorp-v2\context\decisions.md
   (only sections relevant to your domain)
```

### AFTER YOU FINISH (every agent, every time)

```
1. Update: C:\Users\Ferzan Bilek\agentcorp-v2\context\brief.md
   — Add output summary under "## {AgentName} Output"
   — Include: what you did, key decisions, blockers, next recommended agent
2. If architectural decision made → append to decisions.md
3. If reusable pattern found → append to patterns.md
4. Run: remember key findings to agentmemory
5. Report: DONE | BLOCKED | NEEDS_REVIEW
```

---

## Cost Tier Table

> Note: "Cost Tier" here governs model/effort selection only. It is unrelated
> to the "Hierarchy Level" used in the Hierarchy & Delegation Rules section
> below (orchestrator / domain leads / specialists) — the two numbering
> schemes overlap in name but not in meaning. Do not read a "Tier N" figure
> in one table as applying to the other.

| Cost Tier | Cost | Model | Effort | Agents |
|---|---|---|---|---|
| Cost Tier 1 | $0 | None | None | Deterministic bash/sed operations — no LLM call |
| Cost Tier 2 | Lowest | Sonnet low | low | tech-writer (documentation) |
| Cost Tier 3 | Medium | Sonnet medium | medium | backend-dev, frontend-dev, mobile-dev, devops, ml-engineer, prompt-engineer, security-engineer, qa-engineer, code-quality, db-engineer, data-engineer, data-lead, frontend-lead |
| Cost Tier 4 | High | Opus medium | medium | tech-lead, ai-lead, quality-lead |
| Cost Tier 5 | Highest | Opus high | high | orchestrator only |

**Rule**: Always use the lowest cost tier that can do the job correctly. Escalate to a higher cost tier only when judgment or synthesis across complex tradeoffs is required.

---

## Quality Gates

No code is merged without passing all applicable gates:

### Gate 1 — Security (required for auth, data, external APIs, user input)
- `security-engineer` must produce a Security Assessment Report
- No Critical or High findings open at time of merge
- Threat model reviewed for the feature

### Gate 2 — Code Quality (required for all implementation)
- `code-quality` must produce a Code Quality Report
- No P1 (cyclomatic complexity > 15, baseline-aligned) blockers open
- No AI slop patterns unresolved

### Gate 3 — Test Coverage (required for all implementation)
- `qa-engineer` must produce a Test Summary with coverage results
- These are DEFAULT minimums, used only when a project's own CLAUDE.md
  does not define its own coverage thresholds. A project-local CLAUDE.md
  is authoritative and overrides these numbers per the standard
  instruction-priority rule (project instructions > this global file).
- Line coverage ≥ 80% (default)
- Branch coverage ≥ 70% (default)
- No flaky tests in the suite

### Gate 4 — Final Approval (required before merge)
- `quality-lead` must issue explicit **SHIP IT** decision
- All gate items from Gates 1-3 resolved
- Quality-lead's fix list is empty or deferred with justification

---

## Core Principles

### 1. Every decision gets a rationale
Architectural decisions live in `decisions.md` as ADRs. Technical choices in code get a comment if the reason is non-obvious. "We chose X" without "because Y" is not acceptable.

### 2. Done means verifiably done
"Done" = tests pass + coverage met + quality review passed + security cleared. A feature that works but has no tests is not done. A feature that passes tests but has Critical security findings is not done.

### 3. Vibe-coded slop is rejected
Every line of code has a purpose. Speculative abstractions, unnecessary wrappers, copy-pasted blocks, and dead code are removed before merge. The code-quality agent exists to catch this.

### 4. Complexity budget is real
Simpler solutions are preferred. Before adding a new abstraction, ask: "Does this pay for its complexity?" Cyclomatic complexity > 15 per function is a hard limit (baseline-aligned; QD-E4-CC01 grandfathered), not a suggestion.

### 5. Security is not the last step
`security-engineer` is called proactively for new features, before implementation, not after. Threat models are written before code is written.

### 6. Context travels through brief.md
Agents do not pass context telepathically. The brief.md is the source of truth for what is happening, what has been decided, and what comes next. If it is not in brief.md, it does not exist.

### 7. Infrastructure is code
No manual configuration in any environment. No secrets in code, config files, or logs. Every environment is reproducible from version-controlled files.

---

## Standard Agent Call Patterns

### New Feature
```
orchestrator → architect → tech-lead → security-engineer (threat model)
→ [backend-dev ‖ frontend-dev ‖ mobile-dev] (parallel)
→ qa-engineer → code-quality → quality-lead → tech-writer
```

### Bug Fix
```
orchestrator → [backend-dev | frontend-dev] → qa-engineer → code-quality → quality-lead
```

### New AI/ML Feature
```
orchestrator → ai-lead → [ml-engineer ‖ prompt-engineer] (parallel) → qa-engineer → quality-lead
```

### Database Change
```
orchestrator → data-lead → db-engineer → qa-engineer → quality-lead
```

### Infrastructure Change
```
orchestrator → devops → tech-lead → security-engineer → quality-lead
```

### Maintenance Sprint
```
orchestrator → maintainability → tech-lead → [upgrade PRs via backend-dev | devops] → qa-engineer
```

---

## Security Gate Rules

### Mandatory Security Review Triggers
security-engineer MUST be called when ANY of these
appear in the task description or affected files:

AUTHENTICATION & AUTHORIZATION:
  auth, authentication, authorization, login, logout,
  register, password, credential, session, token,
  jwt, oauth, cookie, permission, role, admin,
  access control, privilege

DATA & PRIVACY:
  user data, personal data, pii, email, phone,
  payment, credit card, encrypt, decrypt, hash,
  database write, delete user, export data

NETWORK & INPUT:
  url, redirect, fetch, http, external api,
  webhook, upload, file, path, directory,
  sql, query, search, filter, input validation

INFRASTRUCTURE:
  env, environment variable, secret, key, config,
  docker, deployment, cors, header, middleware

DEPENDENCY:
  npm install, package.json, new dependency,
  upgrade, update package

CATCH-ALL:
  any change to: src/auth/*, src/shared/jwt*,
  src/shared/csrf*, *.policy.ts, middleware

### When Security Review is NOT Required
  - Documentation-only changes (*.md files)
  - Test file changes that don't add new test patterns
  - CSS/styling changes with no logic
  - Rename/refactor with zero logic change
    (must be confirmed by orchestrator)

### Security Review Position in Workflow
  ALWAYS before implementation (backend-dev, frontend-dev)
  ALWAYS after architecture decisions (architect, tech-lead)
  Re-run after: any P1 fix from code-quality or qa-engineer
    that touches auth, validation, or data access

### Security Escalation Levels
  CRITICAL finding → BLOCKED (nothing ships)
  HIGH finding → FIX IT (backend-dev fixes, re-review)
  MEDIUM finding → document + ship with mitigation plan
  LOW finding → log to agentmemory + patterns.md

---
## Hierarchy & Delegation Rules

### Hierarchy Level Definitions

> Note: "Hierarchy Level" governs delegation/calling authority only. It is
> unrelated to the "Cost Tier" used in the Cost Tier Table above (model/effort
> selection) — the two numbering schemes overlap in name but not in meaning.
> When an agent's receipt reports a level, it refers to this hierarchy, not
> the cost tier.

Level 1 — Orchestrator:
  orchestrator
  Can call: any agent
  Cannot be called by: any agent (only by user)

Level 2 — Domain Leads:
  tech-lead, ai-lead, quality-lead, data-lead, frontend-lead
  Can call: nobody (leads do not spawn subagents)
  Can receive work from: orchestrator only
  Can recommend: specialist agents via brief.md

Level 3 — Specialists:
  backend-dev, frontend-dev, mobile-dev, devops,
  ml-engineer, prompt-engineer, qa-engineer,
  security-engineer, architect, code-quality,
  db-engineer, data-engineer, maintainability, tech-writer
  Can call: nobody
  Can receive work from: orchestrator only

### Delegation Rules
1. ONLY orchestrator spawns agents. No agent spawns another.
2. Leads communicate with specialists ONLY via brief.md —
   never by direct invocation.
3. A lead wanting specialist work writes to brief.md:
   "RECOMMENDED NEXT: {specialist} — {reason}"
   Orchestrator reads this and decides whether to invoke.
4. Specialists report status to orchestrator only:
   DONE / BLOCKED / NEEDS_REVIEW
5. No agent may claim to be orchestrator or assume
   orchestration duties if session limit is hit —
   write CHECKPOINT and stop.

### Parallel Execution Rules
Safe to run in parallel (no file conflicts):
  security-engineer ‖ data-lead
  security-engineer ‖ architect
  qa-engineer ‖ code-quality
  tech-writer ‖ maintainability
  ml-engineer ‖ prompt-engineer

Never run in parallel (shared file risk):
  Any two agents that write to the same src/ files
  db-engineer + backend-dev (schema must exist first)
  quality-lead + any implementation agent

### Quality Gate Sequence (non-negotiable)
Every feature MUST follow this order:
  1. Design phase: architect / tech-lead / security-engineer / data-lead
  2. Implementation: backend-dev / frontend-dev / mobile-dev / devops
  3. Review phase: qa-engineer ‖ code-quality (parallel)
  4. Gate: quality-lead (SHIP IT required)
  5. Docs: tech-writer / maintainability

Skipping any step requires explicit user approval.
"We're in a hurry" is not approval.

---
## Brief.md Health

Maximum healthy size: 3000 lines.
Orchestrator checks this at the start of every invocation and auto-rotates
if exceeded (see scripts/rotate-brief.ps1). A .bak copy is written before
any live rotation because context/ is often not git-tracked.

Archived phases live in context/archive/, indexed in context/archive/INDEX.md.
The rotation regex assumes '## Orchestrator Output — ...' phase headers;
verify with -DryRun before first live use in any project whose brief uses
a different header format.

---
## Quality Baseline

Baseline file: agentcorp-v2/.quality-baseline.json
Updated by: code-quality agent after each major feature

### Degradation Rules
Any of these = automatic P1 finding:
- New code coverage drops below the project's own Gate 3 threshold
  (per that project's CLAUDE.md; fall back to this file's Gate 3
  defaults — 80% line / 70% branch — only if the project defines none).
  Do NOT use a separate hardcoded 90%/85% here — that duplicates Gate 3
  with a different number and is a common source of contradictory
  P1 findings (e.g. code-quality flagging a drop below 90% on a project
  whose own CLAUDE.md sets and passes its gate at a different value).
- File complexity increases >50% vs baseline
- Overall project coverage drops vs baseline

### Baseline Update Trigger
code-quality agent updates .quality-baseline.json when:
- A new module is added (add new file entries)
- Overall coverage improves (update coverage numbers)
- Debt is resolved (remove from known_debt array)
- New conscious debt accepted (add to known_debt)

Update format: increment version field (1.1.0 → 1.2.0)
and update last_updated field.

---
## Context Budget

### brief.md Reading Rules
Orchestrator: read full file (needs complete picture)
Tech-writer: read full file (needs complete picture)
All other agents: read ONLY sections tagged with your
  agent name OR your domain tags (see table below)

If section tags are missing from brief.md:
  → Read only the last 100 lines (most recent context)
  → Do NOT read the full file

### Agent Domain Tags
| Agent | Read these tags |
|-------|----------------|
| orchestrator | all |
| security-engineer | <!-- agent: security-engineer -->, <!-- domain: security -->, <!-- domain: architecture --> |
| code-quality | <!-- agent: code-quality -->, <!-- domain: quality -->, <!-- domain: backend --> |
| architect | <!-- agent: architect -->, <!-- domain: architecture -->, <!-- agent: orchestrator --> |
| tech-lead | <!-- agent: tech-lead -->, <!-- domain: architecture -->, <!-- domain: backend -->, <!-- domain: infrastructure --> |
| ai-lead | <!-- agent: ai-lead -->, <!-- domain: backend -->, <!-- domain: architecture --> |
| quality-lead | <!-- agent: quality-lead -->, <!-- domain: quality -->, <!-- domain: security -->, <!-- domain: backend --> |
| data-lead | <!-- agent: data-lead -->, <!-- domain: data -->, <!-- domain: architecture --> |
| frontend-lead | <!-- agent: frontend-lead -->, <!-- domain: frontend -->, <!-- domain: architecture --> |
| backend-dev | <!-- agent: backend-dev -->, <!-- domain: backend -->, <!-- domain: security -->, <!-- domain: data --> |
| frontend-dev | <!-- agent: frontend-dev -->, <!-- domain: frontend -->, <!-- domain: backend --> |
| mobile-dev | <!-- agent: mobile-dev -->, <!-- domain: frontend --> |
| devops | <!-- agent: devops -->, <!-- domain: infrastructure -->, <!-- domain: backend --> |
| ml-engineer | <!-- agent: ml-engineer -->, <!-- domain: backend -->, <!-- domain: data --> |
| prompt-engineer | <!-- agent: prompt-engineer -->, <!-- domain: backend --> |
| qa-engineer | <!-- agent: qa-engineer -->, <!-- domain: quality -->, <!-- domain: backend -->, <!-- domain: security --> |
| db-engineer | <!-- agent: db-engineer -->, <!-- domain: data -->, <!-- domain: backend --> |
| data-engineer | <!-- agent: data-engineer -->, <!-- domain: data -->, <!-- domain: infrastructure --> |
| maintainability | <!-- agent: maintainability -->, <!-- domain: infrastructure -->, <!-- domain: backend -->, <!-- domain: data --> |
| tech-writer | all |

### decisions.md Reading Rules
Read ONLY ADRs tagged with your domain(s).
Exception: orchestrator and architect read all ADRs.

### patterns.md Reading Rules
Read ONLY patterns tagged with your agent name.
Exception: orchestrator reads all patterns.

### Fallback Rule
If tags are missing or file is untagged:
  → Read last 100 lines of brief.md
  → Read full decisions.md (small file, acceptable)
  → Read full patterns.md (small file, acceptable)
