## Orchestrator Output — WebSocket Real-Time Task Updates — 2026-06-10

## STATUS: ROUTING COMPLETE — EXECUTION HANDED TO MAIN LOOP. Orchestrator has NO subagent-spawn (Task/Agent) tool in this environment (verified via ToolSearch — only TaskStop/memory/EnterWorktree/RemoteTrigger exist; no spawn). Per role spec + patterns.md ("Verify Spawn Capability Before Promising Execution") the orchestrator did NOT implement code. Signal: **"cannot spawn — main loop should execute"**.

### SECURITY HEADER
- SECURITY_REVIEW: REQUIRED
- SECURITY_REASON: Triggers fire on multiple axes — (a) AUTH: WS connection requires a valid JWT; (b) USER INPUT: clients send subscribe messages naming a target user feed; (c) AUTHZ/IDOR: "users only see their own tasks or tasks assigned to them" is an object-level access-control rule over a NEW transport; (d) the realistic browser-WS auth path puts the JWT in a QUERY PARAM (browsers can't set WS headers), which leaks tokens to access logs/proxies/Referer — a real finding to rule on; (e) DoS: 10-concurrent-connection-per-user cap is an abuse control. Gate 1 is MANDATORY and must be DONE before backend-dev implements.
- SECURITY_STATUS: DONE (Gate-1 threat model complete; R1–R20 checklist authored; re-verify at Gate-1 close-out after implementation)

### Goal
Add real-time task updates to the existing task-management API over WebSockets. When a task is created, updated, or deleted, emit `{ type: "task.created"|"task.updated"|"task.deleted", task: TaskResponse, timestamp: ISO8601 }` to every connected client subscribed to that task's owner feed, restricted so users only receive tasks they may see (own OR assigned). Connection requires a valid JWT (same token as the REST API). Graceful disconnect/reconnect handling. Max 10 concurrent WS connections per user.

### Scope
#### In Scope
- New `src/ws/` module (its own boundary, NOT a copy of a tasks-style vertical slice): WS route/plugin, a JWT-authenticated connection handshake, a connection registry / pub-sub hub keyed by user, a subscribe/unsubscribe message protocol, the event envelope serializer, the per-user 10-connection limiter, and disconnect cleanup.
- `@fastify/websocket` added as the ONE new dependency (tech-lead owns the version pin — must be the Fastify-v4-compatible major).
- Integration seam: task create/update/delete in `tasks.service` (or the route layer) must publish an event to the WS hub WITHOUT the service importing Fastify/WS types (ADR-010 layering — architect defines the seam; likely an injected publisher/event-emitter interface in `shared/`).
- Authorization on the event fan-out: a subscriber receives a task event ONLY if they are the task owner or assignee (reuse the `tasks.policy` owner-or-assignee rule, ADR-013) — this is IDOR prevention on the push channel.
- Full test coverage (>95% on `src/ws/`) incl. auth-reject, subscribe-authz/IDOR, fan-out correctness, connection-cap (11th → reject/close), disconnect cleanup. All existing 197 tests stay green.
- docs/api.md WebSocket section + CHANGELOG entry (tech-writer).

#### Out of Scope
- Horizontal scaling of the WS layer across instances (in-memory single-instance hub only, consistent with ADR-014/018 in-memory posture — Redis pub/sub fan-out is a documented FUTURE concern, NOT built now).
- Persisting events / replay / missed-message backfill on reconnect (reconnect re-subscribes and resumes live; no event log).
- Bidirectional task mutation over WS (WS is read/subscribe-only; all writes stay on the REST endpoints).
- Presence, typing indicators, rooms beyond the per-owner feed, message compression.
- A new DB entity or migration — there is NONE (events derive from existing task mutations). data-lead / db-engineer NOT routed.

### Constraints
- Stack frozen except the one approved new dep: Fastify v4, Prisma 5, jsonwebtoken (direct, HS256-pinned — ADR-005 amendment), Zod, TypeScript strict, Vitest (ADR-001..024). `@fastify/websocket` is the ONLY permitted addition (constraint from the task); its major MUST match Fastify 4 (note: @fastify/websocket v11 requires Fastify 5; v10.x is the Fastify-4 line — tech-lead confirms exact version + verifies no transitive Fastify-5 pull).
- REUSE verbatim: `src/shared/jwt.ts` `verifyAccessToken(token)` (transport-agnostic — reuse directly for the WS handshake; do NOT reuse `authGuard` which is an HTTP preHandler that throws AuthError→HTTP 401, wrong for a WS handshake that must close with a WS code). `src/shared/auth-context.ts` AuthContext shape. `src/tasks/tasks.policy.ts` owner-or-assignee rule for fan-out authz. `src/shared/errors.ts`. `src/app.ts` `registerModules()` DI wiring. `src/test/fake-prisma.ts` for tests.
- Auth on connect MANDATORY; the query-param-token leak is a known issue security-engineer must rule on (mitigations: prefer Sec-WebSocket-Protocol subprotocol token or a short-lived ticket, or accept query-param with documented log redaction — security-engineer decides + ADRs it).
- No business logic in the WS route; hub is the single fan-out choke point; authz only via the reused tasks.policy predicate (ADR-010/013).
- Coverage > 95% on `src/ws/`; global gate floor stays line ≥80 / branch ≥70; all 197 existing tests pass.

### Routing rationale (why this plan, why it DIFFERS from the URL-shortener routing)
This is a NEW security-critical feature, but UNLIKE the URL shortener it is NOT a verbatim 4th copy of the accepted vertical-slice pattern, AND it adds a real new dependency. Therefore the "collapse architect/tech-lead" pattern (patterns.md) does NOT apply here:
- **architect RETAINED (Phase 1):** WebSockets introduce a GENUINELY NEW component boundary that no ADR covers — a stateful in-process connection registry / pub-sub hub, and a NEW integration seam from `tasks.service` (a downward-only layer per ADR-010) out to a push channel. There is a real design decision: how does a task mutation notify connected sockets WITHOUT the service importing Fastify/WS types (which ADR-010 forbids)? Likely answer = an injected event-publisher interface in `shared/`, but that is architect's call + an ADR. Re-deriving ADR-011 would be waste; designing this new seam is not.
- **tech-lead RETAINED (Phase 2):** `@fastify/websocket` is a NEW runtime dependency (absent from package.json) — an explicit tech-lead trigger (dependency choice + version pin + Fastify-4 compatibility + transitive-dep audit). This is exactly the escalation the URL-shortener plan reserved for "if an unavoidable new dependency appears." It IS here, so tech-lead runs. tech-lead is SEQUENCED AFTER architect (Phase 2) because the dependency choice depends on the boundary design (does architect's seam even need the @fastify/websocket connection-store, or just the raw ws upgrade?), and tech-lead also ratifies the architect↔ADR-010 layering decision.
- **security-engineer RETAINED + Phase 1 (proactive, Principle #5):** owns the WS-auth handshake (query-param-token leak), subscribe-message validation, and the IDOR-on-fan-out threat model. Runs PARALLEL with architect (independent: threat model vs component design; they only share brief.md).
- **data-lead / db-engineer SKIPPED:** no schema change, no new entity, no migration. Events are ephemeral, derived from existing task mutations. Routing them would breach the complexity/token budget (Principle #4). (If backend-dev discovers a persistence need — e.g. an outbox for at-least-once delivery — ESCALATE to data-lead before adding any table.)
- **backend-dev, qa-engineer, code-quality, quality-lead, tech-writer RETAINED** per the standard New-Feature chain. quality-lead issues Gate-4 SHIP IT; all gates apply (auth + user-input + authz → Gate 1 mandatory).

### Agent Execution Plan (phased, with dependencies)
**Phase 1 (PARALLEL — independent, share only brief.md):**
- **security-engineer** — STRIDE threat model for the WS feature. Rule on: (1) **JWT-on-connect transport** — query-param vs Sec-WebSocket-Protocol subprotocol vs short-lived ticket; the query-param-token-in-logs leak (mitigation/ADR). (2) **Auth handshake failure semantics** — reject with a WS close code (e.g. 1008 policy violation) / refuse the upgrade, NOT an HTTP 401 body. (3) **IDOR on fan-out (headline)** — a subscriber must receive a task event ONLY if owner-or-assignee; subscribing to "another user's feed" must not leak that user's tasks → reuse `tasks.policy` predicate; deny silently (no existence leak). (4) **Subscribe-message validation** — Zod-validate inbound WS frames; reject malformed/oversized frames; cap message size. (5) **DoS** — the 10-conn/user cap (abuse control), connection-rate, slow-loris/half-open sockets, unbounded subscription growth, ping/pong heartbeat to reap dead sockets. (6) **Origin check** on the WS upgrade (CSWSH — cross-site WebSocket hijacking; reuse the CORS origin allowlist). Produce an H/M/L Gate-1 checklist for backend-dev + author ADRs (WS auth transport, CSWSH/origin, fan-out authz model). Output → its tag section below.
- **architect** — design `src/ws/` boundary + the integration seam. Decide: the connection registry/hub data structure (Map<userId, Set<socket>>), the publisher interface that lets `tasks.service`/route emit events WITHOUT importing Fastify/WS (ADR-010 downward-only — propose an injected `TaskEventPublisher` port in `shared/` that the hub implements and the tasks module depends on, OR emit from the route layer after the service returns). Define the event envelope type (`TaskEvent`) and where `TaskResponse` serialization lives (reuse the existing tasks response shape — do NOT duplicate). Map subscribe/unsubscribe protocol + how the per-user cap and authz fit the boundary. Author an ADR for the WS module boundary + the task→hub event seam (next free number ≈ ADR-025; confirm against decisions.md). Output → its tag section below.

**Phase 2 (SEQUENTIAL — depends on Phase 1 architect + security):**
- **tech-lead** — ratify/choose the `@fastify/websocket` version (Fastify-4-compatible major — likely v10.x; confirm it does NOT pull Fastify 5; check @types and transitive deps; `npm audit` clean). Confirm the architect's task→hub seam respects ADR-010 layering (no Fastify/WS types leaking into the service). Decide whether the hub is a Fastify decorator vs a plain shared singleton (consistency with the ADR-005-amendment "plain shared util over plugin decorator" preference is a relevant precedent). Append the dependency decision as an ADR amendment or note. If anything conflicts with security's transport choice, resolve it here. Output → its tag section below.

**Phase 3 (SEQUENTIAL — depends on Phases 1+2):**
- **backend-dev** — implement `src/ws/` against the architect boundary + security Gate-1 checklist + tech-lead's dep pin: the WS plugin/route (JWT handshake via reused `verifyAccessToken`, close-code on auth fail), the hub/registry, subscribe/unsubscribe with Zod-validated frames, the fan-out applying the reused `tasks.policy` owner-or-assignee predicate (IDOR prevention), the 10-conn/user cap, heartbeat + disconnect cleanup, and the `TaskEvent` publish hook wired into task create/update/delete via the architect's seam. Register in `app.ts`. Add the dep to package.json. NO new dep beyond @fastify/websocket (escalate to tech-lead otherwise). Output → its tag section below.

**Phase 4 (PARALLEL — depends on Phase 3):**
- **qa-engineer** — Vitest tests for `src/ws/` (>95%): connect with valid JWT → accepted; missing/invalid/expired JWT → closed (correct WS close code); subscribe to own feed → receives own task.created/updated/deleted with the exact envelope shape + ISO8601 timestamp; subscribe to a feed you may not see → no events leak (IDOR); assigned-task visibility (assignee receives owner's task event for that task); 11th concurrent connection for a user → rejected/closed; disconnect → registry cleaned up (no leak), reconnect resumes; malformed/oversized inbound frame → rejected; fan-out hits ALL of a user's connected sockets. Extend the test harness for WS (real `buildApp()` + a WS client, or unit-test the hub directly + integration-test the handshake). All 197 prior tests still green. Output → its tag section below.
- **code-quality** — review `src/ws/` for complexity (<10), DRY (reuses jwt/tasks.policy/errors, no duplication), layer integrity (no Prisma in ws; no Fastify/WS types in tasks.service; authz only via the reused policy predicate; hub is the single fan-out point), AI slop, dead code, naming. Output → its tag section below.

**Phase 5 (SEQUENTIAL — depends on Phase 4):**
- **quality-lead** — Gate 1 (security: auth-on-connect, IDOR-on-fan-out, CSWSH origin, frame validation, conn-cap all closed — INDEPENDENTLY verified, per the quality-lead patterns.md entry: re-run suite + tsc + read the handshake/fan-out source) + Gate 2 (code-quality CLEAN) + Gate 3 (>95% on src/ws/, ≥80/70 global, 197+ tests green) + Gate 4 SHIP IT / FIX IT. Output → its tag section below.

**Phase 6 (SEQUENTIAL — depends on Phase 5 SHIP IT):**
- **tech-writer** — add a WebSocket section to docs/api.md (connect URL + auth transport, subscribe protocol, event envelope, close codes, conn limit, curl/wscat example) documenting SHIPPED behavior from source (not spec), and a CHANGELOG entry + package.json minor bump (e.g. 1.1.0 → 1.2.0). Output → its tag section below.

### Reusable surface map (confirmed by orchestrator from live source)
- `src/shared/jwt.ts` `verifyAccessToken(token): AccessTokenPayload` (lines 52-64) — transport-agnostic, HS256-pinned (ADR-005 amendment); reuse DIRECTLY for the WS handshake. `payload.sub` = userId.
- `src/shared/auth-context.ts` — `authGuard` is an HTTP preHandler that reads `request.headers.authorization` and throws `AuthError`→HTTP 401 (lines 34-42). **Do NOT reuse authGuard for the WS upgrade** (wrong failure semantics — WS needs a close frame, and browsers can't set the Authorization header). Reuse the `AuthContext { userId }` shape and `verifyAccessToken` instead.
- `src/tasks/tasks.policy.ts` — `assertCanAccess`/`isOwner`/`isAssignee` (owner-OR-assignee, 404-not-403). The fan-out authz must reuse this owner-or-assignee rule (refactor the boolean predicate out if needed so the hub can call it without throwing; architect/code-quality to keep it DRY, not duplicated). ADR-013.
- `src/tasks/tasks.service.ts` — `create`/update/delete return the mutated `Task` (line 40-53 confirms `create` returns `Promise<Task>`). The event seam hooks these return values. Service must NOT import Fastify/WS (ADR-010) → architect's injected-publisher seam.
- `src/app.ts` `registerModules()` (lines 114-131) — DI composition root; the WS plugin + hub register here. `registerPlugins` (74-106) shows the plugin registration + the CORS origin allowlist (`config.CORS_ORIGINS`) reused for the CSWSH origin check. `/health` (55-63) is the public pre-guard route precedent.
- `src/shared/errors.ts` — AppError/AuthError/ValidationError/NotFoundError + ERROR_CODE/HTTP_STATUS. WS auth/validation failures map to close codes (security-engineer defines), not HTTP bodies.
- `src/test/fake-prisma.ts` — has user/task/refreshToken/shortUrl delegates; the task delegate already exists for fan-out integration tests. patterns.md "Static-Import + Hoisted vi.mock" applies to WS-client/hub mocking.
- TaskResponse shape: reuse the existing tasks route response serializer — do NOT define a second task DTO (DRY; code-quality will check).

### Handoff protocol reminder for EVERY specialist
BEFORE: attempt agentmemory recall (currently returning empty — log the fallback); read THIS WebSocket brief section + relevant decisions.md ADRs (ADR-005 auth, ADR-010/011 layering, ADR-013 authz, ADR-014 rate/DoS posture, ADR-018 single-store/Redis-deferred) + your patterns.md entries; read the reuse-map source files. AFTER: write your "## <Agent> Output — WebSocket" content into your pre-created tag section below; fill your receipt block (STATUS/COMPLETED/KEY_DECISIONS/BLOCKERS/RECOMMENDED_NEXT/HANDOFF_NOTES); append ≥1 patterns.md entry; attempt agentmemory remember; update your Hierarchy Execution Log row to DONE/BLOCKED; report DONE | BLOCKED | NEEDS_REVIEW.

### Open Questions (for security-engineer / architect to resolve, NOT blocking the plan)
1. WS-auth transport: query-param token (leaks to logs) vs Sec-WebSocket-Protocol subprotocol vs short-lived ticket exchanged over REST. (security-engineer rules → ADR.)
2. "Subscribe to a user's feed" — is cross-user subscription EVER allowed (e.g. an assignee subscribing to an owner's feed to get tasks assigned to them)? The requirement says "users only see their own tasks OR tasks assigned to them" → the safe interpretation is: a client subscribes to THEIR OWN identity's feed, and the fan-out delivers any task where they are owner-or-assignee. Cross-user feed subscription should be DENIED. (security-engineer + architect confirm the subscription model.)
3. Reconnect: stateless re-subscribe (no replay) is in-scope; confirm no missed-event backfill is required (out of scope per this brief).
<!-- /agent: orchestrator -->

---

<!-- agent: security-engineer -->
## Security-Engineer Output — WebSocket Real-Time Task Updates — 2026-06-10

> PRE-IMPLEMENTATION threat model. `src/ws/` does not exist yet — this section IS the security
> requirements contract backend-dev must implement and qa-engineer must test. Verdict: **DONE (no
> code-blocking findings — all findings are forward REQUIREMENTS, none observed in shipped code).**
> ADR coordination: architect claims ADR-025 (WS module boundary). **I claim ADR-026, ADR-027,
> ADR-028** (see decisions.md). Architect: do NOT use 026/027/028.

### Memory recall fallback
agentmemory recall returned EMPTY for all four security queries (SECURITY_PATTERN / SSRF-injection-auth /
SECURITY_DECISION / approved-patterns). Logged the fallback; relied on in-repo ADRs (005/009/013/014/015/019)
+ live source as the prior-art baseline. Saved structured SECURITY_PATTERN/DECISION entries this run to seed
future recalls.

### REVIEW_SCOPE (Step 0 — differential risk classification of the planned `src/ws/` surface)
| Planned file / seam | Risk | Why |
|---|---|---|
| WS plugin / route — JWT handshake on upgrade | HIGH | authn boundary on a NEW transport; close-code semantics; CSWSH origin |
| Hub / connection registry (fan-out) | HIGH | object-level authz (IDOR) on the push channel; DoS (unbounded growth) |
| subscribe/unsubscribe frame handler | HIGH | untrusted user input over the socket; frame validation; DoS |
| task→hub publisher seam (in tasks.service/route) | MEDIUM | layering (ADR-010); no authz decision here (fan-out filters) |
| TaskEvent envelope serializer | MEDIUM | information disclosure — must reuse `toTaskResponse`, expose no extra fields |
| `@fastify/websocket` dependency | MEDIUM | A06 vulnerable-component / transitive audit (tech-lead owns pin; I require `npm audit` clean) |
| app.ts wiring | LOW | composition only |

Depth applied proportionally: handshake + hub + frame handler get full STRIDE; seam/envelope get targeted review.

### Trust boundary
Untrusted: the WS client, every inbound frame, the `Origin` header, the connection count, and the
JWT *until* `verifyAccessToken` succeeds. Trusted-after-validation: `payload.sub` (userId). The hub is an
in-process trusted component; the socket on the other end is hostile until proven otherwise. Default deny on
every fan-out and subscribe decision; fail closed (any error → close the socket / drop the event, never deliver).

---

### STRIDE Threat Model — per WS surface

#### Surface 1 — Handshake / connection upgrade
| STRIDE | Threat | Mitigation (→ requirement #) |
|---|---|---|
| Spoofing | Connect without/with forged identity | Mandatory `verifyAccessToken` on upgrade; HS256 pinned, alg:none + expired already rejected by reused fn (R1, R2) |
| Spoofing | CSWSH — attacker page opens a WS as the victim's browser (cookies/ambient creds) | Origin allowlist check on upgrade; **fail-closed when allowlist empty in prod** (R3) |
| Tampering | alg-confusion / "none" token | Reused `verifyAccessToken` pins `algorithms:['HS256']` — covered, do NOT add a second verify path (R2) |
| Info Disclosure | JWT in query param leaks to access logs / proxy logs / Referer | Transport ruling: Sec-WebSocket-Protocol subprotocol PREFERRED; query-param allowed only with mandatory log redaction (R4, ADR-026) |
| DoS | Connection flood / half-open (slow-loris) sockets | Per-user 10-conn cap enforced AT handshake; idle/auth-timeout; heartbeat reaper (R6, R8, R9) |
| Elevation | — | No role model; identity = sub only. N/A |

#### Surface 2 — Subscribe / unsubscribe (inbound frames)
| STRIDE | Threat | Mitigation (→ requirement #) |
|---|---|---|
| Tampering | Malformed / oversized / non-JSON frame; prototype-pollution keys | Zod-validate every inbound frame; cap frame size; reject unknown types; close on repeated abuse (R5, R7) |
| Info Disclosure | **IDOR — subscribe to ANOTHER user's feed to receive their tasks** | Subscription identity is pinned to the connection's authenticated `sub`; a `targetUserId` in the frame is IGNORED or must equal `sub`; cross-user subscribe is DENIED SILENTLY (no existence leak) (R10, ADR-028) |
| DoS | Unbounded subscription set / rapid subscribe churn | Bounded subscription model (a connection has exactly one feed = its own identity); per-conn message-rate cap (R7, R11) |
| Repudiation | Deny having subscribed/connected | Audit connect/auth-fail/close via existing `audit()` (no token/PII in log) (R12) |

#### Surface 3 — Event fan-out (push channel)
| STRIDE | Threat | Mitigation (→ requirement #) |
|---|---|---|
| Info Disclosure | **IDOR (HEADLINE) — user B receives a task they may not see** | Fan-out applies the reused owner-or-assignee predicate PER recipient PER event; deliver only if `isOwner(task,uid) \|\| isAssignee(task,uid)` (R13, ADR-028) |
| Info Disclosure | Envelope leaks internal/extra fields | Serialize via the EXISTING `toTaskResponse` shape only — no new DTO, no internal columns (R14) |
| Tampering | `task.deleted` event must still authz on the now-deleted row's owner/assignee snapshot | Publisher captures owner/assigneeId at mutation time; fan-out predicate runs on that snapshot (R13, R15) |
| DoS | One mutation fans out to thousands of sockets (amplification) | Bounded by the 10-conn/user cap × authorized-recipient set; no broadcast-to-all (R6, R13) |
| Spoofing | Server emits an event a client can't attribute | Envelope `{type, task, timestamp}` only; server-authoritative, clients cannot publish (WS is read-only) (R16) |

#### Surface 4 — Disconnect / lifecycle
| STRIDE | Threat | Mitigation (→ requirement #) |
|---|---|---|
| DoS | Socket leak — dead sockets retain registry slots, exhaust the 10-cap + memory | Deterministic cleanup on close/error; heartbeat ping/pong reaps half-open sockets; decrement the per-user count (R8, R9, R17) |
| Info Disclosure | Stale socket still receiving events after logout/token expiry | Connection lifetime bounded by token exp; on `exp` reached, close with 1008 (no infinite sessions) (R18) |
| Repudiation | No record of forced closes | Audit abnormal closes (cap-exceeded, auth-timeout, frame-abuse) (R12) |

---

### Findings (rated as forward REQUIREMENTS — severity = what the gap would be if NOT implemented)
| ID | Sev | CWE | Title | Exploit path if not built | Required fix |
|----|-----|-----|-------|---------------------------|--------------|
| WS-01 | **HIGH** | CWE-862 / CWE-639 | IDOR on fan-out | Attacker connects as user B, any task event for user A (owner/assignee ≠ B) is pushed to B → cross-tenant task disclosure | Per-recipient owner-or-assignee predicate on EVERY event (R13) |
| WS-02 | **HIGH** | CWE-306 | Missing/!weak auth on upgrade | Unauthenticated socket subscribes and receives live task stream | Mandatory `verifyAccessToken` on handshake; close 1008 on fail (R1,R2) |
| WS-03 | **HIGH** | CWE-639 | Cross-user subscribe (IDOR via subscribe) | Authenticated B sends `{subscribe, userId:A}`; if honored, B taps A's feed | Subscription pinned to connection `sub`; cross-user denied silently (R10) |
| WS-04 | **MED** | CWE-352 / CWE-1385 | CSWSH (cross-site WS hijack) | Malicious page opens `ws://api/...` from victim's browser; if no Origin check, rides ambient auth | Origin allowlist on upgrade; fail-closed in prod (R3) |
| WS-05 | **MED** | CWE-532 | JWT leak via query-param transport | Token in `?token=` lands in access/proxy logs, Referer, browser history → replayable until exp | Prefer subprotocol transport; if query-param, mandatory redaction + short access-TTL reliance (R4) |
| WS-06 | **MED** | CWE-20 / CWE-400 | Unvalidated / oversized inbound frame | Malformed JSON, huge frame, prototype-pollution keys → crash / ReDoS / pollution | Zod validation + size cap + safe parse; close on abuse (R5,R7) |
| WS-07 | **MED** | CWE-770 | Connection-flood DoS | One user opens N sockets → memory/FD exhaustion | Enforce 10/user at handshake; reject 11th with 1008/1013 (R6) |
| WS-08 | **MED** | CWE-404 / CWE-772 | Socket / registry leak | Dead sockets never cleaned → slot + memory leak, legit reconnect blocked by stale count | Deterministic close cleanup + heartbeat reaper (R8,R9,R17) |
| WS-09 | **LOW** | CWE-613 | Unbounded session lifetime | Socket outlives token exp → effectively never-expiring access | Close at token exp (R18) |
| WS-10 | **LOW** | CWE-209 | Info leak in close reason | Verbose close reason reveals existence/internal state | Generic close reasons; no resource-existence signal (R10,R19) |

No CRITICAL findings (nothing ships yet; reused auth/authz primitives are already hardened). No BLOCKED conditions.

---

### Gate-1 Checklist for backend-dev (NUMBERED — each item is a merge gate; qa-engineer must have a test per item)

**Authentication & transport (handshake)**
1. **R1** — Authenticate EVERY upgrade by calling the reused `verifyAccessToken(token)` from `src/shared/jwt.ts`. Do NOT reuse `authGuard` (HTTP-401 semantics are wrong). On success, pin `connection.userId = payload.sub`.
2. **R2** — Do NOT add a second JWT verify path or relax algorithms. The reused fn already pins HS256 and rejects `alg:none`/expired. On verify failure → close, do NOT send an HTTP body.
3. **R3** — Enforce an Origin allowlist on the upgrade against `config.CORS_ORIGINS` (reuse the `csrf.ts` origin logic). **CHANGE FROM HTTP BEHAVIOR: fail CLOSED — if `CORS_ORIGINS` is empty in production (`config.isProduction`), REJECT the upgrade** (the HTTP `csrfOriginGuard` skips on empty allowlist; for WS that is a CSWSH hole). Reject mismatch with close 1008.
4. **R4** — Token transport: ACCEPT the token via the `Sec-WebSocket-Protocol` subprotocol (preferred) OR a `token` query param (browser fallback). If query-param is used, REDACT it from logs — the WS request URL must never reach the logger with the raw token (scrub before `request.log`; see ADR-026). Echo back the chosen subprotocol per RFC 6455.

**Inbound frame validation (subscribe/unsubscribe)**
5. **R5** — Zod-validate every inbound frame: `{ type: 'subscribe'|'unsubscribe' }` (closed enum). Reject unknown types. Use a safe JSON parse (try/catch) — never `JSON.parse` an unbounded buffer unguarded.
6. **R7** — Cap inbound frame size (recommend ≤ 8 KB; far below the 1 MB HTTP body limit — subscribe frames are tiny). Drop/close on oversize. Cap inbound message RATE per connection (recommend ≤ 20 msg / 10 s) and close on sustained abuse. Reject objects with `__proto__`/`constructor`/`prototype` keys (Zod `.strict()` covers this).

**Authorization — the IDOR controls (HEADLINE)**
7. **R10** — A connection subscribes to EXACTLY its own authenticated identity's feed. Any `userId`/`targetUserId` field in a subscribe frame MUST be ignored or required to equal `connection.userId`. Cross-user subscription is DENIED SILENTLY (close or ignore — no error that confirms the target exists). See ADR-028.
8. **R13** — Fan-out authz: for each event, deliver to a recipient connection ONLY if the recipient is owner OR assignee of that task. **REUSE the `tasks.policy` rule** — backend-dev MUST export a non-throwing boolean predicate (e.g. `canAccessTask(task, userId): boolean` built from the existing `isOwner`/`isAssignee`) from `src/tasks/tasks.policy.ts` and call it in the hub. Do NOT duplicate the owner-or-assignee logic (DRY; code-quality will reject a copy). Do NOT use `assertCanAccess` (it throws 404 — wrong for fan-out).
9. **R15** — For `task.deleted`, capture the owner/assigneeId SNAPSHOT at mutation time and pass it through the publisher, so the fan-out predicate can authz a row that no longer exists in the DB.

**Information disclosure**
10. **R14** — The event envelope `task` field MUST be serialized with the EXISTING `toTaskResponse` shape (reuse it — architect defines where it lives; do not create a second task DTO, do not add internal columns). Envelope = `{ type, task, timestamp }` with `timestamp` ISO8601.
11. **R16** — WS is READ/subscribe-only. Reject (close or ignore) any inbound frame that attempts a task mutation. All writes stay on REST.
12. **R19** — Close reasons and any error frames must be generic. Never include "task X exists but you can't see it", stack traces, or internal IDs the client didn't already own.

**DoS / resource controls**
13. **R6** — Enforce MAX 10 concurrent connections per `userId`, checked AT handshake (after auth, before registering). Reject the 11th with close code 1013 (Try Again Later) or 1008. Count is decremented on every close path.
14. **R8** — Deterministic cleanup on `close` AND `error`: remove the socket from the hub registry and decrement the per-user count. No code path may leave a registered-but-dead socket.
15. **R9** — Heartbeat: server-side ping/pong (recommend 30 s interval, 2 missed → terminate). Reaps half-open / slow-loris sockets that never send a close frame.
16. **R11** — Bound total registry growth: per-user cap (R6) × users; no global broadcast list; subscription set per connection is its own identity only (R10) so it cannot grow unbounded.
17. **R17** — On forced server close (cap, auth-timeout, abuse, token-exp), free ALL associated resources (timers, heartbeat interval, registry slot).
18. **R18** — Bound connection lifetime by token `exp`: schedule a close (1008) at `payload.exp`. A live socket must not outlive its access token.

**Auditing**
19. **R12** — Audit via the existing `audit()` helper: connection-accepted, auth-failure, cap-exceeded-reject, frame-abuse-close, token-exp-close. NEVER log the raw token, JWT, or any PII. Use `userId` only. (Reuse `src/shared/audit.ts`.)

**Dependency**
20. **R20** — `@fastify/websocket` must be a Fastify-4-compatible major (tech-lead pins; v10.x line, NOT v11 which needs Fastify 5). `npm audit` must be CLEAN (no High/Critical) for it + transitives before merge (OWASP A06).

### WS close-code convention (RFC 6455) — backend-dev MUST use these
| Condition | Close code | Reason (generic) |
|---|---|---|
| Auth failure (missing/invalid/expired token) | 1008 | "policy violation" |
| Origin not allowlisted (CSWSH) | 1008 | "policy violation" |
| Per-user connection cap exceeded | 1013 | "try again later" |
| Frame too large / malformed / abuse | 1008 (or 1009 for size) | "policy violation" |
| Token expiry reached mid-session | 1008 | "policy violation" |
| Normal client disconnect | 1000 | — |

---

### OWASP Coverage
| Category | Status | Notes |
|----------|--------|-------|
| A01 Broken Access Control | REQUIRED | IDOR is the headline — R10 (subscribe) + R13 (fan-out) close it; silent-deny, no enumeration (R10/R19) |
| A02 Cryptographic Failures | COVERED | Reused HS256-pinned `verifyAccessToken`; secrets ≥32B via config; transport ruling avoids token-in-log (R4) |
| A03 Injection | REQUIRED | No SQL on the WS path (no Prisma in `src/ws/`); frame is Zod-validated, safe-parsed (R5); no template/eval |
| A04 Insecure Design | COVERED | This threat model + bounded read-only subscribe-own-feed-only design; rate/size/conn caps designed in |
| A05 Security Misconfiguration | REQUIRED | Fail-closed Origin in prod (R3); generic close reasons (R19); no debug/stack leak |
| A06 Vulnerable Components | REQUIRED | `npm audit` clean on @fastify/websocket + transitives (R20); tech-lead pins Fastify-4 major |
| A07 Auth Failures | REQUIRED | Auth on connect (R1/R2); session bounded by token exp (R18); 11th-conn reject (R6) |
| A08 Software Integrity | COVERED | No deserialization of untrusted data beyond Zod-validated JSON; no eval/Function; package-lock committed |
| A09 Logging Failures | REQUIRED | Audit lifecycle events (R12); NO token/PII in logs; query-param token redaction (R4) |
| A10 SSRF | N/A | WS server accepts connections; makes no outbound URL fetch from user input. No SSRF surface here. |

### Dependencies
No code added yet → no `npm audit` run by me at this phase (nothing installed). **REQUIREMENT R20**: tech-lead/backend-dev MUST run `npm audit` after adding `@fastify/websocket` and confirm zero High/Critical before Gate-1 re-verify. Constraint reaffirmed: ONLY `@fastify/websocket` (Fastify-4 line) may be added; any further dep → escalate to tech-lead.

### Security ADRs written (decisions.md)
- **ADR-026** — WS Auth Transport: Sec-WebSocket-Protocol subprotocol preferred; query-param token accepted with mandatory log redaction. (Rules the query-param-leak tradeoff.)
- **ADR-027** — CSWSH / Origin check on WS upgrade: reuse CORS allowlist but FAIL CLOSED in production (deviation from HTTP `csrfOriginGuard` empty-allowlist skip).
- **ADR-028** — Fan-out Authorization Model: subscribe-own-feed-only + per-recipient owner-or-assignee predicate reused from `tasks.policy` (extends ADR-013 to the push transport); silent-deny IDOR prevention.
(Architect owns ADR-025. I did NOT touch 025.)

### Verdict
**DONE — no blockers.** Zero Critical, zero unmitigated High *in shipped code* (no code exists). All findings
are forward requirements with a numbered, testable Gate-1 checklist. Gate 1 will FLIP from PENDING→DONE only
after backend-dev implements R1–R20 and I (or quality-lead) re-verify the handshake + fan-out source.
RECOMMENDED_NEXT: architect + tech-lead (Phase 1/2) proceed in parallel; backend-dev MUST satisfy this
checklist in Phase 3; re-run security verification after implementation (Gate 1 close-out).
<!-- /agent: security-engineer -->

---

<!-- agent: architect -->
## Architect Output — WebSocket Real-Time Task Updates — 2026-06-10

**Status**: DONE. New `src/ws/` component boundary + the `tasks.service`→hub emission seam designed against the LIVE source (not spec). The seam decision is authored as a full ADR. **ADR NUMBER CLAIMED: ADR-025** (next free after ADR-024). Confirmed in-brief: security-engineer (parallel) claims ADR-026/027/028, so no collision — I keep 025. Two support refactors (in `tasks.policy.ts` and `tasks.routes.ts`) are REQUIRED by the design — DRY-preserving extractions, not new logic (see Implementation Guidance).

**Handoff protocol**: agentmemory recall ran (empty for this topic — logged fallback). Read decisions.md ALL ADRs (architect reads all); read the WebSocket brief section (orchestrator plan + constraints + reuse map); read LIVE source: `src/app.ts`, `src/tasks/{tasks.service,tasks.policy,tasks.routes}.ts`, `src/shared/{jwt,auth-context,errors,http}.ts`, `package.json`, full `src/` layout. remember + patterns.md appended.

### Problem Statement
A task mutation (create/update/delete) over the REST API must push an event to every live WebSocket client permitted to see that task (owner OR assignee), in real time, single-instance, in-process. This introduces TWO things no existing ADR covers: (1) a **stateful in-process connection registry/hub** (everything before this was stateless request/response), and (2) an **emission seam** that lets the downward-only `tasks.service` (ADR-010) cause a push WITHOUT importing Fastify/WS types or calling upward. The design keeps the hub as the single fan-out + authz choke point, reuses the existing JWT verify + tasks authz rule, and stays inside the complexity budget (no Redis, no outbox, no replay buffer).

### Architecture Diagram (ASCII)
```
   REST write path (unchanged contract)                    WS read/subscribe path (NEW)
   ─────────────────────────────────────                   ──────────────────────────────
        Fastify HTTP / Plugin layer                              ws upgrade  (GET /ws)
                  │                                                    │  @fastify/websocket
        ┌─────────▼──────────┐                              ┌─────────▼───────────┐
        │  tasks.routes      │                              │   ws.routes (plugin)│
        │  (authGuard)       │                              │  - JWT handshake    │  verifyAccessToken()
        └─────────┬──────────┘                              │    (close on fail)  │  REUSE shared/jwt
                  │ calls                                   │  - origin check     │  REUSE config.CORS_ORIGINS
        ┌─────────▼──────────┐    publish(TaskEvent)        │  - Zod frame parse  │
        │  tasks.service     │───────────────┐              └─────────┬───────────┘
        │  (no Fastify/WS)   │               │ (injected port)        │ register/subscribe/unsubscribe/drop
        └─────────┬──────────┘               ▼                        ▼
                  │ calls          ┌────────────────────────────────────────────────┐
        ┌─────────▼──────────┐     │                 ConnectionHub                   │
        │ tasks.repository   │     │  implements TaskEventPublisher (shared port)     │
        │ (Prisma ONLY)      │     │  registry: Map<userId, Set<Conn>>  (<=10/user)  │
        └─────────┬──────────┘     │  publish(evt): for each candidate userId where   │
                  ▼                │     canAccessTask(evt.task, userId) -> send(frame)│
              PostgreSQL           │  heartbeat ping/pong reaper; disconnect cleanup  │
                                   └───────────────────┬──────────────────────────────┘
                                                       │ canAccessTask(task,userId): boolean
                                                       ▼  REUSE (extracted, non-throwing)
                                                 tasks.policy   (owner-OR-assignee, ADR-013)

   shared/ (cross-cutting, importable by any layer — never imports features):
     ┌────────────────────────────────────────────────────────────────────────┐
     │ task-events.ts  -> interface TaskEventPublisher { publish(e:TaskEvent) } │  <- the PORT
     │                    type TaskEvent = { type; task: TaskResponse; timestamp}│
     │                    const NOOP_PUBLISHER (default injected; publish=no-op) │
     │ task-serializer.ts -> toTaskResponse(Task): TaskResponse  (MOVED here     │
     │                       from tasks.routes.ts; imported by BOTH route + hub) │
     │ jwt.verifyAccessToken · auth-context.AuthContext · errors · http.ok       │
     └────────────────────────────────────────────────────────────────────────┘
```

### Component Definitions

**`src/ws/ws.routes.ts`** — the Fastify WS plugin (the ONLY file in `src/ws/` that touches Fastify / `@fastify/websocket`).
- Responsibility: register `GET /ws`; on upgrade do the JWT handshake (`verifyAccessToken` on the security-engineer's chosen transport) + the CSWSH origin check (`config.CORS_ORIGINS`); on success `hub.register(userId, conn)`; route inbound frames (Zod-parse -> `hub.subscribe/unsubscribe`); wire `close`/`error` -> `hub.drop(conn)`; start/stop the heartbeat.
- Public interface: `wsRoutes: FastifyPluginAsync<{ hub: ConnectionHub }>`.
- Does NOT: contain fan-out logic, authz decisions, business rules, or Prisma. Transport adapter only; all decisions delegate to the hub/policy.

**`src/ws/connection-hub.ts`** — the stateful in-process registry + fan-out + single authz choke point. **Implements the `TaskEventPublisher` port.**
- Responsibility: hold `Map<userId, Set<Connection>>`; enforce the <=10-connections-per-user cap at `register()`; `publish(evt)` iterates candidate recipients (the task's `ownerId` + `assigneeId` only — NOT a broadcast) and sends ONLY to userIds where `canAccessTask(evt.task, userId) === true` (IDOR choke point); track subscriptions; run the heartbeat reaper; clean up on `drop()`.
- Public interface: `register(userId, conn): RegisterResult`, `subscribe(conn, msg)`, `unsubscribe(conn, msg)`, `drop(conn)`, `publish(evt: TaskEvent): void` (port method), `heartbeatTick()`, test seam `connectionCount(userId)`.
- Does NOT: import Fastify or `@fastify/websocket` types (takes a minimal `Connection` abstraction), import Prisma, parse JWTs, or duplicate the authz rule (calls `tasks.policy.canAccessTask`).

**`src/ws/ws.protocol.ts`** — Zod schemas + types for inbound client frames + the `Connection` interface the hub depends on.
- Responsibility: `subscribeFrameSchema` / `unsubscribeFrameSchema` (`.strict()`, discriminated on `type`), a max-frame-size guard constant, and `interface Connection { send(data:string):void; close(code:number,reason?:string):void; isAlive:boolean; userId:string; subscriptions:Set<string> }` — a tiny structural type the real `@fastify/websocket` socket satisfies, so the hub never names a Fastify/WS type (framework-agnostic AND unit-testable with a fake socket).
- Does NOT: import Fastify/WS.

**`src/shared/task-events.ts`** (NEW shared port) — the seam contract.
- Responsibility: `TaskEventType = 'task.created'|'task.updated'|'task.deleted'`; `interface TaskEvent { type: TaskEventType; task: TaskResponse; timestamp: string }`; `interface TaskEventPublisher { publish(event: TaskEvent): void }`; and `NOOP_PUBLISHER: TaskEventPublisher` (publish = no-op) used as the default so the tasks module works with WS disabled and unit tests need no hub.
- Does NOT: import anything from `src/ws/`, `src/tasks/`, or Fastify. Pure types + one constant. THIS is what keeps the dependency edge pointing DOWNWARD.

**`src/shared/task-serializer.ts`** (MOVED here) — `toTaskResponse(task: Task): TaskResponse` + the `TaskResponse` interface, extracted verbatim from `tasks.routes.ts`. Imported by BOTH `tasks.routes.ts` (behavior identical) and the emission seam. The DRY fix that lets the WS payload carry the SAME task wire shape without a second DTO.

### Data Flow (primary use case: task.updated reaches the right sockets)
1. Client A `PATCH /tasks/:id` (REST, authGuard). `tasks.routes` -> `tasks.service.update(...)` returns the updated `Task`.
2. The **emission seam** (ADR-025) turns that `Task` into a `TaskEvent` via `toTaskResponse` + `{ type:'task.updated', timestamp: new Date().toISOString() }` and calls the injected `publisher.publish(event)`.
3. The injected publisher IS the `ConnectionHub`. `hub.publish(event)` computes recipients: candidate set = the task's `ownerId` and `assigneeId` (the ONLY userIds that can pass authz — no global broadcast). For each candidate with live connections it calls `canAccessTask(event.task, userId)` and, if true, writes the serialized envelope frame to every socket in that user's `Set`.
4. Each subscribed owner/assignee socket receives `{"type":"task.updated","task":{...},"timestamp":"2026-06-10T..."}`. A client subscribed to someone else's feed receives nothing (silent deny, no existence leak — per security-engineer's IDOR rule).
5. Disconnect: socket `close` -> `hub.drop(conn)` removes it from the user's `Set` (and deletes the userId key if the set empties). Heartbeat reaps half-open sockets the same way. Reconnect = fresh handshake + re-subscribe; NO replay (ADR-025 reconnect rationale).

### ADRs (full text in decisions.md)
- **ADR-025: Task->WS Emission Seam = Injected `TaskEventPublisher` Port in `shared/` (constructor-injected into `TasksService`).** Summary: `TasksService` gains `private readonly events: TaskEventPublisher = NOOP_PUBLISHER` (a shared port — pure types, downward dep, no Fastify/WS) and calls `this.events.publish(...)` after a successful create/update/delete. `ConnectionHub` implements `TaskEventPublisher`; `app.ts registerModules` constructs the hub and injects it. Rejected: (a) emit from the ROUTE layer — scatters emission across 3 handlers, misses any non-route caller, leaks event-shape into transport; (b) global EventEmitter singleton — hidden global coupling, untestable, no typed contract, listener leaks; (c) outbox table + poller — at-least-once durability is explicitly out of scope, breaches ADR-018 (no new entity/store) + complexity budget. The injected port keeps ADR-010 downward-only intact, matches the existing DI style, defaults to no-op (197 tests + WS-disabled runs unaffected), and gives the hub one typed entry point.

### Implementation Guidance

**For tech-lead (Phase 2):**
- Pin `@fastify/websocket` to the **Fastify-4 line = v10.x** (v11 requires Fastify 5 — would break ADR-002/frozen stack). Verify `npm ls fastify` shows no transitive Fastify-5 pull; `@fastify/websocket` peer is `fastify@^4`; `npm audit` clean.
- Ratify the hub as a **plain shared singleton constructed in `app.ts registerModules`** (NOT a Fastify decorator) — same precedent/reason as the ADR-005 amendment (plain shared util over plugin decorator: "what executes is what we read", unit-testable without the framework). The hub must be `publish()`-testable with zero Fastify present (the `Connection` structural interface enables this). Only `ws.routes.ts` touches `@fastify/websocket`.
- Confirm no conflict between the hub-singleton lifecycle and security-engineer's chosen auth transport (handshake lives in `ws.routes`, not the hub — they compose).

**For backend-dev (Phase 3):**
- **Refactor 1 (DRY, REQUIRED): move `toTaskResponse` + `interface TaskResponse` from `tasks.routes.ts` into NEW `src/shared/task-serializer.ts`.** `tasks.routes.ts` imports it (behavior identical — re-run tasks integration tests to prove no change). The WS seam imports the SAME function. No second task DTO.
- **Refactor 2 (DRY, REQUIRED): expose a non-throwing predicate from `tasks.policy.ts`.** Today `isOwner`/`isAssignee` are private and only the THROWING `assertCanAccess` is exported — wrong for fan-out (must test-and-skip, not throw). Add `export function canAccessTask(task: Pick<Task,'ownerId'|'assigneeId'>, userId: string): boolean { return isOwner(task,userId) || isAssignee(task,userId); }` and refactor `assertCanAccess` to call it (ONE source of the owner-or-assignee rule, ADR-013 — the hub must NOT re-implement it).
- Add `src/shared/task-events.ts` (port + `TaskEvent` + `NOOP_PUBLISHER`) as specified.
- `TasksService` constructor: add `private readonly events: TaskEventPublisher = NOOP_PUBLISHER`. Call `this.events.publish({ type, task: toTaskResponse(task), timestamp: new Date().toISOString() })` AFTER the repository write succeeds in `create` (`task.created`), `update` (`task.updated`), and `delete` (`task.deleted`). For `delete`, the service already fetched `existing` before `assertIsOwner` — publish using `existing` (the deleted task's last-known shape) so owner/assignee can be notified.
- Build `src/ws/`: `ws.protocol.ts` (Zod frames + `Connection` interface + size cap), `connection-hub.ts` (registry/cap/fan-out/heartbeat/cleanup, implements `TaskEventPublisher`), `ws.routes.ts` (the `@fastify/websocket` plugin: handshake, origin check, frame routing, close-code semantics). NO Prisma anywhere in `src/ws/`. NO Fastify/WS type named in `connection-hub.ts`.
- `app.ts registerModules`: `const hub = new ConnectionHub(); ... new TasksService(tasksRepository, usersRepository, hub);` and `app.register(wsRoutes, { hub })`. ONE hub instance = injected publisher AND the WS plugin's registry.
- **Subscription model (confirms Open Question #2):** a client may subscribe ONLY to its OWN identity's feed; cross-user feed subscription is DENIED. Fan-out does NOT trust the subscription to grant visibility — `canAccessTask` is re-checked on every publish against the live task's owner/assignee. Subscription is a delivery filter; the policy is the gate.
- **Cap enforcement point:** in `hub.register()` BEFORE adding to the set — if `set.size >= 10`, reject (close with security-engineer's chosen code) and do NOT add. Single place the cap lives.
- **Heartbeat/cleanup:** server ping on an interval; mark `isAlive=false` before each ping, set true on pong; a socket still `false` at the next tick is dead -> `drop`. `drop` removes the conn and deletes the userId key when empty (no map leak).

### Risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Service-layer purity erosion: emitting from `tasks.service` tempts future WS/Fastify imports there | Med | High (breaks ADR-010) | Port is pure types in `shared/`; code-quality checks no `ws/`/fastify import in service; ADR-025 documents the rule |
| In-process hub = single-instance ONLY; a 2nd instance silently drops events for clients on the other instance | High (at scale) | High | DOCUMENTED out-of-scope; Redis pub/sub revisit trigger below; consistent with ADR-014/018 in-memory posture |
| `Map`/subscription growth or half-open sockets leak memory | Med | Med | <=10/user cap at register; heartbeat reaper; `drop` deletes empty keys; qa asserts no registry leak after disconnect |
| Slow/backpressured socket stalls `publish()` on the REST write path | Low | Med | `publish` is fire-and-forget per socket (sync `send`, swallow per-socket errors -> drop that socket); never await client I/O on the write path; REST response never depends on delivery |
| `@fastify/websocket` v11 (Fastify-5) accidentally installed | Med | High (build break) | tech-lead pins v10.x + transitive audit (Phase 2) |
| Duplicate task DTO / re-implemented authz (slop) if refactors skipped | Med | Med | Refactors 1 & 2 MANDATORY; code-quality checks DRY |
| Delete event uses last-known task shape (row already gone) | Low | Low | Acceptable — publish from `existing` fetched before delete; documented |

### Scalability Note — Redis pub/sub revisit trigger (consistent with ADR-014/018)
The hub is an **in-process, single-instance** registry by deliberate choice (matches the in-memory rate-limit store ADR-014 and the single-Postgres-store ADR-018 — this codebase is single-instance today). FIRST thing that breaks under horizontal scale: a task mutation handled by instance A cannot reach a subscriber socket held by instance B — events silently disappear for a fraction of clients. **Revisit trigger:** the moment a second app instance / multi-replica deployment is introduced (same trigger as ADR-014 shared rate-limit counters and ADR-018 Redis boundary). Migration path with LOW reversal cost BECAUSE of the port: the `TaskEventPublisher` seam already decouples emission from fan-out — add a `RedisTaskEventPublisher` that publishes to a Redis channel, and have each instance's `ConnectionHub` SUBSCRIBE to that channel and fan out to ITS local sockets. `tasks.service` is untouched (still calls `publisher.publish`); only the `app.ts` wiring and the hub's input source change. No table, no API-contract change. Building Redis now would breach the complexity budget (Principle #4) and the explicit out-of-scope line.

**Next recommended agent**: tech-lead (Phase 2 — pin `@fastify/websocket` v10.x Fastify-4-compatible + transitive/audit; ratify hub-as-plain-singleton vs decorator and the ADR-025 injected-port seam vs ADR-010). security-engineer is parallel in Phase 1.
<!-- /agent: architect -->

---

<!-- agent: tech-lead -->
## Tech-Lead Output — WebSocket Real-Time Task Updates — 2026-06-10
**Status**: DONE. The one approved dependency is pinned to the Fastify-4-compatible line with registry-verified evidence; the architect's ADR-025 emission seam is RATIFIED as ADR-010 compliant (no amendment needed); the plain-singleton hub wiring is RATIFIED against the existing DI convention. ADR-029 authored. No NEEDS_REVIEW conditions (clear choice, MIT-only subtree, no licensing/CVE blocker at decision time).
**Handoff protocol**: agentmemory recall ran (EMPTY for tech-stack/dependency/standards queries — logged fallback). Read decisions.md (my domains: architecture/backend/infrastructure — incl. ADR-002 Fastify-v4, ADR-005-amendment plain-util precedent, ADR-010 layering, ADR-025 seam, ADR-026/027/028 security); read my tagged brief sections (orchestrator plan + architect ADR-025 + security R1-R20); read LIVE: package.json, app.ts:108-131 DI root, tasks.service/urls.service constructors, urls.schemas `.strict()` convention; queried the npm registry for `@fastify/websocket` 10.x/11.x metadata, peer/transitive deps, licenses, and publish dates. remember saved; patterns.md appended.

### Technology Decisions
| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| `@fastify/websocket` major | **v10.x (the Fastify-4 line)** | v11 (latest) | v11 → `fastify-plugin@^5` + tested `fastify@^5` → hard `FST_ERR_PLUGIN_VERSION_MISMATCH` boot failure on our Fastify 4.29.1. v10 → `fastify-plugin@^4` + `fastify@^4.25.0`. |
| Exact pin/range | **`^10.0.1`** (latest v10 patch) | exact `10.0.1`; `^10` | `^10.0.1` stays inside the Fastify-4-safe v10 major; lockfile pins the resolved tree deterministically. Exact pin adds no safety, blocks harmless patches. |
| WS integration approach | **`@fastify/websocket` plugin** | raw `ws` directly | Plugin is the maintained, established Fastify+WS integration the architect's `ws.routes.ts` assumes; raw `ws` would re-hand-roll upgrade/lifecycle. |
| Hub wiring | **plain singleton in `app.ts registerModules`** | Fastify decorator (`app.decorate`) | Matches the verified DI root (app.ts:114-131); decorator has no precedent here + contradicts ADR-005-amendment "plain util over decorator". |
| ADR-025 seam vs ADR-010 | **COMPLIANT — ratified, no amendment** | amend the seam | Service → pure-type `TaskEventPublisher` port in `shared/` is a DOWNWARD dep on the cross-cutting core; never imports `ws/` or Fastify. Textbook dependency inversion. |

### New Dependencies
| Package | Version | License | Purpose | Transitive runtime deps |
|---|---|---|---|---|
| `@fastify/websocket` | `^10.0.1` | MIT | Fastify-4 WebSocket upgrade handling + route integration for `src/ws/ws.routes.ts` | `ws@^8` (MIT, 0 own deps — the WS engine, expected/accepted), `duplexify@^4` (MIT; only ubiquitous MIT/ISC stream utils beneath it), `fastify-plugin@^4` (MIT, 0 runtime deps) |

This is the ONLY new dependency. No surprise runtime transitives, no second WebSocket library, **no Fastify-5 pull**. Entire added subtree is MIT/ISC → no license conflict. v10.0.1 published 2024-03-19 (trips my >2y staleness flag) — EXPECTED & ACCEPTABLE: it is the frozen terminal patch of the Fastify-4 line (upstream moved active dev to v11/Fastify-5), not abandoned; not deprecated. It is the correct intentional pin for this stack.

### Compatibility evidence (registry-verified, not assumed)
- Installed framework: **Fastify 4.29.1** (node_modules) / `^4.28.0` (package.json).
- `@fastify/websocket` has NO package.json Fastify `peerDependencies`; the Fastify-major gate is enforced through its `fastify-plugin` dep. **v10.0.1** → `fastify-plugin@^4.0.0`, devDep `fastify@^4.25.0`. **v11.0.0** → `fastify-plugin@^5.0.0`, devDep `fastify@^5.0.0-alpha.4`. `fastify-plugin@4` throws `FST_ERR_PLUGIN_VERSION_MISMATCH` on Fastify 5+; `fastify-plugin@5` rejects Fastify 4 — so v11 hard-fails at boot on our stack.

### Usage Patterns (for backend-dev / specialists)
- Add `"@fastify/websocket": "^10.0.1"` to `dependencies` (NOT devDependencies) in package.json. Run `npm install`, then commit the updated `package-lock.json`.
- **R20 close-out (Gate-1)**: after install, run `npm ls fastify` → assert a single Fastify 4.29.x and NO Fastify 5 anywhere; run `npm audit` → assert zero High/Critical on the new subtree. (Nothing is installed at this ADR's authoring time, so I did not run these — they are a post-install Gate-1 verification, not a blocker.)
- `@fastify/websocket` (and thus the `WebSocket`/`ws` socket types) is imported ONLY in `src/ws/ws.routes.ts`. `connection-hub.ts` depends on the structural `Connection` interface (ADR-025), never on a Fastify/WS type. NO Prisma anywhere in `src/ws/`.
- Hub wiring in `app.ts registerModules` (mirror the verified pattern): `const hub = new ConnectionHub();` → pass `hub` as the third constructor arg to `new TasksService(tasksRepository, usersRepository, hub)` (a `private readonly events: TaskEventPublisher = NOOP_PUBLISHER` parameter) → `void app.register(wsRoutes, { hub });` (same `app.register(plugin, { deps })` shape as the other five registrations). ONE hub instance = injected publisher AND the WS plugin's registry.

### Coding-standard notes for the `src/ws/` module (tech-lead establishes)
1. **Frame validation via Zod, like every existing schema (ADR-006)**: inbound frames parsed with `.strict()` discriminated-union schemas in `ws.protocol.ts` (mirrors `urls.schemas.ts`/`tasks.schemas.ts` `.strict()` convention — `.strict()` blocks unknown keys, covering the prototype-pollution vector in security R7). Use a guarded safe JSON parse (try/catch) before Zod; never `JSON.parse` an unbounded buffer (R5). Enforce the frame-size cap as a named constant.
2. **No `console.log` / `console.*`**: use the existing Pino logger (`src/shared/logger.ts`) and the `audit()` helper (`src/shared/audit.ts`) only, consistent with the whole codebase. NEVER log the raw token/JWT/PII; `userId` only (security R12); redact a query-param token before it reaches `request.log` (ADR-026/R4).
3. **Error handling**: WS failures map to RFC-6455 close codes (per security-engineer's table: 1008 auth/origin/expiry, 1013 cap, 1008/1009 frame abuse) — NOT to `AppError`→HTTP bodies. Do NOT reuse `authGuard` (HTTP-401 semantics are wrong); reuse `verifyAccessToken` directly. `publish()` is fire-and-forget per socket: synchronous `send`, swallow per-socket errors and drop that socket — the REST write path must never block on or await client delivery (ADR-025 risk row).
4. **Named constants, no magic numbers**: `CODE`-style constants for the 10-conn cap, frame-size cap, heartbeat interval/missed-pong threshold, message-rate cap, DNS-free (no I/O) — same naming discipline code-quality enforced on `src/urls/`.
5. **TypeScript strict stays non-negotiable**: `tsc --noEmit` must exit 0; no `any` on the socket — use the structural `Connection` interface. DRY: reuse the extracted `toTaskResponse` (shared/task-serializer.ts) and `canAccessTask` predicate (tasks.policy.ts) — do NOT duplicate (ADR-025 Refactors 1 & 2; code-quality will reject copies).

### Build Impact
- `package.json`: +1 line in `dependencies` (`@fastify/websocket: ^10.0.1`). `package-lock.json` regenerated by `npm install` (backend-dev). No tsconfig change (the plugin ships its own types; `@fastify/websocket` augments `FastifyInstance`). No vitest.config change (existing `app.inject`/fake-prisma harness + a WS client cover it). No build-step/dev-loop change. `tsc` still exits 0 once the dep is installed and `src/ws/` is implemented to the ADR-025 boundary.

### ADRs Written
- **ADR-029** — Dependency Pin: `@fastify/websocket@^10.0.1` (Fastify-4 line) + ratification of the ADR-025 seam (ADR-010 compliant) and the plain-singleton hub (DI-convention compliant). Full text in decisions.md (tagged backend + infrastructure).

### Verdict: DONE
Conflicts with security's transport choice: NONE — the dependency choice (v10 plugin) and the transport ruling (ADR-026 subprotocol/query-param) compose cleanly; the handshake lives in `ws.routes.ts`, the plugin just provides the upgrade. Conflicts with the architect's seam: NONE — ratified as-is.

**Next recommended agent**: backend-dev (Phase 3) — implement `src/ws/` against architect ADR-025 + security R1-R20 + this pin. Add `"@fastify/websocket": "^10.0.1"` to dependencies, `npm install`, commit `package-lock.json`, then run the R20 gate (`npm ls fastify` = single 4.29.x, no Fastify 5; `npm audit` = 0 High/Critical) and report the result for Gate-1 close-out.
<!-- /agent: tech-lead -->

---

<!-- agent: backend-dev -->
## Backend-Dev Output — WebSocket Real-Time Task Updates — 2026-06-10
**Status**: DONE. `src/ws/` implemented end-to-end against architect ADR-025 + security R1–R20 + tech-lead ADR-029. Both MANDATORY DRY refactors done. `@fastify/websocket@^10.0.1` installed (single `fastify@4.29.1`, no Fastify 5 pull; WS subtree has ZERO audit findings — R20). `tsc --noEmit` exits 0. All 197 pre-existing tests stay GREEN. A throwaway real-server `ws` smoke (run + REMOVED) proved the full chain: subprotocol-token handshake → connect → subscribe → REST `POST /tasks` fans out a correct `task.created` envelope to the owner socket; missing token → close 1008; cap rejects the 11th; cross-user subscribe denied silently; drop cleans empty keys.

**Handoff protocol**: agentmemory recall ran (EMPTY for all four queries — logged fallback). Read decisions.md ADR-005/010/013/014/015/025/026/027/028/029; my tagged WS brief sections (orchestrator plan, security R1–R20 + close-code table, architect ADR-025 + the 2 refactors, tech-lead ADR-029 + coding standards); LIVE source: tasks.{routes,policy,service}, shared/{jwt,auth-context,errors,http,audit,validate,config,logger,csrf}, app.ts DI root, urls/* as template, and the `@fastify/websocket` v10 type surface. remember saved; patterns.md appended.

### Step 2.5 Pre-implementation security scan: NOT clean (recorded, all resolved in implementation)
The WS surface is security-critical (auth boundary + untrusted frames + IDOR on a push channel), so the checklist did NOT trivially pass — every item required thought and is addressed below:
- INPUT VALIDATION: every inbound frame Zod `.strict()`-validated (`clientFrameSchema` discriminated union) behind a guarded safe-JSON-parse + an 8 KB size cap + a 20-msg/10 s rate cap. No URL inputs on this path (no SSRF surface — A10 N/A).
- AUTHENTICATION: `/ws` is intentionally NOT behind `authGuard` (HTTP-401 semantics are wrong); it authenticates on the upgrade via reused `verifyAccessToken` (R1/R2) and closes 1008 on failure. The only "public" pre-auth moment is the upgrade itself, which is gated by the Origin check (R3) + token verify before any registration.
- AUTHORIZATION: per-recipient `canAccessTask` on every fan-out (R13, the IDOR choke point); subscribe pinned to the connection's `sub`, cross-user denied silently (R10). 404-not-403 posture preserved as silent-deny on the push channel (no existence leak).
- DATA EXPOSURE: envelope serialized ONLY via the shared `toTaskResponse` (R14 — no internal columns); generic close reasons, no stack/ID leak (R19).
- EXTERNAL CALLS: none. No secret read here beyond `config.JWT_SECRET` via the reused verify fn; query-param token redacted from the request log (R4).

### Files created
| File | Action | Purpose |
|---|---|---|
| `src/shared/task-serializer.ts` | CREATE | DRY Refactor 1 — `toTaskResponse` + `TaskResponse` moved here; one task wire DTO for BOTH the REST route and the WS seam. |
| `src/shared/task-events.ts` | CREATE | ADR-025 port: `TaskEventType`, `TaskEvent {type,task,timestamp}`, `TaskEventPublisher.publish`, `NOOP_PUBLISHER` default. Pure types — keeps the service dependency downward. |
| `src/ws/ws.protocol.ts` | CREATE | Zod `.strict()` subscribe/unsubscribe frames (discriminated union), size/rate caps as named consts, structural `Connection` interface (no Fastify/ws type). |
| `src/ws/ws.close-codes.ts` | CREATE | RFC-6455 close-code constants (1000/1008/1009/1013) + generic reason (no magic numbers; R19). |
| `src/ws/connection-hub.ts` | CREATE | `ConnectionHub implements TaskEventPublisher`: `Map<userId,Set<Connection>>`, 10/user cap at `register()`, `publish` fan-out = owner/assignee candidates filtered by `canAccessTask` (IDOR choke point), `subscribe`/`unsubscribe` (cross-user silent-deny), `drop` (empty-key cleanup), `heartbeatTick` reaper. Names NO Fastify/ws/Prisma type. |
| `src/ws/ws.handshake.ts` | CREATE | Pure (Fastify-free) handshake logic: `extractToken` (subprotocol preferred, query fallback), `isOriginAllowed` (CSWSH, fail-closed in prod), `authenticateHandshake`, `msUntilExpiry`. Unit-testable. |
| `src/ws/ws.routes.ts` | CREATE | The ONLY `@fastify/websocket` importer: `GET /ws` upgrade, handshake → register/close, frame routing, heartbeat timer (unref), token-expiry close, close/error cleanup, query-param-token log redaction, audit. |

### Files modified
| File | Action | Purpose |
|---|---|---|
| `src/tasks/tasks.routes.ts` | EDIT | Import `toTaskResponse` from the new serializer; removed the local copies (behavior identical — tasks integration tests stay green). |
| `src/tasks/tasks.policy.ts` | EDIT | DRY Refactor 2 — added non-throwing `canAccessTask(task,userId):boolean`; `assertCanAccess` now calls it (ONE source of owner-or-assignee). `assertIsOwner` untouched. |
| `src/tasks/tasks.service.ts` | EDIT | Third ctor arg `events: TaskEventPublisher = NOOP_PUBLISHER`; emits `task.created`/`task.updated`/`task.deleted` after each successful write via a private `emit()`. `delete` publishes the `existing` snapshot (R15). |
| `src/shared/csrf.ts` | EDIT | Exported `resolveRequestOrigin` + `isAllowedOrigin` (reused by the WS CSWSH check, ADR-027 DRY); `csrfOriginGuard` refactored onto them (HTTP behavior unchanged). |
| `src/shared/audit.ts` | EDIT | +5 WS audit actions (`ws.connect`, `ws.auth_failure`, `ws.cap_exceeded`, `ws.frame_abuse`, `ws.token_expired`). |
| `src/app.ts` | EDIT | `const connectionHub = new ConnectionHub()` injected into `TasksService` (publisher) AND `app.register(wsRoutes, { hub: connectionHub })` — one instance, mirrors the existing DI root. |
| `package.json` | EDIT | `"@fastify/websocket": "^10.0.1"` added to dependencies. |
| `package-lock.json` | EDIT | Regenerated by `npm install` (kept). |

### R1–R20 implementation map (every item satisfied)
| R | Requirement | Where / How |
|---|---|---|
| R1 | Authenticate every upgrade via reused `verifyAccessToken`; pin `userId=sub` | `ws.handshake.authenticateHandshake` → `ws.routes` builds the connection with `result.payload.sub` |
| R2 | No second verify path / no alg relax; close (no HTTP body) on fail | Reuses `verifyAccessToken` only (HS256 pinned upstream); failure → `socket.close(1008)` |
| R3 | Origin allowlist on upgrade; **fail-closed in production** when empty/unlisted | `ws.handshake.isOriginAllowed`: empty allowlist → `!config.isProduction`; reuses `csrf.isAllowedOrigin`/`resolveRequestOrigin` |
| R4 | Subprotocol preferred + query-param fallback; **redact token from logs** | `extractToken` (`access_token.<jwt>` first); `redactTokenFromRequestLog` onRequest hook strips `?...` from the logged URL; audit uses `userId` only |
| R5 | Zod-validate every frame; safe JSON parse | `safeParseJson` (try/catch) → `clientFrameSchema` (closed `.strict()` discriminated union) |
| R6 | Max 10 conns/user, checked AT handshake; reject 11th (1013) | `ConnectionHub.register` (size-check before insert) → `socket.close(1013)` |
| R7 | Frame size cap (8 KB) + msg-rate cap; close on abuse | `MAX_FRAME_BYTES` (also `ws` `maxPayload`), `exceedsRate` (20/10 s) → close 1009/1008 |
| R8 | Deterministic cleanup on close AND error | `socket.on('close'|'error')` → `hub.drop` (idempotent) |
| R9 | Heartbeat ping/pong reaper | `heartbeat` setInterval (30 s, unref) → `hub.heartbeatTick(ping)`; `pong` sets `isAlive=true`; not-alive → close+drop |
| R10 | Subscribe own-feed-only; cross-user denied silently | `hub.subscribe` returns silently if `requestedUserId !== connection.userId` |
| R11 | Bounded registry growth; no global broadcast | per-user `Set`; fan-out candidates = owner/assignee only; `drop` deletes empty keys |
| R12 | Audit connect/auth-fail/cap/frame-abuse/token-exp via `audit()`, userId only | 5 `audit(...)` call sites with the new AUDIT_ACTION values; never logs token/PII |
| R13 | Per-recipient owner-or-assignee on EVERY event (IDOR) | `hub.publish` → `canAccessTask(event.task, userId)` per candidate (reused predicate, not duplicated) |
| R14 | Envelope `task` via existing `toTaskResponse`; `{type,task,timestamp}` ISO8601 | `tasks.service.emit` builds it with `toTaskResponse` + `new Date().toISOString()` |
| R15 | `task.deleted` authz on mutation-time snapshot | `delete` captures `task = assertIsOwner(existing,...)` then `emit('task.deleted', task)` after the row is gone |
| R16 | Read/subscribe-only; reject mutation frames | only `subscribe`/`unsubscribe` in the closed union — anything else fails the schema and is ignored |
| R17 | Free all resources on forced close | `drop` (registry slot), `clearInterval` (heartbeat, onClose), `clearTimeout` (expiry timer, on socket close) |
| R18 | Bound lifetime by token `exp`; close 1008 at expiry | `scheduleExpiryClose(msUntilExpiry(payload))` (unref; cleared if socket closes first) |
| R19 | Generic close reasons; no existence/internal leak | single `WS_CLOSE_REASON='policy violation'`; malformed frames ignored silently, no error frame |
| R20 | Fastify-4 plugin + clean audit | `^10.0.1` installed; `npm ls fastify` = single `4.29.1`; `npm audit` WS subtree (websocket/ws/fastify-plugin) = 0 findings (pre-existing bcrypt/vitest/fastify findings are NOT in the added subtree) |

### Build / test status
- `npx tsc --noEmit`: **exit 0**.
- `npm test`: **197 passed / 197** (13 files), 0 failed, 0 flaky — unchanged from the pre-feature baseline (the `NOOP_PUBLISHER` default + identical-behavior refactors are transparent).
- `npm ls fastify` → single `fastify@4.29.1`. `@fastify/websocket@10.0.1`, `fastify-plugin@4.5.1`, `ws@8.21.0`. ESLint has no repo config (pre-existing; not introduced here) — `tsc` strict is the type gate.

### Test targets for qa-engineer (target >95% on src/ws/)
- **Hub unit** (`connection-hub.ts`, no Fastify — use a stub `Connection`): register up to 10 → `'registered'`, 11th → `'cap-exceeded'` (not added); `publish` delivers to owner + assignee subscribers, NOT to a stranger (IDOR), NOT to unsubscribed sockets; `publish` with `assigneeId===ownerId` de-dupes; `publish` for `task.deleted` authorizes against the passed snapshot; `subscribe(conn,'other')` leaves `subscribed=false` (silent deny), `subscribe(conn,conn.userId)`/`subscribe(conn)` sets it true; `drop` removes the socket and deletes the empty userId key (`connectionCount`→0); a throwing `send` drops only that socket; `heartbeatTick` closes+drops a `isAlive=false` socket and pings the survivors (sets `isAlive=false`).
- **Handshake unit** (`ws.handshake.ts`, mock nothing but env): `extractToken` subprotocol-preferred / query-fallback / none; `isOriginAllowed` — empty allowlist returns `!isProduction` (set `config.isProduction` via a NODE_ENV re-import like csrf.test.ts), non-empty allowlist matches/rejects; `authenticateHandshake` ok with a real HS256 token, `reason:'auth'` on bad/missing token, `reason:'origin'` on disallowed origin; `msUntilExpiry` floors at 0 for an expired token.
- **Protocol unit** (`ws.protocol.ts`): `clientFrameSchema` accepts `{type:'subscribe'}` (+ optional `userId`), rejects unknown `type`, rejects extra keys (`.strict()` — incl. `__proto__`), rejects a mutation-shaped frame.
- **Routes integration** (real server via `app.listen({port:0})` + a `ws` client, fake-prisma, NODE_ENV=test → empty allowlist so dev-skip lets the handshake through; for the R3 prod path, re-import config with `isProduction`): valid subprotocol token → open + `ws.connect` audit; missing/garbage token → close **1008** + `ws.auth_failure`; 11th concurrent socket for one user → close **1013** + `ws.cap_exceeded`; subscribe then `POST /tasks` (owner) → receives `task.created` with `{type,task:{...},timestamp}` ISO8601; assignee receives the owner's `task.updated`/`task.created` for an assigned task; stranger subscribed → receives NOTHING; `PATCH`/`DELETE` fan out `task.updated`/`task.deleted` (delete reaches owner+assignee via snapshot); oversized frame (>8 KB) → close **1009**; >20 frames/10 s → close 1008 + `ws.frame_abuse`; malformed/non-JSON/unknown-type frame → ignored, socket stays open; client close → registry cleaned (`connectionCount` 0); `?token=<jwt>` fallback connects AND the token does not appear in logs (assert via a captured logger). Use `injectWS` only if you switch to a listening server — plain `app.inject` cannot drive the upgrade.
- **Service emission unit** (`tasks.service.ts` with a fake publisher): create/update/delete each call `publish` once with the right `type` and a `toTaskResponse`-shaped task + ISO timestamp; delete publishes the pre-delete snapshot; a no-arg `TasksService(tasks, users)` (NOOP default) does NOT throw on mutation (regression guard for the 197 existing tests).

### Open Items
None.

### Verdict: DONE
<!-- /agent: backend-dev -->

---

<!-- agent: qa-engineer -->
## QA-Engineer Output — WebSocket Real-Time Task Updates — 2026-06-10
**Status**: DONE — full `src/ws/` + shared-seam suite written, suite GREEN, coverage targets MET (>95% on `src/ws/` AND on both new shared files), all 197 pre-existing tests still pass, zero flaky (verified across 3 consecutive runs). NO bugs found in `src/ws/` — backend-dev's R1-R20 implementation holds up to adversarial test. Verdict differs from the URL-shortener phase: that one found a High SSRF bypass; this WS surface is clean.
**Handoff protocol**: agentmemory recall ran (EMPTY for all four qa queries — test-pattern/bug-regression/security-test/integration-mock; logged fallback). Read my tagged WS brief sections (orchestrator plan, security R1-R20 + close-code table, architect ADR-025, backend-dev R1-R20 impl map + enumerated test targets); read LIVE source under `src/ws/` (connection-hub, ws.handshake, ws.protocol, ws.close-codes, ws.routes), `src/shared/{task-events,task-serializer,csrf,jwt,audit,config}.ts`, `src/tasks/{tasks.policy,tasks.service}.ts`, `src/app.ts`; read existing conventions: `src/test/{fake-prisma,setup}.ts`, `vitest.config.ts`, `src/urls/urls.routes.integration.test.ts` (app.inject + fake-prisma + mocked-audit pattern), `src/shared/csrf.test.ts` (vi.resetModules + env override for prod config). remember + patterns.md appended.

### Files written (all NEW; no source edited — no test-infra edit needed: fake-prisma already had the `task` delegate)
| File | Type | Tests | What it covers |
|---|---|---|---|
| `src/ws/ws.protocol.test.ts` | unit | 12 | `clientFrameSchema` accept (subscribe ± userId, unsubscribe) + reject (unknown type, mutation-shaped frame R16, extra keys/`__proto__` R7, empty userId, missing type, non-object); cap constants pinned (8 KB / 20 / 10 s) |
| `src/ws/ws.close-codes.test.ts` | unit | 2 | RFC-6455 code map (1000/1008/1009/1013) + single generic reason (R19) — contract the integration suite asserts on the wire |
| `src/ws/connection-hub.test.ts` | unit | 25 | register cap R6 (up-to-10, 11th `cap-exceeded` not added, per-user independent); subscribe/unsubscribe own-feed R10 (cross-user silent-deny); publish fan-out R13 (owner-only, owner+assignee not stranger, unsubscribed skipped, all-of-a-user's-sockets, owner===assignee de-dupe, task.deleted snapshot R15, no-recipient no-throw, throwing-send drops only that socket R8); drop R8/R11/R17 (empty-key delete, idempotent, no-op on unknown, keeps key while sibling remains); heartbeatTick R9 (missed-pong close+drop, survivor ping+mark-not-alive, two-tick reap); connectionCount(unknown)=0 |
| `src/ws/ws.handshake.test.ts` | unit | 21 | `extractToken` R4 (subprotocol preferred, pick among several, query fallback, prefer-subprotocol, fallback-when-no-prefix, empty/none); `isOriginAllowed` R3/ADR-027 (empty-allowlist dev-skip vs **prod fail-closed**, allowlisted, rejected, referer-derived, missing-both); `authenticateHandshake` R1/R2/R3 (valid subprotocol+query, origin-reason, auth-reason missing/invalid/**expired**); `msUntilExpiry` R18 (positive, floored-at-0). Prod branch via vi.resetModules + NODE_ENV re-import (csrf.test.ts pattern); real HS256 tokens (no crypto mock) |
| `src/ws/ws.routes.integration.test.ts` | integration | 19 | REAL `buildApp()` + `app.listen({port:0})` + a real `ws` client (app.inject CANNOT drive the upgrade — see HARNESS note). Handshake R1-R4 (subprotocol accept+ws.connect audit, query accept, no-token→1008+ws.auth_failure, garbage→1008, expired→1008); cap R6 (11th→1013+ws.cap_exceeded); fan-out R13/R14/R15 (owner gets task.created w/ {type,task,timestamp ISO8601}; assignee gets assigned task, stranger gets NOTHING; cross-user subscribe→no delivery R10; task.updated+task.deleted to owner incl. delete-snapshot; unsubscribed→nothing; stop-after-unsubscribe); frame validation R5/R7/R16 (malformed-non-JSON ignored+stays-open, unknown-type ignored, oversized→close, >20/window→1008+ws.frame_abuse); token-expiry R18 (1s TTL→1008+ws.token_expired); disconnect cleanup R8/R17 (slot freed after close→reconnect accepted); query-token redaction R4 (token never in any audit field) |
| `src/tasks/tasks.service.emission.test.ts` | unit | 6 | Emission seam ADR-025/R14/R15: create/update/delete each publish once w/ correct type + `toTaskResponse`-shaped task + ISO8601 timestamp; delete publishes pre-delete snapshot (owner+assignee); NO publish when create-validation or delete-authz fails; **NOOP default does not throw** (regression guard for the 197) |

### Test counts (REAL — `npx vitest run`)
- New this task: **85** (src/ws unit 60 = protocol 12 + close-codes 2 + hub 25 + handshake 21; src/ws integration 19; tasks emission 6).
- Global suite: **282 passed / 282 (19 files), 0 failed, 0 skipped, 0 flaky** (was 197 / 13 files pre-feature — all 197 prior tests remain GREEN, unchanged).

### Coverage (REAL — `npx vitest run --coverage`, v8)
| File | % Lines | % Branch | % Funcs | Uncovered |
|---|---|---|---|---|
| `src/ws/` (module) | **98.46** | **96.96** | **100** | — (exceeds the >95% target) |
| `src/ws/connection-hub.ts` | 99.00 | 97.61 | 100 | L124-125 (per-recipient `canAccessTask`-false `continue`) |
| `src/ws/ws.handshake.ts` | **100** | **100** | **100** | none |
| `src/ws/ws.protocol.ts` | **100** | **100** | **100** | none |
| `src/ws/ws.close-codes.ts` | **100** | **100** | **100** | none |
| `src/ws/ws.routes.ts` | 96.85 | 94.73 | 100 | L174-177 (socket `error` handler — drop+close on a transport error), L210-212 (rate-window reset after 10 s idle) |
| `src/shared/task-events.ts` | **100** | **100** | **100** | none |
| `src/shared/task-serializer.ts` | **100** | **100** | **100** | none |
| `src/tasks/tasks.policy.ts` | **100** | **100** | **100** | none (incl. new `canAccessTask`) |
| `src/tasks/tasks.service.ts` | 99.46 | 88.46 | 100 | L119 (pre-existing update branch, not WS) |
| **Global gate (floor)** | **98.74 lines (≥80 ✓)** | **95.57 branch (≥70 ✓)** | 98.56 funcs | Gate 3 GREEN |

**Uncovered-line justification (3 residual, all deliberate — none worth a contrived/slow test):**
- `connection-hub.ts:124-125` — the per-recipient `if (!canAccessTask) continue` is **defense-in-depth that is unreachable via the public API**: `candidateRecipients` only ever yields the task's `ownerId`/`assigneeId`, both of which ALWAYS pass `canAccessTask`. It is a correct second gate (if a future change widened the candidate set, this line stops an IDOR), not dead code, and cannot be exercised without breaking the invariant it protects. Asserted-by-construction, not by a fake.
- `ws.routes.ts:174-177` — the socket `'error'` handler (drop + close on a low-level transport error). Cannot be deterministically triggered through a real `ws` client without faking an internal socket error; the parallel `'close'` cleanup path IS covered (disconnect-cleanup test) and `drop` is exhaustively unit-tested.
- `ws.routes.ts:210-212` — `exceedsRate` window-reset, only taken when >10 s elapse between frames. I WROTE a covering integration test, then REMOVED it: it required a real 10.5 s wall-clock sleep, which is a fast-suite/perf anti-pattern for one low-value defensive branch. `exceedsRate` is a private fn (can't unit-test in isolation) and the rate-CAP path (the security-relevant half) is fully covered by the frame-abuse test. Documented trade-off, not an oversight.

### R1-R20 → test map (for security-engineer Gate-1 re-verify)
| R | Requirement | Verifying test(s) | Status |
|---|---|---|---|
| R1 | Authenticate every upgrade via `verifyAccessToken`; pin userId=sub | handshake `authenticateHandshake` valid subprotocol/query (asserts `payload.sub`); integration subprotocol/query accept | TESTED |
| R2 | No second verify path / no alg relax; close (no HTTP body) on fail | handshake invalid/expired→`reason:'auth'`; integration garbage/expired→**1008** (close frame, not HTTP) | TESTED |
| R3 | Origin allowlist; **fail-closed in prod** | handshake `isOriginAllowed` empty-prod=false, allowlisted/rejected/referer/missing; `authenticateHandshake` origin-reason | TESTED |
| R4 | Subprotocol preferred + query fallback; **redact token from logs** | handshake `extractToken` 7 cases; integration query-accept + **token-not-in-any-audit-field** redaction test | TESTED |
| R5 | Zod-validate every frame; safe JSON parse | protocol accept/reject; integration malformed-non-JSON ignored + stays open | TESTED |
| R6 | Max 10/user at handshake; reject 11th (1013) | hub register cap (3 tests); integration 11th→**1013**+ws.cap_exceeded | TESTED |
| R7 | Frame size cap + msg-rate cap; close on abuse | protocol cap constants; integration oversized→close, >20/window→**1008**+ws.frame_abuse | TESTED |
| R8 | Deterministic cleanup on close AND error | hub drop (idempotent, empty-key, throwing-send-drops-one); integration slot-freed-after-close | TESTED (error-path = unit-level via throwing send + drop idempotency; the route `'error'` handler line is the one uncovered defensive line) |
| R9 | Heartbeat ping/pong reaper | hub heartbeatTick (missed-pong close+drop, survivor ping, two-tick reap) | TESTED |
| R10 | Subscribe own-feed-only; cross-user silent-deny | hub subscribe/unsubscribe cross-user (4 tests); integration cross-user-subscribe→no delivery | TESTED |
| R11 | Bounded registry; no global broadcast | hub fan-out candidates=owner/assignee only; drop empty-key delete; connectionCount assertions | TESTED |
| R12 | Audit connect/auth-fail/cap/frame-abuse/token-exp, userId only | integration asserts ws.connect / ws.auth_failure / ws.cap_exceeded / ws.frame_abuse / ws.token_expired emitted | TESTED (all 5 actions) |
| R13 | Per-recipient owner-or-assignee on EVERY event (IDOR headline) | hub publish owner/assignee/stranger (6 tests); integration assignee-receives + **stranger-receives-nothing** | TESTED |
| R14 | Envelope task via `toTaskResponse`; {type,task,timestamp} ISO8601 | emission test exact-shape equality + ISO8601 regex; integration timestamp ISO assert | TESTED |
| R15 | task.deleted authz on mutation-time snapshot | emission delete-snapshot (owner+assignee); hub task.deleted snapshot; integration delete→owner | TESTED |
| R16 | Read/subscribe-only; reject mutation frames | protocol reject mutation-shaped/unknown-type; integration unknown-type ignored, stays open | TESTED |
| R17 | Free all resources on forced close | hub drop empty-key; integration slot-freed (heartbeat/expiry timers are `unref`+cleared — verified by clean `app.close()` with no hang) | TESTED |
| R18 | Bound lifetime by token exp; close 1008 at expiry | handshake `msUntilExpiry`; integration 1s-TTL→**1008**+ws.token_expired | TESTED |
| R19 | Generic close reasons; no existence/internal leak | close-codes single 'policy violation' reason; integration malformed frames ignored silently (no error frame) | TESTED |
| R20 | Fastify-4 plugin + clean audit | `npm ls` confirms ws@8.21.0 / @fastify/websocket@10.0.1 / fastify@4.29.1 single; (npm audit owned by backend-dev/Gate-1 close-out) | VERIFIED (versions) |

### Bugs found
**NONE.** Every R1-R20 control behaves as specified under adversarial test (no-token, garbage token, expired token, 11th connection, cross-user subscribe, stranger fan-out, oversized frame, frame flood, malformed JSON, mutation-shaped frame, disconnect-reconnect). The IDOR choke point (R13) correctly delivers to owner+assignee and silently denies strangers; the auth handshake closes 1008 (never an HTTP body); the cap closes 1013; token redaction keeps the JWT out of audit. No bug list to pin/route to backend-dev or security.

### Flaky tests found
**NONE.** Determinism controls: hub/protocol/close-codes/emission are pure synchronous unit tests (stub `Connection`, mocked publisher — no timers, no network, no randomness). Handshake uses real HS256 tokens + injectable `nowMs` for `msUntilExpiry` (no Date.now race) and the csrf.test.ts vi.resetModules pattern for the prod branch. Integration uses a fresh `buildApp()` + ephemeral port + fresh fake-store per test; each assertion awaits an explicit socket event (`open`/`close`/`message`) rather than a fixed sleep, except short settle-ticks for negative ("no event") assertions; suite verified GREEN across 3 consecutive runs (85/85 each).

### HARNESS note (documented per the task)
`app.inject` CANNOT drive a WebSocket upgrade (it has no real socket); per backend-dev's HANDOFF_NOTES the integration suite boots a listening server (`app.listen({port:0, host:'127.0.0.1'})`) and connects with the real `ws` client (`ws@8`, already in the tree as a transitive dep of `@fastify/websocket`). This required `@types/ws@^8.18.1` as a **devDependency** (type stubs only, matches the installed `ws@8.21.0`; mirrors the existing `@types/jsonwebtoken`/`@types/bcrypt` dev-type-stub pattern). This is the ONLY package added — it is dev-only types for a package already present, NOT a new runtime dependency, so it is inside the tech-lead constraint (only `@fastify/websocket` may be added at runtime). `package.json` devDependencies + `package-lock.json` updated. `npx tsc --noEmit` exits 0.

**Next recommended agent**: security-engineer / quality-lead — Gate-1 re-verify against the R1-R20 → test map above (all 20 TESTED/VERIFIED, IDOR/auth/CSWSH/cap/frame-validation/redaction all proven), then quality-lead Gate-4. Gate 3 (coverage >95% on src/ws/ + new shared files; ≥80/70 global; 282 tests green; zero flaky) is GREEN. One Gate-1 close-out item remains for backend-dev/devops: run `npm audit` post-install and confirm zero High/Critical on the @fastify/websocket subtree (R20 — versions verified; audit is the explicit close-out step the security/tech-lead sections reserved).
<!-- /agent: qa-engineer -->

---

<!-- agent: code-quality -->
## Code-Quality Output — WebSocket Real-Time Task Updates — 2026-06-10

**Scope reviewed**: `src/ws/{ws.routes,ws.handshake,connection-hub,ws.protocol,ws.close-codes}.ts`, `src/shared/{task-events,task-serializer}.ts`, and the `canAccessTask`/`assertCanAccess` delegation in `src/tasks/tasks.policy.ts`. `tsc --noEmit` exit 0. AI-slop scanner (`scripts/check-slop.ps1`) CLEAN on both `src/ws` and `src/shared`.

### BASELINE_COMPARISON
```
Coverage: NOT MEASURED THIS RUN (no src/ws/ or src/shared/task*.test.ts files exist yet —
  qa-engineer Phase 4 runs in parallel and has not landed the suite).
  Baseline: 98.74% line / 95.0% branch (thresholds 90 / 85).
  Delta: PENDING — Gate 3 (coverage) is qa-engineer's gate, deferred to quality-lead.
  ACTION FOR quality-lead: do NOT issue Gate-4 SHIP IT until qa-engineer's src/ws/ coverage
  lands at >95% (backend-dev's target) and global stays >=90/85. backend-dev enumerated the
  exact test targets in its brief section.

Complexity (all reviewed files are NEW — not in baseline; standard thresholds applied):
  No file exceeds the LOW band (0-30 complexity_points/file) or the 300-line warning.
  Top file: connection-hub.ts ~31 pts across 9 small methods (each method CC<=5); largest
    single function = ws.routes.handleFrame at CC 7. No outlier vs the existing 36-file set
    (cf. baseline MEDIUM files fake-prisma 64 / url-safety 57 — nothing here approaches that).
  No existing baseline file's complexity changed (the 3 edits — tasks.policy, tasks.routes,
    csrf — are DRY extractions that hold or reduce complexity; tasks.policy gained one tiny
    pure predicate, assertCanAccess shrank to delegate to it).
```

### Metrics Summary
| File | Lines | Baseline Lines | Functions | Max CC | Baseline CC | Delta | Issues |
|------|-------|----------------|-----------|--------|-------------|-------|--------|
| src/ws/ws.routes.ts | 287 | NEW | 9 | 7 (handleFrame) | — | new | 0 |
| src/ws/ws.handshake.ts | 117 | NEW | 4 | 5 (extractToken) | — | new | 0 |
| src/ws/connection-hub.ts | 203 | NEW | 9 | 5 (sendToUser) | — | new | 0 |
| src/ws/ws.protocol.ts | 92 | NEW | 0 (types/schemas) | 1 | — | new | 0 |
| src/ws/ws.close-codes.ts | 23 | NEW | 0 (consts) | 1 | — | new | 0 |
| src/shared/task-events.ts | 51 | NEW | 1 (no-op) | 1 | — | new | 0 |
| src/shared/task-serializer.ts | 45 | NEW | 1 | 1 | — | new | 0 |
| src/tasks/tasks.policy.ts | 84 | 62 | 5 | 2 | 12 pts | DRY-neutral | 0 |

Per-function CC (every function measured): all <= 7, well under the <=10 pass bar and the >15 P1 bar. Highest: `ws.routes.handleFrame` = 7 (size-cap, rate-cap, safe-parse, schema-result, type-dispatch — all load-bearing security branches, not incidental). `connection-hub.sendToUser` = 5, `ws.handshake.extractToken` = 5. No function over 40 lines. No file over 300 lines.

### Layer integrity — VERIFIED (all four claims hold)
| Claim | Result | Evidence |
|---|---|---|
| Only `ws.routes.ts` imports `@fastify/websocket`/`ws` | PASS | grep: the sole `import ... '@fastify/websocket'` is ws.routes.ts:1; protocol.ts mentions are doc-comments only |
| `connection-hub.ts` names NO Fastify/`ws`/Prisma type | PASS | operates on the structural `Connection` (ws.protocol.ts); `heartbeatTick`/`send`/`close` are injected callbacks; the `as WsConnectionState` cast that bridges to the real socket lives in ws.routes.ts, not the hub |
| No Prisma in `src/ws/` | PASS | grep `@prisma/client`/`PrismaClient` in src/ws → 0 hits. `Task` type enters only via the shared `TaskResponse` DTO + the `Pick<Task,...>` in the reused policy predicate |
| `tasks.service` depends only on the shared port, not on `ws/` | PASS | imports `../shared/task-events` (port) + `../shared/task-serializer` only; never `../ws/...`. ConnectionHub is injected at the app.ts composition root |

### DRY — reuse is REAL, not duplicated (both mandatory refactors confirmed)
- **Refactor 1 (`toTaskResponse`)**: single definition in `src/shared/task-serializer.ts`. `tasks.routes.ts` imports it (4 call sites; no inline `.toISOString()` serialization remains) and `tasks.service.emit` imports it for the WS envelope. ONE task wire DTO — no second `TaskResponse`.
- **Refactor 2 (`canAccessTask`)**: single owner-or-assignee predicate in `tasks.policy.ts`, built from `isOwner`/`isAssignee`. `assertCanAccess` delegates to it (`!task || !canAccessTask(...)`), and `ConnectionHub.publish` calls it directly per recipient (non-throwing — correct for fan-out). The hub does NOT re-implement the rule. The R13 IDOR choke point reuses the same predicate the REST 404-not-403 path uses — exactly the architecture security-engineer required.

### AI slop / dead code / naming / errors / comments
- **AI slop scanner**: CLEAN (0 P1, 0 P2) on src/ws and src/shared. Manual review of the 10 slop patterns: NONE present. No single-delegation wrappers, no single-impl interface-for-its-own-sake (`TaskEventPublisher` has a real second impl — `NOOP_PUBLISHER` — and a genuine inversion-of-control purpose), no speculative generality, no async-without-await, no empty/swallowing catches that hide errors.
- **Error handling**: the two `catch {}` blocks are deliberate and correct, not swallowing: `safeParseJson` returns `undefined` on malformed JSON (R5 — frame is then ignored), and `authenticateHandshake` maps a verify throw to `{ok:false,reason:'auth'}` (R2/R19 — generic close, no HTTP body). `sendToUser`'s `catch` drops the failed socket (R8). All three are documented with the rule they satisfy. No external/DB call on the WS path lacks handling (there are none).
- **Magic numbers**: none in logic — all RFC-6455 codes (`WS_CLOSE`), caps (`MAX_FRAME_BYTES`, `MAX_FRAMES_PER_WINDOW`, `FRAME_RATE_WINDOW_MS`, `MAX_CONNECTIONS_PER_USER`), and `HEARTBEAT_INTERVAL_MS` are named consts.
- **Dead code**: none. `result.subprotocol` is intentionally unused at the call site (the `ws` server echoes the subprotocol automatically per RFC 6455) and that is documented at ws.routes.ts:93-96 — acceptable (it is part of the typed handshake result the unit tests assert on), see P3.
- **Naming**: self-documenting throughout (`exceedsRate`, `candidateRecipients`, `heartbeatTick`, `redactTokenFromRequestLog`, `scheduleExpiryClose`). Consistent with the existing `src/tasks`/`src/shared` conventions.
- **Comments**: explain WHY (the security rule Rn, the RFC behavior, the deviation from the HTTP guard) — not WHAT. Excellent quality; no restating-the-code noise.

### P1 Findings (blocks shipping)
None.

### P2 Findings (document, ship)
None.

### P3 Notes
- ws.routes.ts:93-96 — `result.subprotocol` is computed by the handshake but not consumed at the route (the `ws` server auto-echoes). Documented; harmless. Could drop it from `HandshakeResult` if the unit tests don't assert on it — defer to qa-engineer's suite shape; not worth a change now.
- connection-hub.ts — `connectionCount()` is a test/diagnostic seam with no production caller yet. Justified (enables the hub's unit tests without exposing the private map); leave as-is.
- Coverage for src/ws/ is unverified at this gate (qa-engineer parallel) — tracked above as the only open Gate-3 dependency, not a code-quality defect.

### Verdict: CLEAN
Gate 2 (Code Quality) **PASS**. Zero P1, zero P2. Complexity, layer integrity, DRY reuse, naming, error handling, and comment quality all meet standard. The WS module is a genuinely thin, well-bounded transport adapter over a testable structural hub — no AI slop. No fix list for backend-dev to clear. Gate-2 is GREEN independent of Gate-3 (coverage), which remains qa-engineer's to land before quality-lead's Gate-4 SHIP IT.
<!-- /agent: code-quality -->

---

<!-- agent: quality-lead -->
## Quality-Lead Output — WebSocket Real-Time Task Updates — 2026-06-10

**VERDICT: SHIP IT.** Gates 1-4 all GREEN. All numbers below were observed by me on this machine (re-ran the suite, coverage, tsc, npm audit, and read the three security-critical source files myself). I did not copy the reports — I reproduced them.

### Independent Verification (numbers I observed, not copied)
| Check | Command I ran | Result I observed | qa/backend claim | Match |
|---|---|---|---|---|
| Tests | `npx vitest run --coverage` | **282 passed / 282 (19 files), 0 failed, 0 skipped**; exit 0 | 282/282 | ✓ |
| Build | `npx tsc --noEmit` | **exit 0** (zero TS errors) | exit 0 | ✓ |
| Coverage — src/ws module | v8 report | **98.46% line / 96.96% branch / 100% func** | 98.46 / 96.96 | ✓ |
| Coverage — global | v8 report | **98.74% line / 95.57% branch** | 98.74 / 95.57 | ✓ |
| ws.handshake / ws.protocol / task-events / tasks.policy | v8 report | **100% line+branch** each | 100% | ✓ |
| Single Fastify major | `npm ls fastify` | **fastify@4.29.1** (single; no Fastify 5) | single 4.29.1 | ✓ |
| R20 audit — WS subtree | `npm audit --json` | **ZERO advisories** in @fastify/websocket/ws/fastify-plugin/duplexify | 0 in subtree | ✓ |
| @types/ws placement | read package.json | **devDependencies** (`^8.18.1`) — NOT a runtime dep | dev-only | ✓ |

Coverage exceeds BOTH the SHIP threshold (90 line / 85 branch) AND the >95%-on-new-code feature target. Global floor (CLAUDE.md 80/70) cleared with wide margin.

### Source read independently (controls confirmed REAL in code, not just claimed)
- **`connection-hub.ts` — R13 IDOR choke point**: `publish()` restricts recipients to `candidateRecipients` = owner + assignee ONLY (no broadcast), then applies `canAccessTask(event.task, userId)` per recipient (L122-126), then `sendToUser` gates again on `connection.subscribed`. The predicate is the REUSED `tasks.policy.canAccessTask` (import L1) — not duplicated. R6 cap checked before insert (L44-55); R10 cross-user subscribe silently denied (L68-73); R8/R11/R17 `drop` deletes empty user key, idempotent (L98-107). CONFIRMED.
- **`ws.handshake.ts`**: reuses `verifyAccessToken` (R1/R2, HS256 pinned upstream, no second verify path); `isOriginAllowed` FAILS CLOSED in production on empty allowlist (R3/ADR-027, L66-71); subprotocol-preferred token extraction (R4); fail-closed `catch` → generic reason (R2/R19); `msUntilExpiry` floored at 0 (R18). CONFIRMED.
- **`ws.routes.ts`**: `/ws` registered with NO authGuard — auth is on the upgrade via `authenticateHandshake` (correct WS semantics). Auth fail → `close(1008)` no HTTP body (L79); cap → `close(1013)` (L89); token query-param redacted from Pino via onRequest hook before logging (L278-286); R7 size→1009 / rate→1008+audit; R5/R16 malformed/unknown/mutation frames ignored silently; R8/R17 cleanup on close AND error; R9 heartbeat unref+cleared; R18 expiry close scheduled. CONFIRMED.
- **`ws.close-codes.ts`**: 1000/1008/1009/1013 per RFC 6455, single generic 'policy violation' reason (R19). CONFIRMED.

### Gate Sequence
- **Gate 1 — Security (REQUIRED)**: SECURITY_REVIEW=REQUIRED, SECURITY_STATUS=DONE. security-engineer threat model (R1-R20, ADR-026/027/028) DONE with zero blocking findings (all 10 findings were forward requirements). **Gate-1 CLOSE-OUT re-verify (the item security-engineer reserved): I confirmed each of R1-R20 is implemented (read the source) AND tested (qa's R1-R20→test map: all 20 TESTED/VERIFIED). The headline IDOR (WS-01/R13), auth-on-upgrade (WS-02/R1-R2), cross-user subscribe (WS-03/R10), CSWSH fail-closed (WS-04/R3), token redaction (WS-05/R4), frame validation (WS-06/R5,R7), conn-cap (WS-07/R6) are all closed in code and exercised by tests.** The one explicitly-reserved close-out (R20 `npm audit` on the WS subtree) I ran myself: ZERO advisories in the added subtree. **Gate 1: GREEN, no unresolved HIGH.**
- **Gate 2 — Code Quality**: code-quality CLEAN, 0 P1 / 0 P2. Max function CC=7 (handleFrame, all load-bearing security branches), no file >300 lines, slop scanner clean, layer integrity (4/4) and DRY reuse verified. **Gate 2: GREEN.**
- **Gate 3 — Coverage**: 282/282 green, 0 flaky (qa verified 3x reruns), src/ws 98.46/96.96 (>95% target met), global 98.74/95.57 (≥90/85 met). The 3 uncovered lines are documented deliberate defensive branches (hub:124-125 unreachable second-gate authz, ws.routes:174-177 socket-error handler, 210-212 rate-window reset) — I accept the justification: the rate-CAP and close-cleanup security halves ARE covered; none is a coverage gap on a security-relevant happy path. **Gate 3: GREEN.**
- **Gate 4 — Final Approval**: all of Gates 1-3 resolved, fix list empty. **SHIP IT.**

### P1 Findings (block ship)
**NONE.**

### P2 Findings (document, ship)
**NONE** for the WebSocket feature.

### P3 Notes (record; do not block)
| ID | Source | Finding | Routed to |
|---|---|---|---|
| QL-WS-P3-1 | quality-lead (audit run) | Repo carries **12 PRE-EXISTING npm-audit advisories (2 critical / 7 high / 3 moderate)** in bcrypt(node-pre-gyp/tar) / vitest(esbuild) / fastify(fast-json-stringify) chains. NOT introduced by this feature (ZERO in the WS subtree) and outside this gate's scope, so they do not block the WS SHIP IT. But they are real systemic debt the WS feature merely surfaced. | orchestrator → maintainability/devops sprint (separate work item) |
| QL-WS-P3-2 | code-quality (carried) | `result.subprotocol` computed but unused at the route (ws auto-echoes per RFC 6455); `connectionCount()` is a test/diagnostic seam. Both justified; no change. | none |

### Decision rationale
Every SHIP IT criterion is true and independently verified: tests 100% pass, tsc exit 0, new-code coverage exceeds the >95% target and the 90/85 SHIP threshold, zero P1 from any reviewer, security Gate-1 (incl. the reserved R20 audit close-out) cleared with no unresolved HIGH, code-quality CLEAN. The IDOR choke point — the single load-bearing risk of a push channel — is a per-recipient reuse of the same `tasks.policy` predicate the REST 404-not-403 path uses, confirmed in code and exercised by both unit and integration tests (stranger-receives-nothing). Nothing here violates the definition of done.

**VERDICT: SHIP IT.** Next: tech-writer (Phase 6) may document the SHIPPED behavior.
<!-- /agent: quality-lead -->

---

<!-- agent: tech-writer -->
## Tech-Writer Output — WebSocket Real-Time Task Updates — 2026-06-10

### Documents Updated
| Document | Changes made | Examples verified |
|---|---|---|
| `docs/api.md` | New "WebSocket — Real-Time Task Updates" section (+ ToC entry). Documents `/ws` endpoint, both auth transports (subprotocol preferred / `?token=` fallback + leak caveat), connection lifecycle (10-conn cap, 30s heartbeat, expiry close, 8KB/20-per-10s frame limits, no replay), subscribe/unsubscribe frames, `{type,task,timestamp}` envelope, owner-or-assignee fan-out, close codes (1000/1008/1009/1013), wscat + browser examples. ADR rationale carried as "Why" notes. | Frame shapes, envelope, close codes, transports verified against source (not spec) — see below. |
| `CHANGELOG.md` | New `[1.2.0] — 2026-06-10` entry (Added / Security / Notes) written for users; added `[1.2.0]` link-ref. | n/a (prose) |
| `package.json` | `version` 1.1.0 → 1.2.0 (lockstep with CHANGELOG heading). | n/a |

### Documented strictly from SHIPPED source (house rule: source, not spec)
- **Path:** `/ws` — `app.get('/ws', { websocket: true }, ...)` in `ws.routes.ts`; registered in `app.ts:139` (no prefix, no authGuard — auth is on the upgrade). Documented as `ws://localhost:3000/ws`.
- **Auth transports:** `ws.handshake.ts extractToken` — subprotocol `access_token.<jwt>` PREFERRED, `?token=` fallback; subprotocol wins if both present. RFC-6455 auto-echo (no explicit echo in route). Documented the redaction + leak caveat (ADR-026).
- **Origin:** fail-closed in production / empty-allowlist skip in dev (`isOriginAllowed`). Reuses `CORS_ORIGINS` — NO new env var. Documented (ADR-027).
- **Frames:** `ws.protocol.ts` — strict Zod discriminated union of `subscribe`/`unsubscribe`, optional `userId`; `MAX_FRAME_BYTES = 8KB`, `MAX_FRAMES_PER_WINDOW = 20`, `FRAME_RATE_WINDOW_MS = 10s`. Malformed/unknown/mutation frames silently ignored.
- **Envelope:** `task-events.ts` `{ type: task.created|updated|deleted, task: TaskResponse, timestamp: ISO }`; `task` = identical wire shape to REST (`task-serializer.ts`). Deleted-task snapshot documented.
- **Fan-out / IDOR:** `connection-hub.ts` — owner+assignee candidates only (never broadcast), per-recipient `canAccessTask`, subscribe-own-feed-only (cross-user silently denied), 10-conn cap. Documented as the IDOR model per quality-lead's handoff note.
- **Close codes:** `ws.close-codes.ts` — 1000 normal, 1008 ALL security rejections (auth/origin/rate/expiry), 1009 oversize, 1013 cap. Generic reason. Documented exactly.

### Flagged non-obvious behavior (in docs)
- Silent cross-user subscribe denial (no ack/error — no feed-existence leak).
- No replay buffer on reconnect (ephemeral, in-process) — must re-subscribe.
- 1008 is overloaded for all security rejections by design (generic, R19).
- Query-param token leak caveat + production must set `CORS_ORIGINS` or all upgrades refused.

### CHANGELOG Entry
Added `[1.2.0] — 2026-06-10` with Added (WS real-time updates, subscribe-own-feed, two auth transports), Security (authenticated+origin-checked+expiry-closed connections, query-param log redaction, no-IDOR fan-out, abuse/resource limits), Notes (in-process single-instance, no replay — ADR-025).

### New .env.example Variables
None. The feature reuses existing `CORS_ORIGINS` (WS CSWSH allowlist) and `ACCESS_TOKEN_TTL` (governs WS connection lifetime). `.env.example` left unchanged.

### Verification note
curl/wscat examples were NOT executed against a live instance this run (no running server/wscat in this session). They are constructed directly from the verified source contracts (path, transports, frame shapes, envelope) and the existing tested REST examples. The protocol details are source-accurate; a live smoke-run is recommended at deploy time. Documentation is additive — no NEEDS_REVIEW condition hit (no contradiction in source).

### Verdict: DONE
<!-- /agent: tech-writer -->

---

## RECEIPTS — WebSocket Real-Time Task Updates

<!-- receipt: security-engineer -->
AGENT: security-engineer
STATUS: DONE
TIER: 3
COMPLETED: WebSocket pre-implementation STRIDE threat model + Gate-1 requirements checklist (R1–R20) + 3 ADRs
KEY_DECISIONS:
- WS auth transport (ADR-026): subprotocol preferred, query-param allowed ONLY with mandatory log redaction
- CSWSH (ADR-027): reuse CORS allowlist on upgrade but FAIL CLOSED in production (deviates from HTTP csrf skip-on-empty)
- Fan-out authz (ADR-028): subscribe-own-feed-only + per-recipient owner-or-assignee predicate REUSED from tasks.policy (no duplication) — closes the headline IDOR
BLOCKERS: none — no code exists, zero blocking findings; all 10 findings are forward requirements
RECOMMENDED_NEXT: architect — proceed Phase 1 in parallel; backend-dev MUST satisfy R1–R20 in Phase 3; security re-verify at Gate-1 close-out
HANDOFF_NOTES: I claimed ADR-026/027/028 — architect must NOT reuse these (architect owns ADR-025). backend-dev: export a NON-THROWING boolean predicate from tasks.policy.ts for the hub (R13) — do NOT duplicate isOwner/isAssignee and do NOT use assertCanAccess (throws 404). Do NOT reuse authGuard for the handshake (HTTP-401 semantics wrong) — use verifyAccessToken + WS close 1008. For task.deleted, capture owner/assigneeId snapshot at mutation time (R15). Cap WS frame at ~8KB (not the 1MB HTTP limit). Use close-code table.
<!-- /receipt: security-engineer -->

<!-- receipt: architect -->
AGENT: architect
STATUS: DONE
TIER: 3
COMPLETED: WebSocket Real-Time Task Updates — src/ws/ boundary + task->hub emission seam design (ADR-025)
KEY_DECISIONS:
- Emission seam = injected `TaskEventPublisher` PORT in `src/shared/task-events.ts`, constructor-injected into TasksService (defaults to NOOP_PUBLISHER); ConnectionHub implements it. Keeps ADR-010 downward-only (service never imports ws/ or Fastify). Rejected: route-layer emit, global EventEmitter, outbox table.
- ConnectionHub = plain in-process singleton, Map<userId,Set<Connection>>, <=10/user cap at register(), single fan-out + IDOR choke point: publish() sends only to owner/assignee userIds where reused tasks.policy.canAccessTask(task,userId)===true (NOT a broadcast). Hub names NO Fastify/WS type (structural Connection interface in ws.protocol.ts).
- In-process single-instance ONLY (matches ADR-014/018 in-memory posture); Redis pub/sub revisit trigger = a 2nd app instance; migration is low-cost because the port already decouples emit from fan-out. Reconnect = stateless re-subscribe, NO replay buffer (out of scope).
BLOCKERS: none
RECOMMENDED_NEXT: tech-lead — pin @fastify/websocket v10.x (Fastify-4 line; v11 needs Fastify 5) + transitive/audit check; ratify hub-as-plain-singleton (vs decorator) and the ADR-025 injected-port seam vs ADR-010.
HANDOFF_NOTES: TWO mandatory DRY refactors for backend-dev: (1) move toTaskResponse + TaskResponse from tasks.routes.ts to NEW src/shared/task-serializer.ts (both route + hub import it — no 2nd DTO); (2) export non-throwing canAccessTask(task,userId):boolean from tasks.policy.ts and have assertCanAccess call it (ONE source of owner-or-assignee, ADR-013 — hub must NOT re-implement). ADR numbers: architect=025, security-engineer=026/027/028 (confirmed in-brief, no collision). publish() must be fire-and-forget per socket (never await client I/O on the REST write path).
<!-- /receipt: architect -->

<!-- receipt: tech-lead -->
AGENT: tech-lead
STATUS: DONE
TIER: 4
COMPLETED: Phase 2 — pin @fastify/websocket + ratify ADR-025 seam & hub wiring (WebSocket feature)
KEY_DECISIONS:
- Pin @fastify/websocket ^10.0.1 (Fastify-4 line). v11 → fastify-plugin@^5 + fastify@^5 → boot-fail (FST_ERR_PLUGIN_VERSION_MISMATCH) on installed Fastify 4.29.1. ONLY new dep; MIT-only subtree; expected transitive ws@^8; no Fastify-5 pull. Registry-verified. ADR-029 authored.
- ADR-025 emission seam RATIFIED as ADR-010 compliant: tasks.service depends on the pure-type TaskEventPublisher port in shared/ (downward dep, no ws/ or Fastify import) — no amendment needed.
- Hub-as-plain-singleton RATIFIED vs Fastify decorator: matches the verified app.ts:114-131 DI root (new X(); inject; app.register(plugin,{deps})); decorator has no precedent + contradicts ADR-005-amendment.
BLOCKERS: none
RECOMMENDED_NEXT: backend-dev — implement src/ws/ against ADR-025 + security R1-R20; add "@fastify/websocket": "^10.0.1" to dependencies, npm install, commit package-lock.json, then run R20 gate (npm ls fastify = single 4.29.x / no Fastify 5; npm audit = 0 High/Critical).
HANDOFF_NOTES: Use the EXACT range ^10.0.1 (NOT v11/latest — v11 hard-fails at boot on Fastify 4). @fastify/websocket imported ONLY in ws.routes.ts; hub uses the structural Connection interface, no Prisma in src/ws/. Frame validation via Zod .strict() (ADR-006 convention); no console.log (Pino + audit only, userId-only, redact query-param token); WS failures → RFC-6455 close codes not HTTP bodies; publish() fire-and-forget per socket. tsc must stay exit 0; no tsconfig/vitest change. R20 npm audit is a post-install Gate-1 close-out item (nothing installed at decision time).
<!-- /receipt: tech-lead -->

<!-- receipt: backend-dev -->
AGENT: backend-dev
STATUS: DONE
TIER: 3
COMPLETED: src/ws/ WebSocket real-time task updates — full R1-R20 implementation + both DRY refactors + @fastify/websocket pin
KEY_DECISIONS:
- Single ConnectionHub (implements TaskEventPublisher) injected into TasksService AND wsRoutes via app.ts; fan-out is the IDOR choke point — per-recipient canAccessTask over owner/assignee candidates only (R13), never a broadcast.
- Handshake logic extracted into a Fastify-free ws.handshake.ts (token extract + Origin fail-closed-in-prod + verify + msUntilExpiry) so ws.routes.ts stays a thin transport adapter and every security branch is unit-testable; ws.routes.ts is the ONLY @fastify/websocket importer.
- Both mandatory refactors done with zero behavior change: toTaskResponse → shared/task-serializer.ts; non-throwing canAccessTask added to tasks.policy.ts (assertCanAccess now delegates to it). 197 tests stay green via the NOOP_PUBLISHER default.
BLOCKERS: none
RECOMMENDED_NEXT: qa-engineer ‖ code-quality (Phase 4) — qa writes the src/ws/ suite (>95%, targets enumerated in my brief section, real-server ws client for the upgrade path); code-quality reviews complexity/DRY/layer-integrity/slop. Then security-engineer re-verifies Gate-1 (R1-R20) and quality-lead issues Gate-4.
HANDOFF_NOTES: @fastify/websocket@^10.0.1 installed; `npm ls fastify` = single 4.29.1 (no Fastify 5); WS subtree (websocket/ws/fastify-plugin) has ZERO npm-audit findings — the 12 pre-existing findings are in bcrypt(node-pre-gyp/tar)/vitest/esbuild/fastify's own fast-json-stringify chain, NOT introduced by this change (verified by diffing the pre-/post-install audit). tsc exit 0; no tsconfig/vitest change. WS auth is on the UPGRADE (verifyAccessToken), NOT authGuard — /ws is registered without the guard hook by design. Integration tests MUST use a listening server (app.listen({port:0})) + a real `ws` client to drive the upgrade; plain app.inject cannot (app.injectWS needs a listening server too). For the R3 prod-fail-closed branch, re-import config with NODE_ENV=production like csrf.test.ts does. The query-param token is redacted from request logs by an onRequest hook in ws.routes.ts (R4) — assert it via a captured logger.
<!-- /receipt: backend-dev -->

<!-- receipt: qa-engineer -->
AGENT: qa-engineer
STATUS: DONE
TIER: 3
COMPLETED: src/ws/ + shared-seam Vitest suite (85 new tests) — WebSocket Real-Time Task Updates; Gate 3 GREEN, R1-R20 mapped
KEY_DECISIONS:
- 85 new tests (60 src/ws unit + 19 src/ws integration + 6 tasks emission). Global 282/282 GREEN, all 197 prior unchanged, 0 flaky (3x reruns). src/ws coverage 98.46% lines / 96.96% branch (>95% target MET); both new shared files (task-events, task-serializer) 100%; tasks.policy 100% incl. new canAccessTask.
- Integration suite drives a REAL ws client over app.listen({port:0}) because app.inject cannot perform a WS upgrade (backend-dev's documented harness). Pure-sync stub Connection + injectable nowMs + csrf.test.ts resetModules pattern keep everything deterministic.
- ZERO bugs found — every R1-R20 control verified under adversarial test (no/garbage/expired token, 11th conn, cross-user subscribe, stranger fan-out, oversized/flood/malformed/mutation frames). No pinning regression needed (unlike the URL-shortener phase).
BLOCKERS: none
RECOMMENDED_NEXT: security-engineer / quality-lead — Gate-1 re-verify via the R1-R20→test map (all TESTED/VERIFIED); then quality-lead Gate-4 SHIP IT. Gate 3 is GREEN.
HANDOFF_NOTES: Added `@types/ws@^8.18.1` as a DEV dependency ONLY (type stubs for ws@8.21.0 already in the tree as a @fastify/websocket transitive — mirrors @types/jsonwebtoken/@types/bcrypt; NOT a new runtime dep, inside the tech-lead constraint). package.json devDeps + package-lock.json updated; tsc exit 0. 3 uncovered defensive lines are DELIBERATE & documented in my brief section: hub:124-125 (unreachable per-recipient authz second gate — candidates are always owner/assignee), ws.routes:174-177 (socket 'error' handler, can't deterministically fault a real socket), ws.routes:210-212 (rate-window reset — removed a 10.5s real-sleep test as a fast-suite anti-pattern; the rate-CAP path IS covered). R20 npm-audit on the @fastify/websocket subtree remains the explicit Gate-1 close-out step for backend-dev/devops (versions verified: single fastify@4.29.1).
<!-- /receipt: qa-engineer -->

<!-- receipt: code-quality -->
AGENT: code-quality
STATUS: DONE
TIER: 3
COMPLETED: Gate-2 review of src/ws/ (5 files) + src/shared/{task-events,task-serializer} + tasks.policy DRY delegation — WebSocket Real-Time Task Updates
KEY_DECISIONS:
- CLEAN verdict: 0 P1 / 0 P2. Max function CC = 7 (ws.routes.handleFrame); all functions <=7, no file >300 lines; slop scanner CLEAN on src/ws + src/shared; tsc exit 0.
- Layer integrity all 4 claims VERIFIED: @fastify/websocket only in ws.routes.ts; hub names no Fastify/ws/Prisma type (structural Connection); no Prisma in src/ws/; tasks.service imports only the shared port, never ws/.
- DRY reuse REAL not duplicated: one toTaskResponse (shared/task-serializer, used by route + service), one canAccessTask (tasks.policy — assertCanAccess delegates to it, hub.publish calls it per-recipient = the R13 IDOR choke point).
BLOCKERS: none
RECOMMENDED_NEXT: quality-lead — Gate-2 GREEN; issue Gate-4 SHIP IT ONLY after qa-engineer's src/ws/ coverage (Gate 3) lands (>95% on src/ws/, global >=90/85). Also pending security-engineer Gate-1 R1-R20 re-verify.
HANDOFF_NOTES: Coverage was NOT measured this run — no src/ws/ or src/shared/task*.test.ts exist yet (qa-engineer Phase 4 parallel). BASELINE_COMPARISON coverage delta = PENDING on qa. The two empty-looking catch blocks (safeParseJson, authenticateHandshake) are deliberate fail-closed handlers (R5/R2/R19), NOT swallowing — do not flag. result.subprotocol unused at the route is intentional+documented (ws auto-echoes per RFC 6455) — P3 only. No code-quality fix list for backend-dev.
<!-- /receipt: code-quality -->

<!-- receipt: quality-lead -->
AGENT: quality-lead
STATUS: DONE
TIER: 4
COMPLETED: Gate-4 final gate for WebSocket Real-Time Task Updates — Gates 1-4 independently verified; SHIP IT
KEY_DECISIONS:
- SHIP IT. Independently reproduced (not copied): 282/282 tests pass, tsc exit 0, src/ws 98.46% line / 96.96% branch, global 98.74/95.57 — exceeds the >95% feature target AND the 90/85 SHIP threshold. Zero P1/P2 from any reviewer.
- Gate-1 close-out re-verified myself: read connection-hub/ws.handshake/ws.routes — R13 IDOR (per-recipient reused canAccessTask over owner/assignee only), R1-R2 auth-on-upgrade (verifyAccessToken not authGuard, close 1008), R3 CSWSH fail-closed-in-prod, R4 token redaction, R6 cap (close 1013) all REAL in code + tested. Ran `npm audit` myself: ZERO advisories in the @fastify/websocket subtree (R20 close-out satisfied).
- @types/ws confirmed dev-only (devDependencies); @fastify/websocket the sole runtime dep; single fastify@4.29.1 (no Fastify 5).
BLOCKERS: none
RECOMMENDED_NEXT: tech-writer — Phase 6: document the SHIPPED WS behavior (connect URL + subprotocol/query auth transport, subscribe protocol, {type,task,timestamp} envelope, close codes 1000/1008/1009/1013, 10-conn/user cap, wscat example) from source; CHANGELOG entry + package.json minor bump (1.1.0 → 1.2.0).
HANDOFF_NOTES: SHIP IT is scoped to the WebSocket feature only. P3 systemic debt surfaced (do NOT let it gate WS, but route it): repo has 12 PRE-EXISTING npm-audit advisories (2 critical/7 high/3 moderate) in bcrypt(node-pre-gyp/tar)/vitest(esbuild)/fastify(fast-json-stringify) — ZERO in code added by this feature — orchestrator should open a separate maintainability/devops work item. 3 uncovered src/ws lines are documented deliberate defensive branches (hub:124-125 unreachable second-gate authz; ws.routes:174-177 socket-error handler; 210-212 rate-window reset) — accepted, the security-relevant halves are covered. tech-writer: document the IDOR model accurately (subscribe-own-feed-only + owner-or-assignee fan-out) and note auth is on the upgrade, not a header.
<!-- /receipt: quality-lead -->

<!-- receipt: tech-writer -->
AGENT: tech-writer
STATUS: DONE
TIER: 2
COMPLETED: WebSocket Real-Time Task Updates docs — docs/api.md WS section + CHANGELOG [1.2.0] + package.json 1.1.0→1.2.0
KEY_DECISIONS:
- Documented EXACTLY from shipped source (ws.routes/handshake/protocol/connection-hub/task-events/task-serializer/app.ts), not the spec: /ws path, subprotocol-preferred + ?token= fallback (RFC-6455 auto-echo), 8KB/20-per-10s frame caps, 10-conn cap, close codes 1000/1008/1009/1013, owner-or-assignee fan-out, {type,task,timestamp} envelope.
- Carried ADR rationale as "Why" notes: ADR-026 (subprotocol preferred + token-leak/redaction), ADR-027 (origin fail-closed in prod), ADR-028 (subscribe-own-feed + per-recipient owner/assignee IDOR model), ADR-025 (in-process, no replay).
- No new .env vars — WS reuses CORS_ORIGINS + ACCESS_TOKEN_TTL; .env.example unchanged. package.json kept in lockstep with CHANGELOG heading (1.2.0).
BLOCKERS: none
RECOMMENDED_NEXT: none — Phase 6 (final) complete; orchestrator may close the feature. (Optional: live wscat smoke-run of the documented examples at deploy time.)
HANDOFF_NOTES: curl/wscat examples were built from verified source contracts but NOT run against a live server this session (no running instance/wscat available) — flagged in the brief section; protocol details are source-accurate. P3 systemic debt noted by quality-lead (12 pre-existing npm-audit advisories, NOT from this feature) is out of scope for docs — orchestrator should route it to maintainability/devops as a separate item.
<!-- /receipt: tech-writer -->

<!-- receipt: orchestrator -->
AGENT: orchestrator
STATUS: NEEDS_REVIEW
TIER: 1
COMPLETED: WebSocket Real-Time Task Updates — task decomposition + agent routing + brief.md persisted (Hierarchy Execution Log rows, SECURITY header, section tags, 8 PENDING receipts)
KEY_DECISIONS: |
  - architect + tech-lead RETAINED (NOT collapsed): WS is a genuinely new component boundary (connection hub + task->push seam) AND @fastify/websocket is a real new dependency — both ADR-level/dep triggers; the URL-shortener "collapse leads" pattern does NOT apply.
  - data-lead/db-engineer SKIPPED: no schema/entity/migration (events are ephemeral, derived from existing task mutations).
  - Reuse verifyAccessToken (transport-agnostic) for the WS handshake, NOT authGuard (HTTP-401 semantics + browsers can't set WS headers); IDOR-on-fan-out reuses the tasks.policy owner-or-assignee rule.
BLOCKERS: Orchestrator cannot spawn subagents in this environment (no Task/Agent tool — verified). Did NOT implement. Main loop must execute the phases.
RECOMMENDED_NEXT: security-engineer ‖ architect (Phase 1, parallel) — then tech-lead (P2) -> backend-dev (P3) -> qa-engineer ‖ code-quality (P4) -> quality-lead (P5) -> tech-writer (P6).
HANDOFF_NOTES: |
  cannot spawn — main loop should execute. Run Phase 1 first (security-engineer ‖ architect), each doing the BEFORE/AFTER handoff protocol and filling its pre-created tag section + receipt. Gate 1 (security) is MANDATORY and must be STATUS: DONE before backend-dev (Phase 3) writes any code. Hard dependency order: architect (boundary) -> tech-lead (dep pin ratifies the boundary) -> backend-dev. Do NOT let backend-dev add any dependency other than @fastify/websocket without a tech-lead escalation. The query-param JWT leak and the IDOR-on-fan-out are the two load-bearing security decisions — do not let backend-dev pick the transport unilaterally.
<!-- /receipt: orchestrator -->

<!-- agent: devops -->
## DevOps P2 Fix

**Status**: DONE — both tasks complete and verified (`npm run build` succeeds, `dist/server.js` emitted, entry-point chain internally consistent).

### Task P2.4 — Node.js 20 → 22 LTS
Node 20 is past its maintenance window; bumped to the current LTS (22).
- `package.json` `engines.node`: `>=20.0.0` → `>=22.0.0`.
- `.nvmrc`: **CREATED** with content `22` (did not exist; added for local-dev parity).
- ADR-001 amended in `decisions.md` (2026-06-09) documenting the runtime bump + rationale.
- **No app code changed** — no Node-20-specific APIs in use. Only the runtime floor moved; broader dependency upgrades remain the maintainability agent's domain (untouched here).

### Task P2.5 — package.json entry-point fix (resolves the long-standing defect flagged by tech-writer/architect)
Real entry point confirmed as `src/server.ts` (compiles to `dist/server.js` per tsconfig `outDir:./dist`, `rootDir:./src`). Fixed the broken `index`/`index.js` references:
- `main`: `dist/index.js` → `dist/server.js`
- `scripts.start`: `node dist/index.js` → `node dist/server.js`
- `scripts.dev`: `tsx watch src/index.ts` → `tsx watch src/server.ts` (`tsx` confirmed in devDependencies `^4.15.0`)
- `scripts.build`: `tsc` — left unchanged (already correct; emits to `dist/`).
- Consistency check: `npm run build` produces `dist/server.js`, so `npm start` now resolves. `npm run dev` now targets the real source file. **The defect documented in README/runbook "Known Gaps" is now resolved** — those docs can drop the workaround note (tech-writer follow-up, non-blocking).

### Expected files ABSENT (reported, not created per instructions)
- **No Dockerfile** anywhere in the repo → nothing to bump from `node:20-*`. (tech-writer also flagged this; devops recommends a committed multi-stage Dockerfile + docker-compose later.)
- **No `.github/workflows/*.yml|*.yaml`** → no `node-version: 20` to update.
- **No pre-existing `.nvmrc`** → created (allowed/encouraged by task).
- Note: `package-lock.json` still contains `"node": ">=20.0.0"` engine entries from transitive deps — these are dependency-owned, regenerate on next `npm install` under Node 22, and are out of scope for this runtime bump.

### Files changed
1. `C:\Users\Ferzan Bilek\agentcorp-v2\package.json` — engines.node, main, scripts.start, scripts.dev.
2. `C:\Users\Ferzan Bilek\agentcorp-v2\.nvmrc` — NEW, content `22`.
3. `C:\Users\Ferzan Bilek\agentcorp-v2\context\decisions.md` — ADR-001 amendment.

**Report**: DONE → recommended non-blocking follow-up: tech-writer removes the entry-point "Known Gaps" workaround from README/runbook now that it is fixed; future devops sprint adds Dockerfile + CI workflow (both currently absent).
<!-- /agent: devops -->

<!-- agent: tech-writer -->
## Tech-Writer P2 Fix

**Status**: DONE — CHANGELOG created for the 1.0.0 release; obsolete entry-point workaround removed from README + runbook; Node version references bumped to 22 LTS. All edits verified accurate against the now-fixed package.json.

### CHANGELOG created
- `CHANGELOG.md` (created) — Keep a Changelog format, SemVer. Single entry **[1.0.0] — 2026-06-09** (initial release). Sections: Added (accounts/auth, tasks, profile, API surface — 10 endpoints), Security (object-level authz/no-IDOR, refresh reuse detection, generic auth errors, bcrypt/HS256/helmet/CORS/audit), Notes/Known limitations (single-instance rate-limit + token store per ADR-014/018; no Dockerfile/CI yet). Written for users (behavior, not code internals). No invented features — every line maps to implemented behavior in the brief.

### Doc workarounds removed (now genuinely fixed by devops P2.5)
Verified package.json first: `main`=`dist/server.js`, `start`=`node dist/server.js`, `dev`=`tsx watch src/server.ts`, `engines.node`=`>=22.0.0`. The entry-point workaround is obsolete, so removed it:
- `README.md`: removed the "Note on the entry point" callout after the Run-the-API step (the `index.ts`/`dist/index.js` mismatch note + workaround pointer). Standard `npm run dev` / `npm start` now stand on their own.
- `docs/runbook.md`: removed (1) the "If `npm run dev` cannot find the entry file → run `npx tsx watch src/server.ts`" note in Local Dev Setup step 8; (2) the `dev script cannot find index.ts` row in the common-failure-modes table; (3) the `dist/index.js` workaround aside in the Production Deployment step 4 (now states `npm start` runs `node dist/server.js`); (4) the entry-point item from the Known Gaps section.
- Known Gaps section renumbered: removed item #1 (entry-point). KEPT the two still-valid gaps — no docker-compose/Dockerfile, and in-memory single-instance rate limiting (Redis before horizontal scale, ADR-014). The README `#known-gaps` cross-reference (for the no-compose gap) is intact and still resolves.

### Node version references updated (devops bumped engine to 22)
- `README.md` Prerequisites: "Node.js 20 LTS … `v20.x`" → "Node.js 22 LTS … `v22.x`"; "(ships with Node 20)" → "(ships with Node 22)".
- `docs/runbook.md` Local Dev Setup: Prerequisites "Node.js 20 LTS" → "22 LTS"; step-1 expected output `v20.x.x` → `v22.x.x` and "older than 20 … install Node 20 LTS" → "older than 22 … install Node 22 LTS".
- No other "Node 20" references remain in README/runbook (the only remaining `Node 20` strings are in brief.md/decisions.md/node_modules — out of scope).

### Files written/updated
- `CHANGELOG.md`: changelog | created | documents the 1.0.0 initial release for users.
- `README.md`: updated | removed entry-point workaround note, bumped Node 20 → 22 LTS.
- `docs/runbook.md`: updated | removed 4 entry-point workaround mentions + Known Gaps item, bumped Node 20 → 22 LTS, renumbered Known Gaps (2 valid gaps retained).

### Gaps found
- None new. The entry-point defect (previously the top documentation gap) is now genuinely resolved in package.json and de-documented. Remaining known limitations (no Dockerfile/CI, single-instance rate limiting/token store) are accurately retained in CHANGELOG + runbook Known Gaps for future devops follow-up.

**Report**: DONE.
<!-- /agent: tech-writer -->

<!-- agent: qa-engineer -->
## QA-Engineer Output (Health Endpoint)

**Status**: DONE — added exactly ONE test for the enhanced `GET /health`; full suite green 99/99 (was 98), 0 regressions, coverage gate holds. Ran as general-purpose standing in for qa-engineer (subagent type unavailable in registry). agentmemory recall + remember both succeeded.

**Test file**: `src/health.integration.test.ts` (NEW). Co-located as a `*.integration.test.ts` per the vitest convention; matches `tasks.routes.integration.test.ts` setup — `const fake = createFakePrisma()` + `vi.mock('./shared/prisma', ...)`, `buildApp()` via dynamic `await import('./app')` in `beforeEach`, `app.close()` in `afterEach`. No live PostgreSQL.

**Test name**: `should_return_200_with_status_timestamp_and_version_when_health_checked` (single `it(...)`, one file). No auth header sent (locks in that /health stays public).

**Assertions** (all per spec):
- `response.statusCode === 200`
- `body.success === true`
- `body.data.status === 'ok'`
- `body.data.version === APP_VERSION` (imported from `./shared/version` — NOT hardcoded; tracks package.json = 1.0.0)
- `body.data.timestamp` valid ISO8601: `new Date(ts).toISOString() === ts`

**Full-suite result** (`npx vitest run --coverage`): **99/99 pass**, 8 test files, 0 fail, 0 flaky. (Was 98 before this test.) Duration ~4.4s.

**Coverage (v8, thresholds PASS, exit 0)**:
- Lines **98.37%** (target 80) · Branches **93.95%** (target 70) · Functions **97.43%** (target 80) · Statements **98.37%** (target 80).
- The new test lifted `src/shared/version.ts` to 100% line/branch and `app.ts` /health route to covered. Pre-existing sub-80 files unchanged: `users.schemas.ts` 72.41% line / `users.routes.ts` 81.08% (out of scope; global gate passes with wide margin).

**Source/other tests modified**: NONE (additive — one new file only).

**Flaky tests**: none.

**Report**: DONE.
<!-- /agent: qa-engineer -->

<!-- agent: backend-dev -->
## Backend-Dev Output (Health Endpoint)

**Status**: DONE — `GET /health` enhanced to return `status` + `timestamp` (ISO8601) + `version` (from package.json). `tsc --noEmit` exit 0; verified live via `app.inject` (200, correct body); no regression to the existing 98-test suite import graph. agentmemory recall ran (empty for this topic); remember saved (see below).

**What changed**:
- `src/app.ts:46-58` — the `/health` handler. Was `reply.send({ success: true, data: { status: 'ok' } })`. Now uses the shared `ok()` envelope helper and returns the three contract fields under `data`:
  ```ts
  reply.send(ok({ status: 'ok', timestamp: new Date().toISOString(), version: APP_VERSION }))
  ```
  Added a comment noting it is the public, pre-auth liveness probe. Route position unchanged — still registered in `buildApp()` BEFORE the auth guard, so it stays public (no auth).
- `src/app.ts:13-14` — added two imports: `ok` from `./shared/http` and `APP_VERSION` from `./shared/version`.
- `src/shared/version.ts` — NEW FILE (single responsibility: expose `APP_VERSION`). Reads `version` from `package.json` at runtime.

**Response shape chosen** (documented per instruction): wrapped in the existing `{ success: true, data }` envelope via `ok(...)`, NOT a bare `{ status, timestamp, version }`. Rationale: every other endpoint in the API uses the shared `ok()` envelope (see `shared/http.ts`); a bare body would be the one inconsistent endpoint and would break the uniform-contract guarantee QA asserts elsewhere. The brief's contract (`status`/`timestamp`/`version`) is satisfied with all three fields living under `data`. Exact verified body:
`{"success":true,"data":{"status":"ok","timestamp":"2026-06-09T09:22:32.719Z","version":"1.0.0"}}`

**How version is read (no hardcoding)**: `src/shared/version.ts` uses `createRequire(__filename)('../../package.json')` to load `package.json` at runtime and exports `APP_VERSION = manifest.version`. Why runtime require instead of a compile-time `import pkg from '../../package.json'`: tsconfig sets `rootDir: ./src` and `include: src/**/*`, so importing a file ABOVE `src` would break the build (TS "not under rootDir") and shift the `dist` layout. `resolveJsonModule` is on, but the rootDir constraint makes the static JSON import unsafe; `createRequire` keeps `package.json` out of the TS program while still being a clean, typed (`PackageManifest`) single-source read. Version is therefore never duplicated — it tracks `package.json` (currently 1.0.0).

**Constraints honored**: unauthenticated (registered before guard, unchanged); no side effects (pure read + timestamp); single responsibility (version isolated in its own module); minimal diff (1 new ~10-line file + 1 handler edit + 2 imports); no new abstraction beyond the version constant.

**Verification**: `npx tsc --noEmit` exit 0. A throwaway `app.inject` vitest smoke (since removed — qa owns the permanent test) returned `200` and the exact body above; `version` resolved to `1.0.0` from package.json, `timestamp` round-trips through `new Date().toISOString()`. Full existing suite still collects cleanly (98 tests, 0 import errors) under vitest.

**For qa-engineer (the ONE test to add)** — `GET /health` (per ADR-007, Vitest + `app.inject`, no live DB; mock `../shared/prisma` like the existing integration tests do):
- assert HTTP `200`;
- assert `body.success === true` and the three fields live under `body.data`;
- assert `body.data.status === 'ok'`;
- assert `body.data.version === '1.0.0'` (or, to avoid coupling to the literal, equals the version imported from `package.json` / `APP_VERSION`);
- assert `body.data.timestamp` is valid ISO8601 — e.g. `new Date(body.data.timestamp).toISOString() === body.data.timestamp`;
- (optional) assert no auth header is required (no `Authorization` sent, still 200) to lock in that it stays public.
Keep the global coverage gate green (line ≥ 80 / branch ≥ 70). `src/shared/version.ts` is module-load code exercised by simply building the app, so it should not drag coverage.

**Report**: DONE.
<!-- /agent: backend-dev -->

---

<!-- agent: backend-dev -->
## Backend-Dev Output (URL Shortener — SSRF fix)
**Status**: DONE. Closed the High-severity IPv4-mapped-IPv6 SSRF bypass in `src/shared/url-safety.ts` (qa's "## QA-Engineer Output" BUG FOUND / Gate-1 open item). `npx tsc --noEmit` exits 0. Surgical change only — file structure untouched (code-quality rated it CLEAN); no new dependency (Node built-ins only). Ready for security re-review + qa to convert the pinning test to a reject assertion.
**Handoff protocol**: agentmemory recall SUCCEEDED (found security threat-model mem_mq6gtirf + qa bug memory mem_mq6hsyvh). Read brief Security/Backend-Dev/QA-Engineer (URL Shortener) sections + url-safety.ts + the qa pinning test. remember SUCCEEDED. patterns.md appended (1 entry).

### Exact change (src/shared/url-safety.ts)
Root cause: `isBlockedIpv6` extracted the embedded IPv4 only via `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` (dotted-decimal). But WHATWG `URL` canonicalizes a host literal `http://[::ffff:127.0.0.1]/` to the COMPRESSED-HEX hostname `::ffff:7f00:1`, which that regex misses — so the hex form (and `::ffff:HHHH:HHHH` generally) fell through to `return false` and was wrongly ACCEPTED.
Fix (within the existing guard structure — no restructure):
1. Added `extractMappedIpv4(lower)`: parses BOTH `::ffff:d.d.d.d` (dotted) AND `::ffff:HHHH[:HHHH]` (one or two hex hextets — WHATWG drops a leading all-zero hextet, so `0.0.0.x` arrives as a single group `::ffff:x`); reconstructs the low 32 bits `((high<<16)|low)>>>0` and returns canonical dotted-quad. Returns `null` if not an IPv4-mapped address.
2. Added `intToIpv4(value)` helper (32-bit int -> dotted-quad) — the inverse of the existing `ipv4ToInt`.
3. Rewrote the mapped branch in `isBlockedIpv6`: if hostname `startsWith('::ffff:')`, derive the embedded IPv4 via `extractMappedIpv4` and run it through the EXISTING `isBlockedIpv4` CIDR table (full reuse — no new range logic). **FAIL CLOSED**: if the `::ffff:` prefix is present but cannot be parsed, return `true` (blocked) instead of falling through to allowed.
4. Added named constants `HEXTET_BITS=16`, `HEX_RADIX=16`, `OCTET_MASK=0xff` (no magic numbers). JSDoc updated on `isBlockedIpv6` explaining the dual-form foot-gun + fail-closed posture.

### Forms now REJECTED (422 ValidationError "URL resolves to a disallowed address") — for qa to assert
The qa pinning test `CURRENTLY_ACCEPTS_ipv4_mapped_ipv6_loopback__KNOWN_SSRF_BUG` should be converted to expect a `ValidationError` reject. Verified end-to-end (ran + removed a temp harness; then ran the url-safety test file):
- `http://[::ffff:127.0.0.1]/`  (URL-parsed to `::ffff:7f00:1`) -> 127.0.0.1 loopback -> REJECT
- `http://[::ffff:7f00:1]/`     (hex literal)                   -> 127.0.0.1 -> REJECT
- `http://[::ffff:a9fe:a9fe]/`                                  -> 169.254.169.254 cloud metadata -> REJECT
- `http://[::ffff:0a00:0001]/`  (-> `::ffff:a00:1`)             -> 10.0.0.1 RFC1918 -> REJECT
- `http://[::ffff:10.0.0.1]/`   (dotted form, e.g. from DNS)    -> 10.0.0.1 -> REJECT (was already handled; still passes)
- `http://[::ffff:c0a8:1]/`                                     -> 192.168.0.1 -> REJECT
- `http://[::ffff:1]/` and `http://[::ffff:0:1]/`              -> 0.0.0.1 (in 0.0.0.0/8) -> REJECT
- `http://[::ffff:0:0]/`                                        -> 0.0.0.0 -> REJECT
Still ACCEPTED (public, correct): `http://[::ffff:8.8.8.8]/` and its hex form `http://[::ffff:808:808]/` (8.8.8.8).

### Why fail-closed
An IPv4-mapped (`::ffff:`) prefix is only ever used to embed an IPv4 address; there is no legitimate reason for it to be unparseable by our extractor. Per ADR-019 deny-by-default + the file's existing fail-closed posture (DNS timeout/resolution failure already reject), an unrecognized `::ffff:` encoding is treated as blocked rather than allowed — so any future/edge canonical form we did not anticipate cannot become a new bypass.

### Verification
- `npx tsc --noEmit` -> exit 0.
- `npx vitest run src/shared/url-safety.test.ts` -> 37/38 pass; the ONLY failure is the qa pinning test, which now correctly REJECTS (`http://[::ffff:127.0.0.1]/` -> 422) — i.e. it fails *because the bug is fixed*. Per coordination I did NOT edit the test file; qa converts the pin to a reject assertion next.
- No file structure changed; no new dependency; Prisma/layers untouched (this is a shared/ helper).

### Test targets for qa / security re-review
- Convert `CURRENTLY_ACCEPTS_ipv4_mapped_ipv6_loopback__KNOWN_SSRF_BUG` -> `rejects.toBeInstanceOf(ValidationError)` for `http://[::ffff:127.0.0.1]/`.
- Add reject cases for the hex forms above (esp. `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `::ffff:0a00:0001`) and the single-group `::ffff:1` / `::ffff:0:0`.
- Add an ACCEPT case for a public mapped form (`::ffff:8.8.8.8` / `::ffff:808:808`) to prevent a future over-broad "reject all ::ffff:" regression.

**Next recommended agent**: qa-engineer (convert the pinning test + add the hex-form matrix), then security-engineer / quality-lead (re-confirm Gate-1 H1 closed → Gate-4 SHIP IT). Gate 2 (code-quality CLEAN) + Gate 3 (coverage) were already green; this closes the last open Gate-1 High.
<!-- /agent: backend-dev -->

---

<!-- agent: qa-engineer -->
## QA-Engineer Output (URL Shortener — SSRF fix verification)
**Status**: DONE — SSRF bypass is now CLOSED BY TEST. Converted the pinning regression into a real reject assertion and EXPANDED it into a full IPv4-mapped-IPv6 reject/accept matrix. Full suite GREEN (197/197), coverage targets MET, global gate stays green. Did NOT touch any source (url-safety.ts is backend-dev's) — test-only edit. (Ran as general-purpose standing in for qa-engineer; subagent type unavailable in this session's registry.)
**Handoff protocol**: agentmemory recall SUCCEEDED (found qa bug mem_mq6hsyvh + backend-dev fix mem_mq6hzvny). remember SUCCEEDED (see below). patterns.md appended. Read brief Backend-Dev (URL Shortener — SSRF fix), the prior QA-Engineer Output, and the current url-safety.ts/url-safety.test.ts.

### Test change
- `src/shared/url-safety.test.ts` (EDITED — test-only): DELETED the pinning test `CURRENTLY_ACCEPTS_ipv4_mapped_ipv6_loopback__KNOWN_SSRF_BUG` (which asserted the vulnerable ACCEPT behavior and now fails because the bug is fixed). Replaced it with a new `describe('assertSafeUrl — IPv4-mapped IPv6 literals (H1, SSRF bypass fixed)')` block using the `should_reject_ipv4_mapped_ipv6_*` naming convention. All cases are IP literals (bracketed IPv6) → no DNS, asserted `lookupMock` NOT called.

### New matrix (10 cases, replacing 1 pin)
REJECT (7, each → `ValidationError`):
- `http://[::ffff:127.0.0.1]/` and hex `http://[::ffff:7f00:1]/` → 127.0.0.1 loopback
- `http://[::ffff:a9fe:a9fe]/` → 169.254.169.254 cloud metadata
- `http://[::ffff:0a00:0001]/` → 10.0.0.1 (RFC1918)
- `http://[::ffff:c0a8:1]/` → 192.168.0.1 (RFC1918)
- `http://[::ffff:0:0]/` → 0.0.0.0, `http://[::ffff:1]/` → 0.0.0.1 (0.0.0.0/8)
- + a `should_not_resolve_dns_for_a_mapped_ipv6_literal` guard (mapped literal rejected with zero DNS lookups).
ACCEPT (2, public — anti-over-broad-regression guard):
- `http://[::ffff:8.8.8.8]/` and hex `http://[::ffff:808:808]/` → 8.8.8.8 (public) → returns a non-empty normalized href, no DNS.

### Full-suite result (REAL — `npx vitest run --coverage`, v8)
- **197 passed / 197 (13 files), 0 failed, 0 skipped, 0 flaky.** (was 188 before this task; net +9 = −1 pinning test removed, +10 new cases. url-safety.test.ts: 38 → 47 tests.)
- `src/urls/` — **100%** lines/branch/funcs/stmts across all 5 files (unchanged, still perfect).
- `src/shared/url-safety.ts` — **99.33% lines/stmts, 94.59% branch, 100% funcs.** Only uncovered: line 169 `return false;` (the non-blocked-non-mapped IPv6 fall-through) — a pre-existing source line reachable only by a public bare-IPv6 literal; backend-dev's suite did not add that case and it is NOT load-bearing for this SSRF fix. The fail-closed `mapped === null ? true` branch and every blocked-IPv4-mapped form ARE now covered. Not gold-plating a source file I'm forbidden to edit.
- Global gate (floor lines ≥80 / branch ≥70): **lines 98.74% ✓, branch 95% ✓, funcs 98.16%, stmts 98.74%** — Gate 3 GREEN.

### Confirmation
The IPv4-mapped-IPv6 SSRF bypass (Gate-1 H1 / ADR-019) is now CLOSED BY TEST: every loopback / RFC1918 / link-local-metadata / unspecified mapped form is asserted to REJECT, the public mapped form is asserted to ACCEPT (preventing an over-broad reject-all regression), and the suite would go RED if anyone reintroduced the bypass. The earlier KNOWN_SSRF_BUG pin no longer exists. Gate 2 (code-quality CLEAN) + Gate 3 (coverage) GREEN; this was the last open Gate-1 High.

**Next recommended agent**: security-engineer / quality-lead — re-confirm Gate-1 H1 is closed (now backed by a passing reject matrix) → Gate-4 SHIP IT.
<!-- /agent: qa-engineer -->

---

<!-- domain: infrastructure -->
## GEL-6 — agentmemory Update & Verification Output (claude, 2026-06-10)

**What was done**: Verified agentmemory plugin/npm versions, attempted official update, validated MCP read/write against storage, and runtime-tested lifecycle hooks with a tech-writer subagent probe.

**Results**:
- **Version**: 0.9.27 everywhere (plugin, npm global, npm registry latest for both @agentmemory/agentmemory and @agentmemory/mcp, marketplace clone). `claude plugin update agentmemory@agentmemory` → "already at the latest version (0.9.27)". No update needed/performed. Upstream has post-release commits (a76224f, 2026-06-09) but no new published version.
- **Storage intact**: standalone.json `mem:memories` 23 → 25 records; both additions are intentional saves (GEL-6 test record + findings record). No data loss.
- **MCP tools**: memory_save ✅ persists to standalone.json (verified in file). memory_recall / memory_smart_search ✅ return old + new records, BUT search uses strict AND keyword semantics — any query word absent from all records (e.g. "findings" combined with "task management API") yields 0 results.
- **HOOK CAPTURE BROKEN** (root cause identified, NOT fixed — handed to GEL-2): all 12 hooks are registered in plugin hooks.json (incl. SubagentStart/SubagentStop) and scripts exist; they fire-and-forget POST to `http://localhost:3111/agentmemory/observe` and swallow every error (`.catch(()=>{})`, silent exit 0). Port 3111 is owned by iii.exe (PID 16648, daemon engine) but the agentmemory worker (worker.pid 10656) is DEAD → every `/agentmemory/*` REST route returns 404 → all observations/sessions silently lost. memory_sessions + memory_audit return empty. Subagent probe (tech-writer; counted 19 patterns in patterns.md) left zero traces in storage; manual JSON pipe into subagent-stop.mjs exits 0 silently; direct POST → HTTP 404.

**Blockers**: none for GEL-6.
**Next recommended agent**: GEL-2 — restart/repair the agentmemory daemon worker (or add a standalone-storage fallback to hooks), then re-run the subagent probe to confirm observations land.
<!-- /domain: infrastructure -->

---

<!-- domain: infrastructure -->
## GEL-2 — Hook Pipeline Repair + Domain Memory Integration Output (claude, 2026-06-10)

**Phase 1 — worker repair (DONE)**:
- Root cause confirmed: the agentmemory worker is a child of whatever shell/session starts it; iii.exe is spawned detached and survives alone → "engine on 3111 but all routes 404". Repair: `agentmemory stop` + `agentmemory --verbose` → worker connected (263 functions), health healthy, `POST /agentmemory/observe` → 201.
- Hook pipeline verified END-TO-END with a real tech-writer subagent probe: subagent_start (07:19:13Z) → subagent's own Read captured (07:19:16Z) → subagent_stop (07:19:21Z). PostToolUse/PostToolUseFailure stream live (26+ observations this session).
- Storage facts: memories = ~/.agentmemory/standalone.json (25). Observations = engine KV at RELATIVE ./data/state_store.db → currently agentcorp-v2/data/ (untracked) because the daemon was started from the repo cwd.
- CRASH GUARD: NONE (no watchdog/pm2; iii-exec watch = source-file watching only). When the session that started the worker closes, the worker dies again and the same failure recurs. Detection only per GEL-2 rules — fix deferred.
- Testing gotcha: PS 5.1 pipes prepend a UTF-8 BOM → hook script JSON.parse fails silently. Manual hook tests must go through cmd (`type payload.json | node script`) — verified working (HTTP 201, observation landed).

**Phase 2 — domain memory integration (DONE)**:
- All 20 agents got domain-specific "0." memory bootstrap blocks (4 memory_recall queries each, 80 total), replacing the generic "Check agentmemory availability" block, written to BOTH ~/.claude/agents and agentcorp-v2/.agents.
- Verification: 20/20 global + 20/20 repo contain memory_recall; 20/20 pairs SHA256-identical; fc diff empty on backend-dev, security-engineer, orchestrator, qa-engineer, tech-lead.
- Note: the old "If unavailable: read brief.md" fallback line was replaced per the new spec; the Before You Start steps 1-2 still read brief.md/decisions.md.

**Blockers**: none.
**Next recommended**: decide a persistent daemon startup path (outside ephemeral sessions, e.g. scheduled task) so the worker survives session close — currently the repaired state is session-bound.
<!-- /domain: infrastructure -->

---

<!-- domain: infrastructure -->
## GEL-4 — Context Injection Optimization Output (claude, 2026-06-10)

**What was done**: Section tagging implemented across the three context files; CLAUDE.md gained a Context Budget section; all 20 agent prompts switched to section-aware reading and tag-mandatory brief writing.

- **brief.md**: 34 blocks tagged (32 `<!-- agent: X -->` + 2 `<!-- domain: infrastructure -->` for GEL sections); 1356 content lines preserved byte-for-byte (only tag lines added). All 34 opening tags sit immediately before a heading; open/close balanced.
- **decisions.md**: 24/24 ADRs tagged with one domain each (security 9, data 8, architecture 3, backend 3, quality 1).
- **patterns.md**: 19/19 patterns tagged by owning agent (backend-dev 6, qa-engineer 5, orchestrator 3, data-lead 2, security-engineer/db-engineer/quality-lead/tech-writer 1 each).
- **CLAUDE.md (global)**: "## Context Budget" appended — reading rules, per-agent tag table, fallback rules.
- **Agents (BOTH locations, 20/20 SHA256-identical)**: brief/decisions read steps replaced with tag-scoped reads (orchestrator + tech-writer keep FULL READ; architect reads all ADRs); After-You-Finish step 1 now mandates writing inside your own agent tags; orchestrator Step 4 now pre-creates tagged sections before routing. devops + maintainability had no brief-read step at all — one was added.
- **Measured savings**: full brief.md ≈ 39.7k tokens; per-agent own-section share ranges 0.7%–19.4% (median ~7%) → ~80–99% less brief context per specialist call.

**Gotcha recorded**: first tagging pass mis-placed tags because PS 5.1 `Sort-Object e` silently does not sort hashtable arrays — fixed by using PSCustomObject + re-validating each block's heading at insert time. Tags were cleanly reverted and re-applied; content integrity verified after both passes.

**Next recommended**: none for GEL-4. Future agent sessions must follow the Context Budget rules (read own tags only).
<!-- /domain: infrastructure -->

---

<!-- domain: infrastructure -->
## GEL-1 — Hierarchy Enforcement Output (claude, 2026-06-10)

**What was done**: Mechanical hierarchy enforcement installed across CLAUDE.md, all 20 agent definitions (both locations), and brief.md.

- **CLAUDE.md (global)**: "## Hierarchy & Delegation Rules" added before Context Budget — tier definitions (1 orchestrator / 5 leads / 14 specialists), delegation rules (only orchestrator spawns; leads delegate via RECOMMENDED_NEXT only), parallel-safe pairs, non-negotiable quality gate sequence.
- **All 20 agents**: (a) tier-boundary items added to DOES NOT lists (leads: no direct specialist invocation; specialists: no spawning, no orchestration takeover, CHECKPOINT-and-stop on session limit; orchestrator: no proceeding past BLOCKED, no gate skipping); (b) structured delegation-receipt step appended to After You Finish (agent-specific name + tier prefilled; numbered max+1 per file).
- **orchestrator.md**: Step 4 now pre-creates PENDING receipt blocks + updates the Hierarchy Execution Log before routing; Step 5 gained the receipt-reading protocol (DONE/BLOCKED/NEEDS_REVIEW handling, RECOMMENDED_NEXT evaluation, no-receipt = no-success); Session Continuity gained the mandatory CHECKPOINT receipt format + resume-from-receipts procedure.
- **brief.md**: Hierarchy Execution Log table prepended at the very top (existing content untouched, shifted down).
- Verification: hierarchy section 1/1, receipts 20/20, tier enforcement 19/19, orchestrator "receipt" mentions 16, log 1/1, 20/20 file pairs SHA256-identical.

<!-- receipt: claude -->
AGENT: claude (main loop, user-invoked)
STATUS: DONE
TIER: 1
COMPLETED: GEL-1 hierarchy enforcement
KEY_DECISIONS:
- Receipt numbering adapts to each agent's existing After You Finish step count (max+1) instead of a hard-coded "7"
- Tier 2 receipt template carries an explicit lead-cannot-invoke NOTE
- Orchestrator pre-creates PENDING receipts so missing receipt = detectable failure
BLOCKERS: none
RECOMMENDED_NEXT: none — GEL-1 complete
HANDOFF_NOTES: This is the first live receipt; all future agent runs must produce one. Hierarchy Execution Log table is at the very top of this file.
<!-- /receipt: claude -->
<!-- /domain: infrastructure -->

---

<!-- domain: security -->
## GEL-3 — Security Gate Output (claude, 2026-06-10)

**What was done**: Two-sided security gate installed — (1) produced-code security: security-engineer can no longer be skipped; (2) agent-system integrity: receipt forgery/manipulation checks.

- **CLAUDE.md**: "## Security Gate Rules" added before Hierarchy & Delegation Rules — mandatory trigger keyword matrix (auth/data/network/infra/dependency + catch-all file globs), legitimate-skip list, workflow position (always before implementation, re-run after auth-touching P1 fixes), CRITICAL→BLOCKED / HIGH→FIX IT / MEDIUM→mitigate / LOW→log escalation levels.
- **orchestrator.md**: Step 1 gained a Security Trigger Check for EVERY task (keyword scan → SECURITY_REVIEW: REQUIRED/SKIPPED with explicit reason; implementation blocked until security receipt DONE); Step 4 writes the SECURITY_REVIEW/REASON/STATUS header; Step 5 gained Receipt integrity checks (AGENT-name match, tier match, STATUS whitelist, RECOMMENDED_NEXT must be a real non-tier-1 agent; any failure → anomaly log + ignore recommendations + escalate).
- **security-engineer.md**: new Step 0 Differential scope analysis (HIGH/MEDIUM/LOW/SKIP risk classification per changed file, depth proportional to risk, REVIEW_SCOPE written to brief.md); After You Finish now mandates structured SECURITY_PATTERN / SECURITY_DECISION memory_save entries so future sessions can recall actionable findings.
- **backend-dev.md**: new Step 2.5 pre-implementation security checklist (input validation / authn / authz / data exposure / external calls) — developer self-checks before writing code instead of fully outsourcing security.
- **quality-lead.md**: Step 1 gained blocking Security gate verification (REQUIRED+non-DONE = BLOCKED; SKIPPED requires legitimate reason else P1); FIX IT triggers extended with 3 security conditions.
- Verification: 7/7 grep checks = 1, 4/4 file pairs identical.

<!-- receipt: claude -->
AGENT: claude (main loop, user-invoked)
STATUS: DONE
TIER: 1
COMPLETED: GEL-3 security gate
KEY_DECISIONS:
- Security trigger scan runs for EVERY task type (feature, refactor, bugfix, dependency update) — skip requires explicit documented reason verified by quality-lead
- Existing "Remember to agentmemory" content preserved; structured SECURITY_PATTERN format appended (add-only rule)
- Receipt integrity = name/tier/status/recommendation validation, defense against brief.md manipulation
BLOCKERS: none
RECOMMENDED_NEXT: none — GEL-3 complete
HANDOFF_NOTES: SECURITY_REVIEW header convention starts with the next orchestrated task; quality-lead now refuses SHIP IT without it when triggers matched.
<!-- /receipt: claude -->
<!-- /domain: security -->

---

<!-- domain: quality -->
## GEL-5 — Quality Baseline System Output (claude, 2026-06-10)

**What was done**: Measurable quality baseline established; code-quality agent now reviews RELATIVE to it and auto-flags degradation as P1.

- **Measured (fresh `npm run test:coverage`, 197/197 green)**: 36 source .ts files (13 test files), 3300 lines total, avg 91.7/file. Coverage: 98.74% line / 95.0% branch / 98.17% function. Complexity proxy (decision points): fake-prisma.ts 64 (MEDIUM, test infra), url-safety.ts 57 (MEDIUM), auth.service.ts 22; risk split 34 LOW / 2 MEDIUM / 0 HIGH.
- **`.quality-baseline.json` (repo root, v1.1.0)**: coverage numbers + thresholds (90 line / 85 branch on new code), per-file complexity_points/lines/risk for all 36 files, file-size thresholds (300/500/700), known_debt: 2 entries (P2: users module under-tested — users.routes 81.1%, users.schemas 72.4%, was out of QA scope; P3: url-safety.ts bare-IPv6 fall-through line uncovered, accepted by quality-lead).
- **code-quality.md (both locations)**: Before You Start step 5 loads the baseline (missing-file fallback defined); Step 2 starts with Baseline comparison (complexity +20% = P2, +50% = P1, coverage drop = P1, BASELINE_COMPARISON block written to brief.md); Step 6 runs `.\scripts\check-slop.ps1` first (script P1s = report P1s) then manual review for non-greppable patterns; Metrics Summary table gained Baseline/Delta columns.
- **CLAUDE.md**: "## Quality Baseline" section (before Context Budget) — degradation rules (4 automatic-P1 conditions) + baseline update triggers (new module / coverage improvement / debt resolved or accepted; version bump + last_updated).
- **`scripts/check-slop.ps1` (new)**: 7-pattern AI slop scanner (P1: empty catch, console.*, any; P2: ownerless TODO, obvious comments, async-no-await heuristic; P3: magic numbers, -Strict only). First run on full src/: **CLEAN — 0 P1, 0 P2 across 36 files**.

<!-- receipt: claude -->
AGENT: claude (main loop, user-invoked)
STATUS: DONE
TIER: 1
COMPLETED: GEL-5 quality baseline system
KEY_DECISIONS:
- Baseline complexity metric = regex decision-point proxy (documented in baseline thresholds), not true per-function CC — deltas comparable run-to-run since the same script measures both sides
- User's draft check-slop.ps1 had 3 defects fixed: function-scope $findings never propagated, 3-arg Join-Path (PS7-only), .Split("src\") char-array trap
- known_debt seeded from verified open items only (TOKEN_REUSE P2.3 already RESOLVED, excluded)
BLOCKERS: none
RECOMMENDED_NEXT: none — GEL-5 complete
HANDOFF_NOTES: code-quality must bump baseline version when updating it; magic-number P3 pattern also matches HTTP codes (404/422) — manual judgement required, P3 hidden unless -Strict.
<!-- /receipt: claude -->
<!-- /domain: quality -->

---

<!-- agent: orchestrator -->
