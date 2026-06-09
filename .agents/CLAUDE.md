# AgentCorp v2 — Operating System

This file is loaded at the start of every Claude Code session. It defines how AgentCorp v2 operates: how tasks are routed, how context is shared, how quality is enforced, and what principles govern all work.

---

## Agent Routing Table

| Agent ID | When to call | Tier |
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

## Token Tier Table

| Tier | Cost | Model | Effort | Agents |
|---|---|---|---|---|
| Tier 1 | $0 | None | None | Deterministic bash/sed operations — no LLM call |
| Tier 2 | Lowest | Sonnet low | low | tech-writer (documentation) |
| Tier 3 | Medium | Sonnet medium | medium | backend-dev, frontend-dev, mobile-dev, devops, ml-engineer, prompt-engineer, security-engineer, qa-engineer, code-quality, db-engineer, data-engineer, data-lead, frontend-lead |
| Tier 4 | High | Opus medium | medium | tech-lead, ai-lead, quality-lead |
| Tier 5 | Highest | Opus high | high | orchestrator only |

**Rule**: Always use the lowest tier that can do the job correctly. Escalate to a higher tier only when judgment or synthesis across complex tradeoffs is required.

---

## Quality Gates

No code is merged without passing all applicable gates:

### Gate 1 — Security (required for auth, data, external APIs, user input)
- `security-engineer` must produce a Security Assessment Report
- No Critical or High findings open at time of merge
- Threat model reviewed for the feature

### Gate 2 — Code Quality (required for all implementation)
- `code-quality` must produce a Code Quality Report
- No P1 (cyclomatic complexity > 10) blockers open
- No AI slop patterns unresolved

### Gate 3 — Test Coverage (required for all implementation)
- `qa-engineer` must produce a Test Summary with coverage results
- Line coverage ≥ 80%
- Branch coverage ≥ 70%
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
Simpler solutions are preferred. Before adding a new abstraction, ask: "Does this pay for its complexity?" Cyclomatic complexity > 10 per function is a hard limit, not a suggestion.

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
