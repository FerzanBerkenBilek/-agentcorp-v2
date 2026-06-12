# AgentCorp v2 — Phased Delivery Playbook

How to take a project spec and have it built, efficiently and verifiably, by running
the AgentCorp agent system one phase at a time. Written to be handed to an LLM
(or a human) that will drive the orchestrator. It assumes the global `~/.claude/CLAUDE.md`
operating system is installed (agent routing table, tiers, handoff protocol, quality
gates, context-budget rules, security gate).

> One sentence: **one phase = one orchestrator run = one independently shippable,
> tested, security-cleared increment** — and everything below exists to keep each
> run cheap, resumable, and honest.

---

## 0. The mental model

```
PROJECT
  └─ Phase 1  →  orchestrator run  →  SHIP IT  →  commit
  └─ Phase 2  →  orchestrator run  →  SHIP IT  →  commit
  └─ ...
```

- **You never call specialists directly.** You hand a phase to the **orchestrator**;
  it decomposes and spawns the right agents in the right order. (Hierarchy rule:
  only the orchestrator spawns agents.)
- **State lives in `context/brief.md`, not in chat.** Agents hand off through it.
  If it isn't in brief.md, it didn't happen.
- **Each phase ends at a quality gate.** `quality-lead` must say **SHIP IT** before
  the phase is done. No SHIP IT → the phase is not finished, full stop.

---

## 1. Decompose the project into phases

Good phases are **vertical, ordered, independently testable, and session-sized.**

**Vertical slice, not horizontal layer.** A phase is "WebSocket real-time updates,"
not "write all the database schemas." Each phase touches route → service → repository
for one capability and ends with passing tests. (See the real history: v1.2 WebSocket,
v1.3 abuse prevention, v1.4 OAuth2, v1.5 bulk ops, v1.6 audit log — each one a phase.)

**Order by dependency, then by risk.**
1. Foundation first (auth, data model, the core entity) — later phases lean on it.
2. Then features that depend on the foundation.
3. Cross-cutting refactors (e.g. a Result-pattern migration) go *between* features,
   never mixed into a feature phase.

**Size each phase to fit one session.** A phase that needs 8+ agents and thousands of
lines will hit a session limit mid-run. If a phase feels large, split it (e.g.
"audit log schema + immutability" then "audit log query API"). Rule of thumb: if you
can't state the phase's Definition of Done in 3 bullets, it's two phases.

**Write a one-line Definition of Done per phase before you start.** Example:
"GET /audit-logs admin-only, filterable, paginated; immutability enforced at DB level;
558 existing tests still green; new module >95% coverage."

---

## 2. The per-phase workflow (the non-negotiable gate sequence)

The orchestrator runs each phase through this order. Skipping a step needs explicit
user approval — "we're in a hurry" is not approval.

```
1. DESIGN     architect / tech-lead / data-lead   → ADR(s) in decisions.md
   SECURITY   security-engineer (threat model)     ← BEFORE implementation, mandatory
                                                      for auth/data/input/infra/network
2. BUILD      backend-dev / frontend-dev / db-engineer / devops
3. REVIEW     qa-engineer  ‖  code-quality         ← run in PARALLEL (one message)
4. GATE       quality-lead                          → must issue SHIP IT
5. DOCS       tech-writer                           → CHANGELOG, api docs
```

Pick the call pattern that matches the phase (from the global CLAUDE.md):
- **New feature** → architect → security-engineer → backend-dev → qa ‖ code-quality → quality-lead → tech-writer
- **Bug fix** → backend-dev → qa → code-quality → quality-lead
- **DB change** → data-lead → db-engineer → qa → quality-lead
- **AI/ML feature** → ai-lead → ml-engineer ‖ prompt-engineer → qa → quality-lead
- **Refactor** → architect (pattern ADR) → backend-dev → qa ‖ code-quality → quality-lead

---

## 3. The five efficiency levers (use all of them, every phase)

These are what make AgentCorp cheap instead of a token bonfire.

### Lever 1 — Context budget (≈91% token saving, measured)
Before invoking agents, the orchestrator **pre-creates tagged sections** in brief.md
for each agent it will call:
```
<!-- agent: backend-dev -->
## Backend-Dev Output — <phase> — <date>
(agent fills this in)
<!-- /agent: backend-dev -->
```
Each specialist is told: **"Read ONLY brief.md sections tagged with YOUR tags — Grep
your tags, Read only those line ranges, never the full file."** A specialist reads
4–10% of a multi-thousand-line brief instead of all of it. Same for `decisions.md`:
each agent reads only ADRs tagged with its domain. This is the single biggest cost saver.

### Lever 2 — Memory (recall before, save after)
- **Before** threat-modeling or designing, the agent runs `memory_recall` with
  domain-scoped queries (e.g. "auth security findings", "IDOR", "<project> schema").
  Cross-project lessons are fair to reuse — just note which `project` they came from.
- **After** finishing, the agent `memory_save`s key findings tagged with the project
  and domain, so the next phase (or project) recalls them.
- Memory is one shared global pool; the `project`/`cwd` tag distinguishes projects.

### Lever 3 — Security gate (shift left, never optional)
security-engineer is called **before** implementation for any phase touching auth,
user data, PII, input, external APIs, file paths, env/secrets, middleware, or DB writes.
The threat model is written before code. `quality-lead` blocks SHIP IT if
`SECURITY_STATUS` ≠ DONE. backend-dev writes a **pre-implementation security scan**
to brief.md (files it will touch, patterns, risks) before writing code.

### Lever 4 — Quality baseline (regression as a hard gate)
`.quality-baseline.json` holds per-file complexity + coverage thresholds. Every review:
code-quality writes a **BASELINE_COMPARISON** block, runs `scripts/check-slop.ps1`
(AI-slop detector), and bumps the baseline version on a major feature. Coverage drop
below threshold or complexity +50% vs baseline = automatic P1 = no SHIP IT.

### Lever 5 — Hierarchy (one spawner, structured receipts)
Only the orchestrator spawns agents. Every agent ends with a structured receipt in
brief.md: `AGENT / STATUS / TIER / KEY_DECISIONS / RECOMMENDED_NEXT / HANDOFF_NOTES`.
A **Hierarchy Execution Log** table at the top of brief.md tracks every agent, tier,
and status — your at-a-glance phase progress and your resume map.

---

## 4. Survival rules (the things that actually break runs)

These come from real failures, not theory.

### A. Session limits → CHECKPOINT and resume, don't restart
A long phase can hit the model's session limit mid-run. When that happens:
- The orchestrator (or you) writes the current state to brief.md and **stops** — it
  never "pretends" to keep orchestrating past a limit.
- **Resume** by launching a fresh orchestrator with a prompt that says *"RESUMING —
  here is what is already DONE (read the brief.md tagged sections to confirm, don't
  re-execute): ..."* and lists completed agents + their outputs. The orchestrator
  re-reads brief.md, skips finished work, and continues from the first unfinished agent.
- This is why brief.md receipts matter: they ARE the resume journal.

### B. When the spec doesn't match reality → halt at the design gate
If, during design, an agent finds the request's premise is wrong (e.g. "replace
throw-on-not-found" when the repos already return `T|null`), the orchestrator **stops
before any code is written** and escalates to the user with options A/B, not a guess.
Cheaper to halt at design than to build the wrong thing and unwind it.

### C. "All existing tests must pass unmodified" → if a test must change, STOP
A refactor/feature that forces an existing test edit is a signal the behavior changed.
The agent stops and reports *which* test and *why*, and the user decides whether the
change is intended (a transport-only edit) or a real regression. Never silently edit
tests to make them green.

### D. Evidence before claims → verify, then assert
Before a phase is called done, **independently re-run** `tsc --noEmit` and the test
suite and quote the real numbers. "616/616 passing, exit 0" with the command output —
not "tests should pass." The orchestrator does not trust an agent's receipt for the
final number; it re-runs.

### E. Never commit unless asked
Agents leave changes in the working tree. The user runs `git commit`/`push` themselves.

---

## 5. Phase kickoff prompt template

Hand this to the orchestrator to start a phase. Fill the brackets.

```
Use the orchestrator agent to handle this:

PHASE <n>: <one-line name>
Repo: <path>.  Context: context/brief.md, decisions.md, patterns.md.
Baseline at start: <N> tests green, quality-baseline v<x.y.z>.

DEFINITION OF DONE (3 bullets max):
- <observable outcome 1>
- <observable outcome 2>
- all <N> existing tests still pass unmodified; new code >95% coverage

REQUIREMENTS: <bulleted spec>
CONSTRAINTS: <no new deps / reuse X / DB-level enforcement / etc.>

WORKFLOW: follow the CLAUDE.md gate sequence. Pre-create tagged brief.md sections +
receipt stubs for every agent before invoking it. Maintain the Hierarchy Execution Log.
Run security-engineer before implementation (mandatory if this touches auth/data/input).
Run qa-engineer ‖ code-quality in parallel. quality-lead must issue explicit SHIP IT.

CONTEXT BUDGET: tell every specialist to read ONLY its own brief.md tags and only its
domain's ADRs, and to report tags grepped + lines read vs total.

VERIFY before reporting: re-run `tsc --noEmit` and the test suite yourself; quote the
real counts. Do NOT commit — leave changes in the working tree.

If the spec's premise turns out wrong, or an existing test must change, STOP and ask me.
```

---

## 6. Phase exit checklist (Definition of Done, mechanical)

A phase is done only when ALL are true:
- [ ] `quality-lead` issued an explicit **SHIP IT** in brief.md.
- [ ] Security gate: `SECURITY_STATUS: DONE`, 0 open Critical/High.
- [ ] Tests: all prior tests pass **unmodified** + new tests; coverage ≥ threshold,
      independently re-verified (`tsc` exit 0, suite green).
- [ ] code-quality: CLEAN slop report, BASELINE_COMPARISON written, baseline version bumped.
- [ ] brief.md: every agent receipt is DONE; Hierarchy Execution Log complete.
- [ ] ADRs appended to decisions.md; reusable patterns to patterns.md.
- [ ] Docs: CHANGELOG + api docs updated by tech-writer.
- [ ] Memory: key findings saved (project-tagged) for the next phase.
- [ ] Changes left in working tree; user commits.

Then start the next phase from a clean baseline.

---

## 7. Anti-patterns (these waste tokens or break isolation)

- ❌ Calling backend-dev directly to "just write it fast" — skips the gate, no security
  review, no resume trail.
- ❌ Letting an agent read the full brief.md — defeats the 91% context saving.
- ❌ One giant phase with the whole project — guarantees a mid-run session limit.
- ❌ Mixing a refactor into a feature phase — makes the diff un-reviewable and the
  SHIP IT decision murky.
- ❌ Trusting a receipt's "tests pass" without re-running — receipts can be optimistic.
- ❌ Editing tests to go green — hides a real behavior change.
- ❌ Committing on the user's behalf — always leave it to the user.
- ❌ For multi-project setups: letting one project's context files/baseline leak into
  another. Memory is a shared pool (project-tagged); **files are not** — keep each
  project's `context/`, ADRs, and baseline its own.
