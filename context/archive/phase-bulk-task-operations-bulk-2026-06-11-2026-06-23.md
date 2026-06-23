## Orchestrator Output — Bulk Task Operations (BULK-2026-06-11) — 2026-06-11

### Goal
Add three bulk endpoints to the tasks module — `POST /tasks/bulk-create`, `PATCH /tasks/bulk-update`, `DELETE /tasks/bulk-delete` (max 50 items each) — that loop the EXISTING single-task service logic per item with independent per-task success/failure (partial success, no rollback). Each returns `{ succeeded: TaskResponse[], failed: { id, reason }[] }`. Reuse tasks.service / tasks.policy / tasks.schemas verbatim; no new dependency, no schema/migration change.

SECURITY_REVIEW: REQUIRED
SECURITY_REASON: bulk endpoints touch authn (authGuard), object-level authz (owner/assignee, owner-only delete — ADR-013 at scale/IDOR), user input (array validation, mass-assignment), and bulk DB writes/deletes + a rate-limit-amplification/DoS surface (50x per request). Multiple mandatory trigger keywords: delete, update, input validation, rate limiting, permission/owner.
SECURITY_STATUS: DONE (security-engineer Phase 1 complete; Gate-1 H1-H5/M1-M2/L1 issued; ADR-042 frozen; no Critical/High open; no escalation; backend-dev unblocked)

### Scope
IN: 3 bulk routes in tasks.routes.ts; bulk schemas (array wrappers, max 50) in tasks.schemas.ts; bulk service methods orchestrating existing create/update/delete per-item with per-item try/catch → partial-success aggregation; rate-limit accounting so a batch of N counts as N (ADR-014); full tests; >95% coverage on new code; all 483 existing tests stay green.
OUT: new entities/migrations (none — reuses Task); transactional/all-or-nothing semantics (explicitly rejected by requirement — partial success); new dependencies; bulk endpoints on other modules; pagination/streaming of huge batches (hard cap 50).

### Constraints (frozen by ADRs + task)
- ADR-010/011 layered vertical slice: routes parse only, service owns logic+authz orchestration, policy owns the authz decision, repository owns persistence. No Prisma in routes.
- ADR-013 object-level authz: reuse assertCanAccess (update) / assertIsOwner (delete) per item; unauthorized/missing item → that item lands in `failed` (404-not-403 semantics preserved as the per-item reason, NOT a whole-request 404).
- ADR-006 Zod .strict(); reuse createTaskSchema/updateTaskSchema element shapes inside an array(max 50) wrapper. ownerId never accepted from body.
- ADR-014 rate limit: a bulk request must consume N units against the existing 100/min limiter (each task in batch = 1).
- No new dependency. Reuse toTaskResponse (shared wire DTO), ok() envelope, audit().
- Partial success: one item failing MUST NOT affect others (independent per-item try/catch); NO rollback.

### Agent Execution Plan
Phase 1 (design, security): security-engineer — threat model the bulk surface (IDOR-at-scale, mass-assignment, DoS/rate-limit-amplification, partial-success info-leak via `failed.reason`, batch-size enforcement, error-aggregation safety). GATES Phase 2.
Phase 2 (impl): backend-dev — implement the 3 endpoints reusing existing service/policy/schemas, per security checklist. (GATED on SECURITY_STATUS=DONE.)
Phase 3 (review, parallel): qa-engineer ‖ code-quality.
Phase 4 (gate): quality-lead — SHIP IT required.
Phase 5 (docs): tech-writer.

COLLAPSED (with justification, per the "frozen-stack collapse" pattern): architect + tech-lead (no new boundary, no new dependency — verbatim reuse of the existing tasks slice; bulk loop introduces no component boundary), data-lead + db-engineer (no schema/entity/migration — reuses the Task model and existing indexes). ESCALATION VALVE: if backend-dev finds an unavoidable new dependency or a real architecture deviation (e.g. a genuine need for a DB-level batch transaction that conflicts with the no-rollback requirement), STOP and escalate to orchestrator before proceeding.

### Open Questions
None blocking. Rate-limit "counts as N" mechanism is a backend-dev implementation choice within ADR-014 (e.g. per-item weight) — security-engineer to confirm the chosen mechanism cannot be bypassed to DoS.

### Hierarchy Execution Log
| Phase | Agent | Tier | Status | Task |
|-------|-------|------|--------|------|
| 1 | security-engineer | 3 | DONE | Threat model bulk surface; Gate-1 checklist (ADR-042) |
| 2 | backend-dev | 3 | DONE (NEEDS_REVIEW) | Implement 3 bulk endpoints (reuse service/policy/schemas); H1-H4/M1/M2/L1 done; H5 escalated |
| 2b | orchestrator | 1 | DONE | H5 RULING: adopt Option 3 (encapsulated incrByN adapter, no new dep) — ADR-043 |
| 2c | backend-dev | 3 | DONE | H5 N-weighting incrByN adapter + pin test (ADR-043); 496 tests green |
| 2e | backend-dev | 3 | DONE | H6 fix: bulkUpdateItemSchema z.intersection→extend().refine() (PATCH bulk-update was 422-ing all payloads); 501 tests |
| 2d | security-engineer | 3 | DONE | Re-review BLESSED: H5 adapter fails-closed + global key; H6 did not reopen H2; Gate-1 GREEN |
| 3 | qa-engineer | 3 | DONE | 42 new tests (543 total); new-code coverage 100% line (routes 96.87% branch); fail-closed test verified; no functional bugs |
| 3 | code-quality | 3 | DONE | CLEAN, max CC=4, no slop; baseline 1.1.0→1.2.0; 1 P2 (file length) + 1 P3 (no eslint) deferred |
| 4 | quality-lead | 4 | DONE | SHIP IT — all 4 gates GREEN, independently verified (543 tests, 99.35% line, tsc 0) |
| 5 | tech-writer | 3 | DONE | docs/api.md + CHANGELOG [1.5.0] + README; ADR-042/043 referenced |

### Orchestrator H5 Ruling (2026-06-11, resume)
Adopted Option 3 — encapsulated `incrByN` adapter over the existing `@fastify/rate-limit@9.1.0` store. Rationale: both "no new dependency" and "batch counts as N" (ADR-014) are explicit frozen requirements; Option 3 is the only path satisfying both. Option 1 (rate-limiter-flexible) violates no-new-dep; Option 2 (downgrade to MEDIUM) abandons the counts-as-N requirement. Verified @fastify/rate-limit@9.1.0 has no public weight primitive (LocalStore/RedisStore incr = +1, single-fire guarded by private Symbol) against installed source — backend-dev's analysis fully corroborated. Recorded as ADR-043. Coupling fenced behind one adapter + a version-pinning test that breaks loudly on plugin upgrade. security-engineer re-review required (touches rate-limit middleware) before Gate-1 close-out.
<!-- /agent: orchestrator -->

<!-- agent: security-engineer -->
## Security-Engineer Output — Bulk Task Operations (BULK-2026-06-11) — 2026-06-11

### Verdict: DONE — no blocking (Critical/High) findings. Gate-1 checklist below GATES backend-dev.
No new dependency. No new authz primitive. No new datastore. Verbatim reuse of
tasks.service / tasks.policy / tasks.schemas / audit / rate-limit. One new ADR (ADR-042)
written to make the partial-success `failed.reason` enum a frozen security contract.

### REVIEW_SCOPE (differential)
| File | Risk | Why |
|------|------|-----|
| src/tasks/tasks.routes.ts (NEW handlers) | HIGH | new endpoints, user input, authz orchestration, audit |
| src/tasks/tasks.schemas.ts (NEW array wrappers) | HIGH | mass-assignment surface, batch-size cap, UUID format |
| src/tasks/tasks.service.ts (NEW bulk methods) | HIGH | per-item authz loop, error aggregation, assignee-existence amplification |
| src/tasks/tasks.policy.ts | (reuse, unchanged) | per-item authz source of truth — MUST NOT be modified |
| src/app.ts (rate-limit weight) | MEDIUM | "counts as N" enforcement |
Light/skip: error-handler.ts, errors.ts, audit.ts (reuse-only, read for reason-mapping ruling).

### Attack surface
- 3 authenticated endpoints behind the plugin-wide `authGuard` (Spoofing handled by existing JWT
  layer — unchanged, not re-reviewed beyond confirming the guard still wraps the new routes).
- Trust boundary: the request body is a CLIENT-CONTROLLED ARRAY of up to 50 elements. Each element
  is untrusted; each `id` is an attacker-chosen UUID; each element is a probe.
- Key shift vs single-task: a single HTTP request now drives up to 50 authz decisions, up to 50
  (create) or 100 (update: findById + assignee-existence) DB ops, and returns a per-item outcome
  array that is a NEW information channel the single-task 404 design never exposed.

### STRIDE — bulk surface
| Threat | Vector on bulk | Mitigated by |
|--------|----------------|--------------|
| Spoofing | unauth caller hits bulk endpoint | existing `authGuard` preHandler (unchanged); reject before any item |
| Tampering | mass-assignment of ownerId / unknown keys via array element | element schema stays `.strict()`; ownerId never read from body (service sets it) — H2 |
| Tampering | id-spoof to mutate another user's task | per-item `assertCanAccess`/`assertIsOwner` runs for EVERY element — H1 |
| Repudiation | bulk action not attributable per item | per-item audit line {actorId, resourceId, outcome} — H6 |
| Info Disclosure | `failed.reason` distinguishes not-found vs forbidden → 50-id enumeration oracle | fixed reason ENUM, identical token for missing+unauthorized (ADR-042) — H3 (TOP finding) |
| Info Disclosure | internal/Prisma/assignee-detail strings leak into `failed.reason` | reason is mapped from error TYPE, never `err.message` — H4 |
| DoS | 50x (create) / 100x (update) DB ops per request; batch under-counted by limiter | hard cap 50 enforced pre-DB; batch weighted as N against 100/min (ADR-014) — H5 |
| Elevation of Privilege | owner-only delete/reassign bypassed in the loop | reuse `assertIsOwner` per item; never downgrade to `assertCanAccess` — H1 |

### FINDINGS
| ID | Sev | CWE | Title | Exploit path | Fix |
|----|-----|-----|-------|--------------|-----|
| H1 | High | CWE-639 (IDOR) | Per-item authz must be IDENTICAL to single-task | If bulk methods batch-fetch then mutate without per-item policy, a caller mixes their own ids with victim ids in one batch and edits/deletes victim tasks. | In the per-item loop call the SAME helper as the single path: update→`assertCanAccess` then `assertIsOwner` on reassign; delete→`assertIsOwner`. NEVER add a bulk-only repository read that returns rows the caller can't see. Policy file is frozen. |
| H2 | High | CWE-915 (mass assignment) | Array element schemas must stay `.strict()`; ownerId server-set | A client sends `{ "ownerId":"<victim>", ... }` (create) or an unknown key inside an element; if the element schema isn't `.strict()` or the service spreads the element into repo data, ownership/forbidden fields are injected. | Element schema = `createTaskSchema`/`updateTaskSchema` VERBATIM (already `.strict()`). Service sets `ownerId = userId` from JWT per item (reuse existing `create`/`toUpdateData`, which already omit ownerId). Do not write a new mapper. |
| H3 | High | CWE-203 / CWE-204 (observable discrepancy / response discrepancy) | Partial-success `failed.reason` is an enumeration oracle | Attacker submits a batch of 50 random/guessed UUIDs to bulk-update or bulk-delete. If `failed.reason` says "not found" for nonexistent ids but "forbidden"/"not owner" for ids that exist but belong to others, the response classifies every id → existence + ownership enumeration at 50/request, defeating ADR-013 404-not-403 and ADR-016 UUID non-enumeration. | `failed.reason` MUST be a FIXED enum and MUST collapse missing-row and unauthorized into ONE indistinguishable token: `NOT_FOUND` (see ADR-042). Reason is derived from error TYPE only, never count/timing. (See exact policy below.) |
| H4 | High | CWE-209 (info exposure via error message) | Internal error text must not reach `failed.reason` | A per-item failure throws a Prisma error / generic Error / `ValidationError` whose `.message` carries field detail (e.g. assignee-existence "No user with this id"); if the loop does `reason: err.message`, stack/Prisma/field internals leak per item. | Map error → reason by INSTANCEOF, never pass `err.message` through. Unknown/unexpected errors map to a single generic `INTERNAL` reason and are logged server-side (mirror error-handler.ts). |
| H5 | High | CWE-770 (resource exhaustion) / CWE-799 (improper rate throttling) | DoS via batch amplification + limiter under-count | Without weighting, one HTTP request = 1 limiter unit but = up to 50 creates (or 50 findById + up to 50 user-existence reads = 100 reads) on bulk-update. 100 req/min then drives 5,000–10,000 DB ops/min/user — 50–100x the intended ceiling. | (a) Hard cap 50 enforced in the schema BEFORE any DB work (reject 51 with 400). (b) Each request consumes N limiter units (N = element count) against the existing 100/min budget so a 50-item batch costs 50, not 1 (ADR-014 weight). (c) Body limit 1 MB already bounds payload (M-level, sufficient given the 50 cap). |
| M1 | Med | CWE-20 (improper input validation) | Batch-size + shape validated pre-DB, fail-closed | A 51-element or empty array, a non-array body, or a non-UUID id reaches the loop and does partial DB work before failing. | Zod wrapper: `z.array(element).min(1).max(50)` on a `.strict()` object `{ items: [...] }`; ids validated `z.string().uuid()`. A whole-batch schema failure is a 400/422 BEFORE the loop (no DB touched). This is request-level validation, distinct from per-item business failures. |
| M2 | Med | CWE-462 (duplicate key) | Duplicate ids within one batch | Same id appears twice in bulk-update/delete; second op hits an already-mutated/deleted row → could surface a Prisma "record not found" as a confusing/leaky reason, or double-audit. | Acceptable to process per-item independently; the SECOND occurrence naturally lands in `failed` with the generic `NOT_FOUND` reason (consistent with H3 — never a distinct "duplicate" reason that itself becomes an oracle). Recommended: de-dupe ids server-side before the loop is allowed but NOT required; if de-duped, the dropped duplicate must still appear in `failed` as `NOT_FOUND`, never as a distinct code. |
| L1 | Low | CWE-778 | Per-item audit granularity | A bulk op that emits one audit line for the whole batch loses per-resource attribution. | Emit one audit line per item with its real outcome (success/failure) and resourceId, reusing existing `AUDIT_ACTION.TASK_CREATE/UPDATE/ASSIGN/DELETE`. Failure outcome uses `outcome:'failure'`. |

### TOP RULING — H3 exact `failed.reason` policy (non-enumeration)
The single-task design already collapses "missing" and "unauthorized" into one 404 (`assertCanAccess`/
`assertIsOwner` both throw `NotFoundError`). The bulk `failed[]` array MUST preserve that collapse.
RULE: `failed.reason` is a CLOSED enum of safe tokens. There is exactly ONE token for "this id is not
yours / does not exist", and it does NOT distinguish the two cases:
- `NOT_FOUND`        → row missing OR caller is not owner/assignee OR (delete/reassign) not owner.
                       Emitted whenever the per-item path throws `NotFoundError`. THIS IS THE OYSTER
                       that must be identical for a nonexistent UUID and a real-but-foreign UUID.
- `VALIDATION`       → per-element business validation that is NOT existence-revealing, e.g. a new
                       `assigneeId` that fails existence. IMPORTANT: do NOT echo the field message
                       ("No user with this id") — use the flat token only, because assignee-existence
                       is itself a user-enumeration oracle. (Maps from `ValidationError`.)
- `INTERNAL`         → any unexpected/unmapped error (Prisma, generic Error). Logged server-side with
                       full detail; client sees only the flat token.
The reason field is a CODE, not a sentence. backend-dev MUST map by `instanceof` (NotFoundError→NOT_FOUND,
ValidationError→VALIDATION, else→INTERNAL) and MUST NOT assign `reason = err.message`. Counts of each
reason are fine; per-id timing should not branch on existence (the findById runs the same for both
cases, so timing parity is already satisfied by reusing the existing service path — do not add an early
"row exists?" check that would create a timing side channel).

### OWASP coverage
| Cat | Status | Notes |
|-----|--------|-------|
| A01 Broken Access Control | COVERED | H1: per-item `assertCanAccess`/`assertIsOwner`; H3: 404-collapse preserved in `failed.reason` |
| A03 Injection | N/A-clean | Prisma parameterized (unchanged); no raw SQL; ids are UUID-validated |
| A04 Insecure Design | COVERED | this threat model; partial-success contract frozen in ADR-042 |
| A05 Misconfiguration | COVERED | H4: error mapping prevents stack/Prisma leak; reuses error-handler |
| A07 Auth Failures | COVERED | reuses authGuard; H5 rate-limit weighting |
| A09 Logging Failures | COVERED | L1 per-item audit; no PII/secret in reason or audit |
| A10 SSRF | N/A | no URL/egress in this feature |

### Dependencies
No new dependency (npm audit not re-run — zero package.json change in scope). Verbatim reuse only.

### NEW authz primitive / dependency needed?
NO. Confirmed: `assertCanAccess` + `assertIsOwner` (ADR-013/028) cover every per-item decision;
`.strict()` schemas (ADR-006) cover mass-assignment; existing limiter (ADR-014) covers DoS via
N-weighting; existing audit covers attribution. No escalation to orchestrator required.

### Security ADRs written
- ADR-042 — Bulk partial-success `failed.reason` is a closed safe-token enum; missing and unauthorized
  collapse to one `NOT_FOUND` token (extends ADR-013 404-not-403 to the per-item channel). <!-- domain: security -->

### H5/H6 Re-Review — 2026-06-11 (scoped, post-ADR-043 + post-H6-fix) <!-- domain: security -->
VERDICT: BLESSED. STATUS stays DONE. Zero open Critical/High. Gate-1 (H1-H5/M1/M2/L1) now fully satisfied.
Re-review triggered per ADR-043 constraint #5 (adapter touches rate-limiting middleware). Verified against
source, not prose: rate-limit-weight.ts, rate-limit-weight.pin.test.ts, tasks.routes.ts (bulk block),
tasks.schemas.ts. tsc --noEmit exit 0; 14/14 security-relevant tests green (4 pin + 5 weighting integration
+ 5 H6 schema regression).

H5 — incrByN adapter (src/shared/rate-limit-weight.ts) vs ADR-043 constraints — CLOSES the DoS amplification:
- (i) GLOBAL key, not a child store — CONFIRMED. `chargeAdditionalUnits` calls `request.server.rateLimit()`
  with NO options → the plugin's global handler over the same store + keyGenerator (client IP), the same key
  the inbound `onRequest` hook charged. It does NOT construct a child limiter / separate counter. The
  integration test proves cross-request accumulation on the shared key (30+30=60), which a child store could
  not exhibit. ADR-043 constraint #3 met.
- (ii) N bounded, charged only AFTER cap-50 — CONFIRMED. In all 3 handlers (tasks.routes.ts:132-134 /
  142-144 / 154-156) `parseOrThrow(bulk*Schema,…)` runs FIRST (schema caps array `.max(50)`, so n∈[1,50]),
  THEN `chargeAdditionalUnits(request, reply, items.length/ids.length)`, THEN the service loop. n is derived
  from the already-validated, capped array length — never attacker-unbounded. ADR-043 constraint #2 met.
  Note: a single batch caps at 50 units, so one batch alone can't exceed 100 from cold start — the ceiling
  is enforced on ACCUMULATED shared-budget usage, which is exactly the H5 target.
- (iii) FAILS CLOSED — CONFIRMED. If the private `fastify.request.rateLimitRan` guard symbol is absent
  (plugin internals changed), `findRateLimitRanSymbol` returns undefined and `chargeAdditionalUnits` THROWS
  loudly (rate-limit-weight.ts:88-96) — it never silently proceeds under-counted. A throw propagates to the
  global error handler and aborts the request; it does NOT let the batch run at 1 unit. This is the critical
  property: silent under-count would reopen the H5 50x amplification, and the code refuses to do that.
  (Defence-in-depth: even in the theoretical "throw is swallowed" case, cap-50 + 1MB body bound the blast
  radius to 50x-of-one-batch, not unbounded — matches ADR-043 rationale.)
- (iv) No new dependency — CONFIRMED. Adapter imports only `fastify` types; no package.json change in scope.
- (v) Coupling fenced behind ONE module — CONFIRMED. Repo-wide grep: the ONLY files referencing
  `rateLimitRan` / `.rateLimit()` plugin internals are rate-limit-weight.ts (the adapter) and its pin test.
  tasks.routes.ts imports only the public `chargeAdditionalUnits` — no plugin internals leak into routes.
- Pin test (rate-limit-weight.pin.test.ts) — CONFIRMED it pins BOTH the version (asserts installed
  @fastify/rate-limit === 9.1.0) AND the 3 internal-contract shapes the adapter rides on: (a) `app.rateLimit()`
  returns the global handler factory; (b) requests carry the discoverable `fastify.request.rateLimitRan`
  symbol AND the global hook charges exactly 1/request (remaining 99); (c) each extra handler invocation
  after flipping the guard increments the global key by exactly +1 (N=5 → remaining 95). A plugin upgrade
  that drifts any of these breaks the test loudly, with a banner directing re-verification against ADR-043
  BEFORE bumping the pin. The silent-under-count regression path is therefore CI-guarded. ADR-043 #4 met.
- 429 path — CONFIRMED reuses the existing AppError/ERROR_CODE.RATE_LIMIT: over-limit is thrown by the
  plugin's own configured errorResponseBuilder during the additional charges, flowing through the existing
  error-handler AppError branch. No new/divergent 429 surface, no Retry-After leak beyond the existing ADR-014
  behavior.
H5 RULING: the adapter closes the H5 DoS amplification finding EXACTLY as ADR-043 Option 3 intended. The
"batch counts as N against the shared global budget" requirement (ADR-014/H5) is now genuinely enforced, not
just cap-bounded. H5 = SATISFIED.

H6 — bulkUpdateItemSchema change (z.intersection → updateTaskObject.extend({id}).refine) — H2 INTACT, CWE-915
NOT reopened. Verified against tasks.schemas.ts directly:
- `.strict()` SURVIVES — CONFIRMED. The element is built from `updateTaskObject` (a `.strict()` ZodObject,
  schemas.ts:40-48) via `.extend({ id })`; Zod's `.extend()` preserves the source object's
  `unknownKeys:'strict'`. So the ONLY accepted keys are `id` + the known update fields. Unknown keys are still
  rejected. Regression test `{id,unknownKey} REJECTED` passes. The previous broken intersection (which 422'd
  EVERY valid `{id,…}` because each strict side flagged the other's keys) is gone — the H6 bug fix is real and
  did not paper over it by loosening strictness.
- ownerId NEVER accepted from body — CONFIRMED. `ownerId` is absent from `updateTaskObject`'s shape and
  `.extend()` only adds `id` (a UUID), so an element carrying `ownerId` is rejected as an unknown strict key.
  Regression test `{id,ownerId} REJECTED` passes. CWE-915 mass-assignment defense (H2) HOLDS.
- "≥1 update field" rule HOLDS — CONFIRMED. `bulkUpdateItemSchema` re-applies `.refine(NON_EMPTY_PATCH.check
  ∘ omitId)` (schemas.ts:100-104) which counts update fields EXCLUDING the routing `id`, so `{id}`-only is
  rejected (matches the single-task contract). Regression test `{id} REJECTED` passes.
- Key-presence preserved — CONFIRMED. The element type/shape is unchanged beyond adding `id`;
  `{id, assigneeId:null}` is accepted, so the service's `'assigneeId' in input` reassign-detection (which
  drives H1 assertIsOwner-on-reassign and L1 TASK_ASSIGN audit) still fires identically. `toUpdatePayload`
  strips ONLY `id`. No security property weakened.
H6 RULING: the schema fix is purely a correctness fix; it did NOT weaken H2. CWE-915 stays closed.

GATE-1 RE-STATEMENT: H1, H2, H3, H4, H5 all SATISFIED; M1, M2, L1 all SATISFIED. ZERO open Critical/High.
The N-weighting that was the sole open item (PARTIAL/ESCALATED) is now BLESSED. Gate-1 (Security) is GREEN
for BULK-2026-06-11 — no security blocker to qa-engineer / code-quality / quality-lead proceeding.
<!-- /agent: security-engineer -->

<!-- receipt: security-engineer -->
AGENT: security-engineer
STATUS: DONE
TIER: 3
COMPLETED: H5/H6 SCOPED RE-REVIEW for bulk task ops (BULK-2026-06-11) — adapter BLESSED, Gate-1 GREEN. (Original threat model + Gate-1 checklist below, still authoritative.)
RE-REVIEW VERDICT (2026-06-11): BLESSED. H5 incrByN adapter closes the DoS amplification EXACTLY as ADR-043 Option 3 intended; H6 schema fix did NOT reopen H2/CWE-915. All H1-H5/M1/M2/L1 satisfied, zero open Critical/High. Verified vs source (not prose): charges GLOBAL key not child store (integration test proves shared-key accumulation); N charged AFTER cap-50 (n∈[1,50]); FAILS CLOSED — throws loudly if the rateLimitRan guard symbol vanishes, never silent under-count; no new dep; coupling fenced in ONE module (repo-grep confirms only the adapter + its pin test touch plugin internals); pin test pins version 9.1.0 + 3 contract shapes; 429 reuses AppError/RATE_LIMIT. H6: `.extend()` preserves `.strict()` (ownerId still rejected), ≥1-field rule survives, key-presence preserved for the 'assigneeId' in input path. tsc 0; 14/14 security tests green.
KEY_DECISIONS:
- H5 BLESSED: adapter satisfies all 5 ADR-043 binding constraints. The critical fail-closed property holds — under-counting would reopen the 50x amplification, and the code throws instead. Gate-1 DoS finding is now genuinely closed, not merely cap-bounded.
- H6 H2-INTACT: z.intersection→updateTaskObject.extend({id}).refine() is a pure correctness fix; CWE-915 mass-assignment defense holds (strict survives extend; ownerId never accepted; {id}-only rejected). No regression.
- No new dependency / no new authz primitive — original reuse-only posture preserved through both H5 and H6.
BLOCKERS: none
RECOMMENDED_NEXT: qa-engineer ‖ code-quality — Gate-1 (Security) is GREEN; proceed to test-coverage + code-quality on the full bulk impl (adapter + 3 routes + service + schemas). qa-engineer owns >95% on rate-limit-weight.ts + bulk routes; PATCH bulk-update HTTP coverage is now unblocked (H6 fixed). Then quality-lead for SHIP IT.
HANDOFF_NOTES (RE-REVIEW): No security re-work required — adapter and H6 fix are blessed as-is. For qa-engineer: assert the FAIL-CLOSED branch (force the rateLimitRan symbol absent → chargeAdditionalUnits must THROW, not run the batch at 1 unit) — that is the load-bearing DoS control and must have an explicit test. The pin test already guards contract drift in CI; do not delete it on a plugin upgrade — re-verify against ADR-043 first.
--- ORIGINAL GATE-1 CHECKLIST (still the frozen contract) ---
GATE-1 CHECKLIST (backend-dev MUST satisfy every H#; M#/L# documented). Reuse only — do NOT modify tasks.policy.ts.
  H1 [IDOR-at-scale]: per item run the SAME helper as the single path — bulk-update→assertCanAccess (then assertIsOwner on reassign, i.e. when 'assigneeId' in element); bulk-delete→assertIsOwner. NO bulk-only repo read that returns rows the caller can't see. Call existing service create/update/delete per item inside try/catch; do not reimplement authz.
  H2 [mass-assignment]: array element schema = createTaskSchema / updateTaskSchema VERBATIM (already .strict()). ownerId NEVER from body — service sets ownerId=userId (JWT) per item (existing create() already does; existing toUpdateData() already omits ownerId). No new element→repo mapper.
  H3 [reason enum / non-enumeration]: failed[].reason is a CLOSED CODE enum: NOT_FOUND | VALIDATION | INTERNAL. Map by instanceof: NotFoundError→NOT_FOUND, ValidationError→VALIDATION, else→INTERNAL. NOT_FOUND MUST be identical for a nonexistent UUID and a real-but-foreign UUID (do not add an early "exists?" probe that branches/leaks timing). reason is a code, never a sentence, never err.message.
  H4 [no internal leak]: never set reason=err.message; never let Prisma/stack/field text into the response. Unmapped errors → INTERNAL + request.log.error server-side (mirror error-handler.ts). VALIDATION must NOT echo assignee-existence detail ("No user with this id") — flat token only (assignee existence is itself an enum oracle).
  H5 [DoS/limiter]: each request consumes N limiter units (N = items.length) against the existing 100/min limiter (ADR-014); a 50-item batch costs 50, not 1. Hard cap 50 + 1MB bodyLimit (existing) are sufficient given the cap.
  M1 [validation pre-DB]: body = .strict() object { items: z.array(element).min(1).max(50) }; reject empty (min 1) and 51 (max 50) with the request-level 400/422 BEFORE any DB op. Ids z.string().uuid(). Whole-batch schema failure never touches the DB.
  M2 [duplicate ids]: process per-item independently; a duplicate's 2nd occurrence lands in failed as NOT_FOUND (never a distinct "duplicate" reason — that would itself be an oracle). De-dupe is optional; if de-duped, dropped dup still reported as NOT_FOUND.
  L1 [audit]: emit one audit line PER ITEM with real outcome (success|failure) + resourceId, reusing AUDIT_ACTION.TASK_CREATE/UPDATE/ASSIGN/DELETE. No PII/secret/internal text in audit.
  RESPONSE SHAPE: { succeeded: TaskResponse[], failed: { id, reason }[] } via existing ok() envelope + toTaskResponse. HTTP 200 for the batch even with partial failures (request itself succeeded). ADR-042 is the frozen contract for `reason`.
<!-- /receipt: security-engineer -->

<!-- agent: backend-dev -->
## Backend-Dev Output — Bulk Task Operations — 2026-06-11

### Verdict: NEEDS_REVIEW (H1-H4/M1/M2/L1 DONE; H5 N-weighting requires an orchestrator dep-vs-internals decision — see below). Build green, no regression.

### Files Created/Modified
| File | Action | Purpose |
|------|--------|---------|
| src/tasks/tasks.schemas.ts | Modified | Added `MAX_BULK_ITEMS=50`, `bulkCreateSchema`, `bulkUpdateItemSchema` ({id}∩updateTaskSchema), `bulkUpdateSchema`, `bulkDeleteSchema` — all `.strict()`, `array().min(1).max(50)` (M1/H2). |
| src/tasks/tasks.service.ts | Modified | Added `BULK_FAILURE_REASON` enum + `BulkFailureReason`/`BulkFailure`/`BulkItemOutcome`/`BulkResult`/`InternalErrorSink` types, `toBulkFailureReason` (instanceof map), `toUpdatePayload`, and `bulkCreate`/`bulkUpdate`/`bulkDelete` + private `runEach`/`runItem`/`classify`. Changed `delete()` return `void→Task` (additive; returns deleted snapshot so bulk-delete `succeeded[]` stays uniform `TaskResponse[]`). |
| src/tasks/tasks.routes.ts | Modified | Added 3 thin handlers (`POST /tasks/bulk-create`, `PATCH /tasks/bulk-update`, `DELETE /tasks/bulk-delete`) + `buildBulkResponse` (split outcomes → `{succeeded,failed}` + per-item audit, L1) + `internalSink` (wires `request.log.error`, H4). |
| src/tasks/tasks.bulk.service.smoke.test.ts | Created | 4 backend-dev smoke tests (H3 collapse, H4 INTERNAL+sink, M2 duplicate, create index id). Full matrix owned by qa-engineer. |

No new dependency. tasks.policy.ts NOT modified. No Prisma in routes. No new unscoped repo read.

### Security Controls — Gate-1 satisfaction
- **H1 (IDOR-at-scale)** — DONE. `bulkCreate/Update/Delete` loop the EXISTING `create`/`update`/`delete` service methods verbatim per item. Update→`assertCanAccess` (+`assertIsOwner` on reassign via the existing `'assigneeId' in input` path, preserved by `toUpdatePayload` keeping key presence). Delete→`assertIsOwner`. No bulk-only repo read; authz not reimplemented.
- **H2 (mass-assignment)** — DONE. Element schemas = `createTaskSchema` / `updateTaskSchema` verbatim (`.strict()`). bulk-update element = `z.intersection({id}, updateTaskSchema)` — inherits strict + "≥1 field". `ownerId` never read from body (service sets it from JWT in the reused `create`). `toUpdatePayload` strips only the routing `id`.
- **H3 (reason enum / non-enumeration)** — DONE. `failed[].reason ∈ {NOT_FOUND|VALIDATION|INTERNAL}` closed CODE enum. `toBulkFailureReason` maps by `instanceof` (NotFoundError→NOT_FOUND, ValidationError→VALIDATION, else→INTERNAL). NOT_FOUND byte-identical for missing vs real-but-foreign (smoke-verified); no early exists-probe (reuses unchanged service `findById`, timing parity preserved).
- **H4 (no internal leak)** — DONE. `reason` is never `err.message`. INTERNAL errors pushed to `InternalErrorSink` → `request.log.error({event:'BULK_ITEM_ERROR', itemId, err})` server-side; client sees only the flat token. VALIDATION never echoes assignee-existence detail. Smoke asserts raw Prisma text never appears in outcomes.
- **H5 (DoS/limiter N-weighting)** — PARTIAL / ESCALATED. Hard cap 50 enforced in the Zod wrapper BEFORE any DB op (M1) + existing 1 MB bodyLimit bound worst-case per-request work; global 100/min limiter still applies per request. BUT the exact "1 batch = N units against the shared global counter" is **NOT implemented** — see ESCALATION below. NOT a silent omission; flagged for orchestrator.
- **M1 (validation pre-DB)** — DONE. `{items: array(element).min(1).max(50)}.strict()` / `{ids: array(uuid).min(1).max(50)}.strict()`. Empty→422, 51→422, non-array/unknown-key→422, all via `parseOrThrow` BEFORE the service loop. Never touches DB.
- **M2 (duplicate ids)** — DONE. `runEach` processes per-item SEQUENTIALLY (order-preserving), so a duplicate's 2nd occurrence sees the 1st's effect and naturally yields NOT_FOUND (smoke-verified for delete). No distinct "duplicate" token.
- **L1 (audit)** — DONE. `buildBulkResponse` emits one audit line per item with real `outcome` (success|failure) + `resourceId`, reusing `AUDIT_ACTION.TASK_CREATE` (create), `TASK_ASSIGN`/`TASK_UPDATE` per-item (update, by `'assigneeId' in input.items[i]`), `TASK_DELETE` (delete).
- **RESPONSE** — DONE. `{succeeded: TaskResponse[], failed: {id,reason}[]}` via `ok()` + `toTaskResponse`. HTTP 200 even on partial failure. Create-failure id = array index string (ADR-042 permits; documented).

### H5 ESCALATION (dep-vs-internals — orchestrator decision required)
Investigated `@fastify/rate-limit@9.1.0` (the registered global 100/min limiter in app.ts).
FINDING: v9 has **no weight/points/consume primitive**. `store.incr(key, cb, max, ban)` increments by EXACTLY 1 (LocalStore.js:26 `++current.current`; RedisStore Lua `INCR`). The global hook fires once per request, guarded by a private per-request `rateLimitRan` Symbol that *prevents* re-running the same component. Per-route `config.rateLimit` only sets the threshold (`max`/`timeWindow`), never the increment, and a child store is a SEPARATE counter (breaks "shared global budget").
=> Charging N against the EXISTING global counter is only achievable by (a) reaching into the plugin's PRIVATE store + private `rateLimitRan` Symbol (fragile, unsupported, breaks on minor upgrade, not a public contract) OR (b) adding a NEW dependency with native `consume(key, N)` (e.g. `rate-limiter-flexible`).
Per the H5 protocol ("if the cleanest correct mechanism requires a NEW dependency → STOP and escalate; do not add deps") I did NEITHER. I shipped the dependency-free bound (cap-50 pre-DB + 1MB body) and escalate the N-weighting decision. RECOMMENDATION for orchestrator: either (1) tech-lead approves `rate-limiter-flexible` as a vetted dep for true N-weighting, or (2) security-engineer accepts the cap-50 bound as sufficient mitigation and downgrades H5's N-weighting to a documented MEDIUM, or (3) accept a clearly-encapsulated `incrByN` helper that wraps the plugin store behind one adapter (still couples to internals — security-engineer must bless).

### Build Status
tsc --noEmit: exit 0. Tests: 487 passing (483 pre-existing unchanged + 4 new bulk smoke), 0 failing. The `delete() void→Task` change regressed nothing.

### Open Items
- H5 N-weighting (above) — awaiting orchestrator. Everything else complete.

### H5 Resolution (incrByN adapter) — 2026-06-11 (resumed; ADR-043 ruling implemented)
Orchestrator ruled ADR-043 → Option 3: encapsulated `incrByN`-style adapter over the EXISTING
`@fastify/rate-limit@9.1.0` store, NO new dependency. Implemented exactly per the binding constraints.

**Files created/modified (H5 only — H1-H4/M1/M2/L1 code untouched, tasks.policy.ts untouched):**
| File | Action | Purpose |
|------|--------|---------|
| src/shared/rate-limit-weight.ts | Created | THE ONLY module touching plugin internals. Exposes `chargeAdditionalUnits(request, reply, n)`: charges the additional N−1 units against the SAME global limiter key (plugin re-derives it via its own keyGenerator = client IP). Mechanism: `request.server.rateLimit()` returns the GLOBAL handler over the same plugin component (same store + key); flip the private `Symbol('fastify.request.rateLimitRan')` guard to false before each of the N−1 re-invocations so each does exactly one `store.incr(globalKey)`. n<=1 is a no-op. If the contract symbol is gone → throws (fail-closed, not silent under-count). ADR-043 reference comment at top. |
| src/shared/rate-limit-weight.pin.test.ts | Created | VERSION + INTERNAL-CONTRACT PIN. Asserts installed @fastify/rate-limit === 9.1.0; asserts the 3 contract shapes the adapter rides on: (a) `app.rateLimit()` returns the global handler factory, (b) requests are decorated with the discoverable `fastify.request.rateLimitRan` guard symbol AND the global hook charges exactly 1/request (remaining 99 of 100), (c) re-invoking the handler after flipping the guard increments the global key by exactly +1 each (N=5 → remaining 95). Banner comment: a failure here means the plugin changed internals — re-verify against ADR-043 BEFORE bumping the pin. |
| src/tasks/tasks.routes.ts | Modified | Wired `chargeAdditionalUnits(request, reply, items.length / ids.length)` into all 3 bulk handlers — AFTER `parseOrThrow` (cap-50 guaranteed, n∈[1,50]) and BEFORE the service loop. ADR-043 reference comments at the block + each call site. |
| src/tasks/tasks.bulk-weight.integration.test.ts | Created | 5 integration tests on the REAL app (Prisma faked): 50-item batch costs 50 not 1 (remaining 50); single-item costs exactly 1; cross-request accumulation on the shared key (30+30=60); 429 once two cap-50 batches exhaust 100/min (a single batch can't exceed 100 — cap-50 bounds it pre-DB); bulk-delete weights by ids.length (45). |

**ADR-043 constraint compliance:** (1) adapter is the ONLY module referencing plugin internals — yes;
(2) N charged ONLY after cap-50 validation — yes (charge call is after parseOrThrow); (3) charges the
GLOBAL key, not a child store — yes (uses `app.rateLimit()` no-arg → global component; integration test
proves cross-request accumulation on the shared key); (4) version-pinning test fails on version/contract
drift — yes; (5) CC<10 per function — yes (adapter is one guard + one loop); reuses existing
AppError/ERROR_CODE.RATE_LIMIT/HTTP_STATUS for the 429 (thrown by the plugin's configured
errorResponseBuilder, flows through error-handler's AppError branch); no new dependency.

**429 semantics chosen:** matches the existing limiter — the plugin's own handler throws on
`current > max` during the additional charges, OR a subsequent request is throttled by the global hook.
A single in-flight batch is naturally bounded to ≤50 units by cap-50 (it cannot alone exceed the 100
budget from a cold start), so over-limit only arises from accumulated usage — exactly the shared-budget
DoS ceiling H5 targets.

**PRE-EXISTING ISSUE FOUND (NOT H5, NOT FIXED — frozen code, flagged for triage):** the EXISTING
`bulkUpdateItemSchema` (`z.intersection({id}, updateTaskSchema)`) REJECTS any real `{id, ...}` element
with `unrecognized_keys: ['id']`, because the `.strict()` `updateTaskSchema` side flags `id` as unknown.
This means the PATCH /tasks/bulk-update route currently 422s on every valid-looking payload. No HTTP
integration test existed to catch it (qa-engineer's matrix was handed off, not yet written). This is in
the frozen H1-H4 code (I did NOT touch it per the resume constraint). My weighting integration test
therefore covers the create (POST) + delete (DELETE) routes end-to-end; bulk-update weighting is wired
identically (verified by inspection) but cannot be driven to 200 over HTTP until the schema bug is fixed.
RECOMMEND qa-engineer/security-engineer triage the `bulkUpdateItemSchema` intersection (likely needs
`updateTaskSchema.extend({ id: ... })` or a `.merge`, not an intersection-with-strict).

**Build:** tsc --noEmit exit 0. Tests: 496 passing (487 prior = 483 baseline + 4 smoke, all green; + 9
new: 4 pin + 5 weighting), 0 failing, 36 files. No regression.

### H6 bulkUpdateItemSchema fix — 2026-06-11 (the flagged pre-existing bug, now FIXED)
The intersection bug I surfaced during H5 is fixed. `z.intersection({id}, updateTaskSchema)` 422'd every
real `{id, ...}` element because the strict `updateTaskSchema` side flagged `id` as an unknown key,
breaking `PATCH /tasks/bulk-update` for ALL valid payloads.

**Files modified (schema-only; H5 adapter, tasks.policy.ts, reason enum, service methods all untouched):**
| File | Action | Purpose |
|------|--------|---------|
| src/tasks/tasks.schemas.ts | Modified | Split the partial-update shape into a standalone strict `updateTaskObject` (ZodObject, extendable). `updateTaskSchema` = `updateTaskObject.refine(≥1 field)` (unchanged behavior — `.refine` wraps in ZodEffects which has no `.extend`, hence the split). `bulkUpdateItemSchema` = `updateTaskObject.extend({ id: uuid }).refine(≥1 update field, counting fields EXCLUDING id)`. Replaces the broken `z.intersection`. |
| src/tasks/tasks.bulk-update-item-schema.test.ts | Created | 5 regression tests: valid `{id,title}` ACCEPTED; `{id}`-only REJECTED (≥1-field rule survives extend); `{id,unknownKey}` REJECTED (strict survives extend); `{id,ownerId}` REJECTED (H2 mass-assignment intact); `{id,assigneeId:null}` ACCEPTED + key-presence preserved (H1/L1 `'assigneeId' in input` path). |

**Properties preserved (verified):** (a) accepts `{id}` + 1+ update fields; (b) `.strict()` survives
`.extend()` — no keys beyond `id`+known update fields (mass-assignment H2 intact, `ownerId` never accepted);
(c) "≥1 update field" survives via a re-applied refine that counts update fields with `id` excluded, so
`{id}` alone is rejected; (d) key-presence semantics preserved — `BulkUpdateItem` type unchanged in shape,
`toUpdatePayload`'s `{ id: _id, ...update }` still strips ONLY `id`, so the service's `'assigneeId' in input`
reassign-detection (H1/L1) fires identically. No security property weakened; no other bulk method changed.
`toUpdatePayload` confirmed by inspection — strips only `id`, no change needed.

**Build:** tsc --noEmit exit 0. Tests: 501 passing (496 prior all green + 5 new H6 regression), 0 failing,
37 files. The pre-existing `tasks.routes.integration.test.ts` (23 tests) had NO bulk-update case (confirms
the bug was genuinely uncaught) — my fix flips no existing assertion; purely additive.
<!-- /agent: backend-dev -->

<!-- receipt: backend-dev -->
AGENT: backend-dev
STATUS: DONE
TIER: 3
COMPLETED: Bulk task ops (BULK-2026-06-11) — H5 N-weighting (ADR-043 incrByN adapter) implemented; all 8 Gate-1 controls now satisfied. tsc 0, 496 tests green (487 prior + 9 new). H5 was the only open item; it is now closed.
KEY_DECISIONS:
- H5 RESOLVED per ADR-043 Option 3: new src/shared/rate-limit-weight.ts is the ONLY module touching @fastify/rate-limit@9.1.0 internals. `chargeAdditionalUnits(req,reply,n)` charges N−1 extra units on the SAME global key (via `req.server.rateLimit()` global handler + flipping the private rateLimitRan guard symbol so each re-invocation does one store.incr on the global key). No new dep. No child store. n<=1 no-op. Wired into all 3 bulk handlers AFTER cap-50 validation, BEFORE the service loop. Reuses AppError/RATE_LIMIT/429 (thrown by the plugin's existing errorResponseBuilder).
- Version-pinning test (rate-limit-weight.pin.test.ts) asserts version===9.1.0 + the 3 internal contract shapes (global handler factory, discoverable rateLimitRan symbol + 1-unit/request, +1-per-extra-invocation). Fails LOUDLY on plugin upgrade/contract drift with a banner saying "re-verify against ADR-043 before bumping the pin".
- H6 FIXED (2026-06-11): the pre-existing `bulkUpdateItemSchema = z.intersection({id}, updateTaskSchema)` bug (rejected every {id,...} element — 'id' unrecognized by the strict updateTaskSchema side → PATCH /tasks/bulk-update 422'd all real payloads) is now FIXED. Schema-only change: split out a standalone strict `updateTaskObject`; `bulkUpdateItemSchema = updateTaskObject.extend({id:uuid}).refine(≥1 update field excluding id)`. `.strict()` + ≥1-field + key-presence ALL preserved; H2 mass-assignment intact (ownerId still never accepted); H5 adapter / tasks.policy.ts / reason enum / service methods / toUpdatePayload untouched (toUpdatePayload still strips only id — confirmed). +5 regression tests. tsc 0, 501 tests green (496 prior + 5 new), 0 regressions.
BLOCKERS: none
RECOMMENDED_NEXT: security-engineer — ADR-043 constraint #5 requires re-bless of the rate-limit-weight adapter (touches middleware/rate-limiting) before Gate-1 close-out; also triage the bulkUpdateItemSchema bug above. THEN qa-engineer ‖ code-quality on the full bulk impl.
HANDOFF_NOTES:
  security-engineer — RE-REVIEW src/shared/rate-limit-weight.ts (the ONLY plugin-internals coupling, fenced per ADR-043). Verify: (a) charges the GLOBAL key not a child store [integration test proves cross-request accumulation on the shared key]; (b) N only charged after cap-50 [charge is post-parseOrThrow]; (c) fail-closed if the guard symbol vanishes [throws, not silent under-count]; (d) the pin test guards the contract. Also rule on the bulkUpdateItemSchema intersection bug (likely fix: updateTaskSchema.merge/extend with {id} instead of intersection — this is in the frozen H1-H4 code, needs your blessing to touch).
  qa-engineer — NEW files for H5: src/shared/rate-limit-weight.ts (adapter), src/shared/rate-limit-weight.pin.test.ts (4 tests), src/tasks/tasks.bulk-weight.integration.test.ts (5 tests). The original bulk handoff edge cases (H3 collapse, H4 INTERNAL, M2 dup, partial-success, audit) still stand for tasks.routes/service/schemas. NOTE the bulkUpdateItemSchema bug blocks PATCH bulk-update HTTP coverage until fixed. You own >95% coverage on the adapter + bulk routes.
  code-quality — adapter HOTSPOT: chargeAdditionalUnits is one guard-clause + one loop (CC well under 10); it contains one documented boundary type-assertion at the plugin-internals seam (ADR-043 explicitly fences this here) + a symbol-keyed record cast — both isolated to this one module by design, not slop. Pin test uses casts only to reach plugin internals for the contract assertions.
<!-- /receipt: backend-dev -->

<!-- agent: qa-engineer -->
## QA-Engineer Output — Bulk Task Operations (BULK-2026-06-11) — 2026-06-11

### Verdict: DONE. 543 tests green (501 baseline + 42 new), 40 files, tsc --noEmit exit 0, zero regressions. New bulk code: 100% line everywhere; branch 100% on service/schemas/adapter (routes branch 96.87%, sole gap is a PRE-EXISTING single-task handler line, NOT bulk code). Two LOW observations (no P1/HIGH functional bugs).

### Test Summary
| Test file | Tests | Pass | Fail | Layer |
|-----------|-------|------|------|-------|
| src/tasks/tasks.bulk.routes.integration.test.ts (NEW) | 34 | 34 | 0 | HTTP route-integration (real app, Prisma faked) |
| src/shared/rate-limit-weight.test.ts (NEW) | 5 | 5 | 0 | Adapter unit (drives the exported `chargeAdditionalUnits`) |
| src/tasks/tasks.bulk.service.coverage.test.ts (NEW) | 3 | 3 | 0 | Service unit (default no-op sink / H4 mapping) |
| **Total new** | **42** | **42** | **0** | |
| Pre-existing suite | 501 | 501 | 0 | unchanged, no flips |

Route-integration covers all 8 of backend-dev's edge-case groups at the HTTP boundary:
1. **M1 validation pre-DB** — empty / 51-over-cap / non-array / unknown-key element / non-uuid id / unknown top-level key → all 422, `store.tasks.size===0` asserts no DB touch; all 3 endpoints. + 401 auth-gate-before-validation.
2. **H3 non-enumeration** — bulk-update AND bulk-delete: `{nonexistent uuid, real-but-foreign uuid}` → byte-identical `NOT_FOUND`; asserted `absent.reason===foreign.reason`, regex-asserted NO `FORBIDDEN/OWNER/EXISTS` token; foreign row provably un-mutated/un-deleted. + assignee-attempts-delete → NOT_FOUND not 403.
3. **H4 no-leak** — forced repo throw (`vi.spyOn(fake.prisma.task,'create').mockRejectedValueOnce`) → reason=`INTERNAL`, response payload asserted to contain NEITHER the secret error string NOR `/stack|prisma|column/i`. + all-fail batch still HTTP 200.
4. **M2 duplicate ids** — same id twice in delete → 2nd = NOT_FOUND, row gone; same id twice in update (both owned) → both succeed, last-write-wins (proves independent per-item processing, no silent dedupe).
5. **Partial success** — mixed ok+foreign+absent on bulk-update → HTTP 200, correct {succeeded:1, failed:2} split; all-valid bulk-create → all succeeded; all-fail → still 200.
6. **create index id + reassign-by-non-owner** — create failure `id==="1"` (array index, ADR-042); VALIDATION reason never echoes "No user with this id"/assignee detail; assignee reassign item → NOT_FOUND while the assignee's content-update item in the same batch succeeds, reassign provably not applied.
7. **L1 audit** — audit module mocked to capture lines (test-env pino is no-op): exactly one line per item, correct success/failure outcome + resourceId per item; TASK_ASSIGN vs TASK_UPDATE action mapping by `'assigneeId' in element`; create audits one line/item, all success.
8. **H6 end-to-end (regression)** — `{id,title}` ACCEPTED + applied (was 422 for ALL payloads pre-fix); `{id,assigneeId:null}` unassign round-trips; `{id}`-only → 422 (≥1-field rule survives `.extend()`); multi-item mixed-field round-trip; description-field round-trip. **Proves PATCH /tasks/bulk-update works end-to-end now.**

PLUS security-engineer MUST-HAVE + H5:
- **Fail-closed DoS control** (`rate-limit-weight.test.ts`): drives the REAL exported `chargeAdditionalUnits` with a request carrying NO `rateLimitRan` guard symbol → asserts it THROWS `/rate-limit weighting unavailable/i` (NOT silent under-count). Proves H5 cannot silently reopen. Also: n<=1 short-circuits before the symbol lookup (no-op even without the symbol); n=10 charges exactly 9 extra units (remaining 90). The pin test only reimplements the loop inline; THIS file is the first to execute the adapter's own guard/loop/no-op branches → adapter now 100%/100%.
- **H5 route-level weighting**: backend-dev's bulk-weight integration already covers create+delete; bulk-update weighting is wired identically (verified by inspection + now that H6 unblocks it, the update HTTP path round-trips at 200, confirming the `chargeAdditionalUnits(...,items.length)` call fires before the service loop without error).

### Coverage Report (NEW code)
| File | Line% | Branch% | Note |
|------|-------|---------|------|
| src/shared/rate-limit-weight.ts | 100 | 100 | adapter fully exercised (fail-closed + no-op + loop) |
| src/tasks/tasks.schemas.ts | 100 | 100 | bulk* schemas + H6 bulkUpdateItemSchema |
| src/tasks/tasks.service.ts | 100 | 100 | bulk methods + runEach/runItem/classify + toBulkFailureReason + toUpdatePayload; description branch closed |
| src/tasks/tasks.routes.ts | 100 | 96.87 | bulk handlers + buildBulkResponse + internalSink 100%; sole uncovered branch = line 109, the PRE-EXISTING single-task PATCH `'assigneeId' in input` ternary (out of scope, untouched) |
Project totals: Lines 99.35% / Branches 97.57% / Functions 99.09%. Meets task target (>95% line on new code) and CLAUDE.md floors (≥90% line / ≥85% branch on new code).

### Bugs Found
| Bug | Severity | Reproduction | Regression test |
|-----|----------|--------------|-----------------|
| (none functional / P1 / HIGH) | — | — | — |

### Observations (LOW — documented, NOT shipping blockers, do NOT route to backend-dev as P1)
- **L-A1 (audit fidelity):** on bulk-CREATE the L1 audit `resourceId` carries the array INDEX ("0","1"), not the created task's UUID (because the per-item outcome id is the array index for create — ADR-042, no client id pre-creation). Attribution IS recoverable from the response `succeeded[].id`, but the audit line alone does not name the created row. Asserted as current behavior in `should_emit_one_create_audit_line_per_item_with_success_outcome`. Consistent with ADR-042; flag for quality-lead to accept-as-is or have backend-dev enrich the create-success audit id from `outcome.task.id`.
- **L-A2 (test-fixture, self-inflicted, resolved):** non-UUID seed ids initially 422'd the bulk-update/delete payloads (the bulk schemas require `z.string().uuid()` ids). Fixed in-test by seeding real UUIDs. This is a positive signal: the request-level UUID validation (M1) is real and rejects malformed ids before any per-item logic — captured implicitly by the Group-1 non-uuid-id 422 test.

### Security Controls Verified (from security-engineer Gate-1 checklist)
| Control | Tested at HTTP/route level | Result |
|---------|----------------------------|--------|
| H1 IDOR-at-scale | foreign-id update/delete → NOT_FOUND, row un-mutated; reassign-by-non-owner per-item NOT_FOUND | tested ✓ |
| H2 mass-assignment | unknown-key element (`ownerId`) → 422; `.strict()` survives `.extend()` | tested ✓ |
| H3 reason enum / non-enumeration | nonexistent≡foreign byte-identical NOT_FOUND (update+delete); no FORBIDDEN/distinct token | tested ✓ |
| H4 no-leak | forced INTERNAL → flat token, payload free of secret/stack/prisma; VALIDATION never echoes assignee detail | tested ✓ |
| H5 DoS N-weighting + FAIL-CLOSED | adapter throws when guard symbol absent (MUST-HAVE); n-1 extra units charged; n<=1 no-op | tested ✓ |
| M1 validation pre-DB | empty/over-cap/non-array/unknown-key/non-uuid → 422, no DB touch (all 3 routes) | tested ✓ |
| M2 duplicate ids | 2nd occurrence NOT_FOUND (delete); independent processing (update) | tested ✓ |
| L1 per-item audit | one line/item, real outcome + resourceId, ASSIGN/UPDATE mapping (see L-A1 nuance for create id) | tested ✓ |

### Verdict: DONE
<!-- /agent: qa-engineer -->

<!-- receipt: qa-engineer -->
AGENT: qa-engineer
STATUS: DONE
TIER: 3
COMPLETED: Route-integration + coverage for bulk task ops (BULK-2026-06-11). 42 new tests across 3 files (34 HTTP route-integration covering all 8 edge-case groups + 5 adapter unit incl. the fail-closed MUST-HAVE + 3 service no-op-sink coverage). 543 tests green (501 baseline, 0 regressions), 40 files, tsc 0. New bulk code: 100% line (service/schemas/adapter also 100% branch; routes 100% line / 96.87% branch, sole gap pre-existing single-task code). Target >95% line on new code MET.
KEY_DECISIONS:
- Verified the security-engineer MUST-HAVE by driving the REAL exported chargeAdditionalUnits (not the pin test's inline re-impl): a request with the rateLimitRan guard symbol ABSENT makes it THROW, not silently under-count — closing the H5 fail-closed DoS branch the pin test never executed. Adapter now 100%/100%.
- H6 proven end-to-end over HTTP: PATCH /tasks/bulk-update with {id,field} now 200s + applies (was 422 for ALL payloads before the schema fix). Surfaced+fixed a self-inflicted test-fixture trap (non-UUID seed ids 422 at the schema layer) which doubly confirms M1 request-level UUID validation is real.
- L1 audit asserted by mocking the audit module (test-env pino is a no-op so calls are otherwise unobservable): one line/item, correct outcome+resourceId, ASSIGN/UPDATE mapping.
BLOCKERS: none
RECOMMENDED_NEXT: quality-lead — Gate-3 (test coverage) is GREEN; code-quality already reported CLEAN (no P1/P2). All four gates' inputs are in. Proceed to SHIP IT / FIX IT.
HANDOFF_NOTES: Two LOW observations for quality-lead to rule on (NEITHER is a P1, do NOT route to backend-dev as a blocker): (L-A1) bulk-CREATE L1 audit resourceId is the array index ("0","1"), not the created task UUID (attribution recoverable via response succeeded[].id; consistent with ADR-042 create-id-is-index). quality-lead may accept-as-is or request backend-dev enrich create-success audit id from outcome.task.id. (L-A2) resolved in-test, informational only. The one residual uncovered branch (tasks.routes.ts:109) is the PRE-EXISTING single-task PATCH assignee ternary — out of bulk scope, untouched.
<!-- /receipt: qa-engineer -->

<!-- agent: code-quality -->
## Code-Quality Output — Bulk Task Operations — 2026-06-11

### Verdict: CLEAN — no P1, no P2 blockers. Differential review of the bulk surface only.

Context-budget compliance: grepped my tags (`<!-- agent: code-quality -->`, `<!-- domain: quality -->`, `<!-- domain: backend -->`) + the backend-dev receipt/section. Read brief.md lines 4716-4876 only (~160 of 4910 lines, ~3.3%). decisions.md: 43 ADRs total; ADR-042 (bulk reason enum) + ADR-043 (rate-limit weighting) matched my domains — both already summarized in the backend-dev handoff, read inline, not re-opened.

### Tooling run
- `tsc --noEmit`: exit 0 (clean).
- `vitest run`: 501/501 pass, 37 test files.
- `vitest run --coverage`: overall 99.02% line / 96.94% branch / 98.63% func (IMPROVED vs baseline 98.74/95.0/98.17).
- `check-slop.ps1 -Path src/tasks` and `-Path src/shared/rate-limit-weight.ts`: both ✅ CLEAN (0 P1, 0 P2).
- `eslint`: NOT runnable — repo has no eslint config file (`ESLint couldn't find a configuration file`). PRE-EXISTING environmental gap, not introduced by this task; tsc is the substantive static gate and passes. (P3 infra note for devops/tech-lead: add `.eslintrc` so `npm run lint` works.)

### Hotspot cyclomatic complexity (hard limit 10 — all PASS)
| Function | File | CC | Verdict |
|---|---|---|---|
| buildBulkResponse | tasks.routes.ts | 4 | PASS — forEach + if/else-if + 1 ternary; thin, no god-branching |
| runEach | tasks.service.ts | 2 | PASS — one for-loop; generic seq mapper, single responsibility |
| runItem | tasks.service.ts | 2 | PASS — one try/catch |
| classify | tasks.service.ts | 2 | PASS — one if |
| bulkCreate/Update/Delete | tasks.service.ts | 1 each | PASS — pure delegation to runEach |
| toBulkFailureReason | tasks.service.ts | 3 | PASS — instanceof map |
| toUpdatePayload | tasks.service.ts | 1 | PASS |
| chargeAdditionalUnits | rate-limit-weight.ts | 4 | PASS — n<=1 guard + symbol-undef guard + for-loop |
| findRateLimitRanSymbol | rate-limit-weight.ts | 2 | PASS |
| omitId | tasks.schemas.ts | 1 | PASS |
| bulkUpdateItemSchema refine | tasks.schemas.ts | 1 | PASS |

Max per-function CC across the entire change = **4**. The runItem/classify/runEach decomposition is NOT over-abstraction: each is independently testable, named for its single job, and removes the only path to a god-function. Confirmed genuine, not slop.

### Hotspot-by-hotspot (backend-dev's flagged 5)
1. **buildBulkResponse** — CC 4 < 10. CONFIRMED. Clean split/audit, no duplicated aggregation; the 3 handlers share it (no copy-paste).
2. **runItem/classify/runEach** — CC 2/2/2. CONFIRMED decomposed, NOT a god-function and NOT over-abstraction. The 3 bulk methods all funnel through `runEach` → zero duplicated loop/try-catch/classify logic (DRY satisfied — the H5 concern "share runEach not copy-paste" is met).
3. **bulkUpdateItemSchema (H6 fix)** — CONFIRMED clean, not a hack. `updateTaskObject` (refine-free strict base) + `updateTaskSchema = base.refine(≥1)` + `bulkUpdateItemSchema = base.extend({id}).refine(≥1 excl id)`. The split is the idiomatic Zod answer to "ZodEffects has no .extend()"; documented at the definition. `.strict()` + ≥1-field + key-presence all preserved through extend. The small `omitId` helper (CC 1) keeps the refine readable.
4. **delete() void→Task** — CONFIRMED no dead code. Both callers handle it correctly: single-route `app.delete('/tasks/:id')` `await`s and ignores the return (204 path, intentional); service `bulkDelete` consumes it via runItem. No leftover no-body branch. Additive, non-breaking.
5. **rate-limit-weight.ts (ADR-043)** — JUDGED ON QUALITY ONLY (not re-litigating the blessed security/ADR decision). The internals coupling is cleanly fenced to ONE module, prefaced by a thorough WHY/MECHANISM block, single-responsibility (charge N−1 units), CC 4, fail-closed (throws if the guard symbol vanishes rather than silently under-counting), no copy-paste. The two type-assertions (`rateLimit()` view + symbol-keyed record) are each documented at the seam and isolated here by design. Quality: clean.

### DRY / naming / dead-code / layer integrity
- **DRY**: PASS. No duplicated URL/normalization/aggregation logic. The 3 bulk methods share `runEach`/`runItem`/`classify`. Note: `omitId` (schemas, refine-counting) and `toUpdatePayload` (service, payload-mapping) both destructure `{id:_id,...rest}` — this is NOT a DRY violation: different layers, different intents; unifying them would create a wrong cross-layer dependency. Correctly kept separate.
- **Naming**: PASS. `chargeAdditionalUnits`, `buildBulkResponse`, `runItem`, `classify`, `internalSink`, `BulkItemOutcome` all reveal intent. No abbreviations beyond `id`/`uuid`/`n` (n documented as batch size).
- **Dead code**: NONE. `NOOP_INTERNAL_SINK` default is exercised by existing tests (its empty-body line is the only intentional non-cover at service:82-83). No unused imports/params/branches.
- **Layer integrity**: PASS. No Prisma in routes. Handlers parse→charge→delegate→audit→format only; ALL authz orchestration (assertCanAccess/assertIsOwner) stays in the service via the reused single-item paths. `tasks.policy.ts` untouched.
- **Magic numbers**: PASS. `MAX_BULK_ITEMS=50` named; `n-1`/`n<=1` are arithmetic, documented.
- **Error handling**: PASS. Per-item try/catch in runItem; INTERNAL routed to server-side sink (H4); fail-closed throw in the adapter. No empty catch, no swallow.

### P2 Findings (document, ship)
| ID | File:Line | Issue | Recommendation |
|----|-----------|-------|----------------|
| Q-BULK-1 | src/tasks/tasks.service.ts (427 lines) | File grew 158→427 lines, over the 300 "acceptable" threshold (under the 500 "warning"). Cause is the bulk surface + dense JSDoc (~58% of the file is comments). | Not a blocker (per-function CC all ≤4, well-organized). If the file keeps growing, consider extracting the bulk orchestration (BulkResult types + runEach/runItem/classify + bulkCreate/Update/Delete) into `tasks.bulk.service.ts`. Logged to baseline as a file-length watch. |

### P3 Notes
- eslint config absent repo-wide — `npm run lint` cannot run (infra gap, not this task's regression). Recommend devops add `.eslintrc`.
- `n` param in `chargeAdditionalUnits` is terse but documented; acceptable.

### Baseline update (CLAUDE.md "Quality Baseline")
`.quality-baseline.json` **1.1.0 → 1.2.0**. Changes:
- coverage line 98.74→99.02, branch 95.0→96.94, func 98.17→98.63 (all IMPROVED; new bulk code above 90/85 thresholds — service 99.29/93.87, routes 94.25/95.83, schemas 100/100, rate-limit-weight 93.16/88.88).
- complexity: tasks.service.ts 17→25 pts (158→427 ln, LOW, P2 length note), tasks.routes.ts 1→5 (110→174), tasks.schemas.ts 1→2 (67→142); ADDED src/shared/rate-limit-weight.ts (5 pts, 117 ln, LOW).
- source_files 36→37, test_files 13→17, last_updated + updated_by bumped.

### Verdict: CLEAN — Gate 2 (Code Quality) PASS. No P1. One P2 (file-length watch, non-blocking). Routes to quality-lead for final SHIP IT.
<!-- /agent: code-quality -->

<!-- receipt: code-quality -->
AGENT: code-quality
STATUS: DONE
TIER: 3
COMPLETED: Code-quality review of the bulk task surface (BULK-2026-06-11) — tasks.routes/service/schemas + shared/rate-limit-weight. Verdict CLEAN, Gate 2 PASS.
KEY_DECISIONS:
- All 5 backend-dev hotspots PASS the CC<10 hard limit. Max per-function CC across the entire change = 4 (buildBulkResponse 4, runEach/runItem/classify 2/2/2, chargeAdditionalUnits 4). runItem/classify/runEach decomposition confirmed genuine single-responsibility, NOT over-abstraction; the 3 bulk methods share runEach (DRY satisfied, no copy-paste). slop script CLEAN on both paths; tsc 0; 501/501 tests.
- No P1. One P2 (Q-BULK-1): tasks.service.ts grew 158→427 lines (>300 acceptable, <500 warning; ~58% JSDoc) — file-length WATCH, non-blocking; future extraction of bulk orchestration to tasks.bulk.service.ts suggested. P3: repo has no eslint config (pre-existing, npm run lint can't run) — infra note for devops.
- Baseline bumped 1.1.0 → 1.2.0: coverage IMPROVED (line 98.74→99.02, branch 95.0→96.94, func→98.63); added rate-limit-weight.ts entry; updated tasks.service/routes/schemas complexity+lines; source_files 36→37, test_files 13→17.
BLOCKERS: none
RECOMMENDED_NEXT: quality-lead — Gate 2 (Code Quality) is GREEN with zero P1. Combine with qa-engineer + the BLESSED security Gate-1 for the final SHIP IT call. The single P2 (file-length watch) is non-blocking and logged in the baseline.
HANDOFF_NOTES: quality-lead — code quality is CLEAN, no fix-it loop back to backend-dev needed. The only open item is Q-BULK-1 (P2 file-length on tasks.service.ts) which is documented, not a blocker; defer with the recorded resolution plan (extract bulk orchestration if the file grows further). eslint-config absence (P3) is environmental/pre-existing, route to devops separately, do not gate this feature on it.
<!-- /receipt: code-quality -->

<!-- agent: quality-lead -->
## Quality-Lead Output — Bulk Task Operations (BULK-2026-06-11) — 2026-06-11

### VERDICT: SHIP IT ✅

Final go/no-go: **SHIP IT**. All four quality gates GREEN, every input independently
re-verified against the live repo (not trusted from receipts). Zero open Critical/High
security findings, zero P1 code-quality findings, coverage well above both the task target
(>95% line on new code) and the CLAUDE.md floors (≥90% line / ≥85% branch). Two LOW
observations and two non-blocking quality items deferred with justification (below).

### Independent Verification (re-ran the commands myself)
| Check | Command | Observed result | Reported | Match |
|-------|---------|-----------------|----------|-------|
| Build | `npx tsc --noEmit` | exit 0 | exit 0 | ✓ |
| Tests | `npx vitest run --coverage` | **543 passed / 0 failed**, 40 files, exit 0 | 543 (501+42), 40 files | ✓ |
| Baseline regression | (483 original baseline tests inside the 501) | 543 green ⊃ 501 prior ⊃ 483 original — no flips | no regression | ✓ |
| Project coverage | v8 summary | **Line 99.35% / Branch 97.57% / Func 99.09%** | 99.35 / 97.57 / 99.09 | ✓ |
| Dep scope | package.json | `@fastify/rate-limit ^9.1.0` — NO new dependency | no new dep (ADR-043) | ✓ |
| Baseline file | .quality-baseline.json | version **1.2.0**, updated_by code-quality (BULK-2026-06-11) | 1.1.0→1.2.0 | ✓ |
| H5 adapter present | ls src/shared/ | rate-limit-weight.ts + .pin.test.ts both exist | created | ✓ |

New-code coverage from the v8 table (the load-bearing numbers):
- src/tasks/tasks.service.ts — **100% line / 100% branch** (bulk methods + runEach/runItem/classify + toBulkFailureReason + toUpdatePayload)
- src/tasks/tasks.schemas.ts — **100% / 100%** (bulk* schemas + H6 bulkUpdateItemSchema)
- src/shared/rate-limit-weight.ts — **100% / 100%** (fail-closed + no-op + loop all exercised)
- src/tasks/tasks.routes.ts — **100% line / 96.87% branch**; the SOLE uncovered branch is line 109,
  the PRE-EXISTING single-task PATCH `'assigneeId' in input` ternary — out of bulk scope, untouched.
  This is NOT a coverage gap on new code; new-code line coverage is effectively 100%.

### Gate-by-Gate
**GATE 1 — Security: PASS (BLESSED).** security-engineer issued DONE; the scoped H5/H6 re-review
(post-ADR-043, post-H6-fix) is BLESSED with ZERO open Critical/High. H1-H5 + M1/M2/L1 all SATISFIED.
- H5 incrByN adapter closes the DoS amplification EXACTLY as ADR-043 Option 3 intended — charges the
  GLOBAL key (not a child store; cross-request accumulation proven), N charged only AFTER cap-50 (n∈[1,50]),
  **FAILS CLOSED** (throws if the rateLimitRan guard symbol vanishes — never silent under-count), no new dep,
  coupling fenced in ONE module + a CI version-pin test. The fail-closed branch has an explicit executing test
  (qa rate-limit-weight.test.ts), not just the pin test's inline re-impl.
- H6 schema fix (z.intersection → updateTaskObject.extend({id}).refine) did NOT reopen H2/CWE-915:
  `.extend()` preserves `.strict()`, ownerId still rejected, ≥1-field rule survives, key-presence intact.
- ADR-042 (reason-enum non-enumeration contract) and ADR-043 (N-weighting) read in full; both Accepted.

**GATE 2 — Code Quality: PASS (CLEAN).** code-quality verdict CLEAN. Max per-function CC across the entire
change = **4** (buildBulkResponse 4, chargeAdditionalUnits 4, runEach/runItem/classify 2/2/2) — far under the
hard limit of 10. slop script CLEAN on src/tasks and the adapter. DRY/naming/dead-code/layer-integrity all PASS.
tasks.policy.ts untouched. Baseline bumped 1.1.0→1.2.0 (coverage IMPROVED on every axis). No P1.

**GATE 3 — Test Coverage: PASS.** Independently re-ran the suite WITH coverage. 543/543 green, 0 flaky,
0 regressions; the 483 original baseline tests (subset of the 501 prior) all still pass. New-code line
coverage = 100% on service/schemas/adapter and 100% line on routes (sole branch gap is pre-existing
single-task code). Meets the >95% new-code task requirement AND the ≥90% line / ≥85% branch CLAUDE.md floor.

**GATE 4 — Final Approval: SHIP IT.** All gate items resolved; fix list empty; open items deferred with
justification. No fix-it loop back to backend-dev required.

### Open-Item Adjudication
| ID | Source | Disposition | Justification |
|----|--------|-------------|---------------|
| L-A1 | qa LOW | **DEFER (accept-as-is, P3)** | bulk-CREATE L1 audit resourceId is the array index ("0","1") not the created UUID. ADR-042 explicitly makes create-id-the-index (no client id pre-creation); attribution is fully recoverable from the response `succeeded[].id`. Not a security/correctness defect — the audit line still records actor + outcome + action; only the resource handle is the index. NOT ship-blocking, NOT a P2 (does not endanger future modification or leak data). Logged as a P3 enhancement: if richer audit forensics are later required, backend-dev can enrich the create-success audit id from `outcome.task.id`. Tracked, not gated. |
| L-A2 | qa LOW | **NO ACTION (resolved)** | Test-fixture only (non-UUID seed ids); resolved in-test. Informational — actually a positive signal that M1 request-level UUID validation is real. |
| Q-BULK-1 | code-quality P2 | **DEFER (document, ship)** | tasks.service.ts grew to 427 lines — OVER the 300 "acceptable" mark but UNDER the 500 "warning" threshold, and ~58% is JSDoc. Every function in the file is CC ≤4. Non-blocking. Resolution plan recorded in baseline: extract bulk orchestration (BulkResult types + runEach/runItem/classify + bulk* methods) into tasks.bulk.service.ts IF the file crosses 500. File-length WATCH only. |
| P3 (eslint) | code-quality P3 | **DEFER → route to devops** | Repo has no eslint config (`npm run lint` cannot run). PRE-EXISTING environmental gap, NOT introduced by this task; tsc is the substantive static gate and passes clean. Do not gate this feature on it. RECOMMENDED_NEXT for orchestrator to route devops/tech-lead to add `.eslintrc` as separate infra work. |

### P1 Findings (must fix before ship)
NONE. (No fix-it loop required.)

### P2 Findings (document, ship)
- Q-BULK-1 — tasks.service.ts file-length watch (see adjudication). Scheduled for: future extraction if file > 500 lines.

### P3 Notes (logged, non-blocking)
- L-A1 — create-audit resourceId is array index (ADR-042-consistent; recoverable via succeeded[].id).
- eslint config absent repo-wide — route to devops as separate infra task.

### Context-budget compliance (reported)
- (a) Tags grepped: `<!-- agent: quality-lead -->`, `<!-- domain: quality -->`, `<!-- domain: security -->`, `<!-- domain: backend -->`.
- (b) brief.md line ranges read: 4533-4732, 4732-4931, 4930-5030 (the BULK task block: orchestrator H5 ruling,
  security-engineer Gate-1 + H5/H6 re-review + receipt, backend-dev section + receipt, qa-engineer section +
  receipt, code-quality section + receipt, my own stub). ~500 of 5031 lines.
- (c) Lines read ≈ 500 of 5031 total (~10%). Did NOT read the ~4500 lines of unrelated prior tasks.
- (d) decisions.md: **43 ADRs total**; **2 matched my domains** (ADR-042 security, ADR-043 security/backend/infra);
  read BOTH in full.

### Verdict: SHIP IT
RECOMMENDED_NEXT: tech-writer (document the 3 bulk endpoints + the failed.reason enum contract + ADR-042/043).
<!-- /agent: quality-lead -->

<!-- receipt: quality-lead -->
AGENT: quality-lead
STATUS: DONE
TIER: 4
COMPLETED: Final go/no-go gate for bulk task ops (BULK-2026-06-11). All 4 gates independently re-verified against the live repo (not trusted from receipts): tsc --noEmit exit 0; vitest run --coverage = 543/543 passed, 0 failed, 40 files, 0 flaky, 0 regressions (483 original baseline subset all green); project coverage 99.35% line / 97.57% branch / 99.09% func; new bulk code 100% line on service/schemas/adapter and 100% line / 96.87% branch on routes (sole branch gap = pre-existing single-task line 109, out of scope); @fastify/rate-limit ^9.1.0 (no new dep); .quality-baseline.json confirmed at 1.2.0.
KEY_DECISIONS:
- VERDICT: **SHIP IT**. Zero P1 findings. Gate 1 (Security) BLESSED — zero open Critical/High, H1-H5/M1/M2/L1 satisfied, H5 incrByN adapter fails-closed (verified adapter file + its test exist). Gate 2 (Code Quality) CLEAN — max CC=4, slop CLEAN, baseline bumped. Gate 3 (Coverage) PASS — re-ran myself, exceeds >95% new-code target AND the ≥90/≥85 floor. Gate 4: SHIP IT.
- L-A1 (create-audit resourceId = array index) DEFERRED as P3 accept-as-is: ADR-042-consistent (no client id pre-creation), attribution recoverable via response succeeded[].id — not a security/correctness defect, NOT a P2, optional future enrichment.
- Q-BULK-1 (tasks.service.ts 427 lines) DEFERRED as P2 document-and-ship: under the 500 warning threshold, every fn CC≤4, ~58% JSDoc; extract bulk orchestration to tasks.bulk.service.ts only if file crosses 500. eslint-config absence is a PRE-EXISTING P3 infra gap → route to devops separately, do NOT gate this feature on it.
BLOCKERS: none
RECOMMENDED_NEXT: tech-writer — Gate 4 SHIP IT issued; document the 3 bulk endpoints (POST /tasks/bulk-create, PATCH /tasks/bulk-update, DELETE /tasks/bulk-delete), the partial-success {succeeded,failed} response shape, the closed failed.reason enum (NOT_FOUND|VALIDATION|INTERNAL) and its non-enumeration rationale, plus ADR-042 + ADR-043 in CHANGELOG/API docs. Separately, orchestrator should route devops/tech-lead to add a repo .eslintrc (P3 infra, unrelated to this feature).
HANDOFF_NOTES: tech-writer — NO code changes pending; nothing to wait on. Two deferred items to MENTION (not block on) in docs/changelog: (1) bulk-create audit lines key on the array index, with the created UUID available in succeeded[].id (ADR-042); (2) failed.reason is intentionally COARSE (one NOT_FOUND token for missing AND unauthorized) — document this as a deliberate security property (non-enumeration, per ADR-042/ADR-013), NOT as a limitation to "fix". Do NOT document any FORBIDDEN/duplicate/exists reason token — those do not exist by design. The 50-item hard cap and the N-unit rate-limit weighting (a 50-item batch costs 50 of the 100/min budget, ADR-043/ADR-014) are user-facing behaviors worth a note.
<!-- /receipt: quality-lead -->

<!-- agent: tech-writer -->
## Tech-Writer Output — Bulk Task Operations — 2026-06-11

Documented the BULK-2026-06-11 feature after Gate-4 SHIP IT. Docs only — no source/test changes.
Endpoint signatures cross-checked against `src/tasks/tasks.routes.ts`, `src/tasks/tasks.schemas.ts`,
and `src/tasks/tasks.service.ts` (paths, methods, body keys `items` vs `ids`, the closed
`NOT_FOUND|VALIDATION|INTERNAL` reason enum, the `{succeeded,failed}` shape, and the bulk-create
array-index failure id were all confirmed against the implementation, not the brief).

### Documents Updated
| Document | Changes made | Examples verified |
|---|---|---|
| `docs/api.md` | New `## Bulk Task Operations` section (between URL Shortener and Abuse Prevention) with 3 endpoint subsections, partial-success contract, closed `failed.reason` enum + ADR-042 security rationale (NOT_FOUND collapses missing/unauthorized = anti-enumeration), N-weighted rate limiting (ADR-043), per-item authz notes, duplicate-id note. Added 4 TOC entries; added 2 rows/notes to the Rate limits table. | All 3 curl bodies + response JSON snippets parsed with `node`/`JSON.parse` — valid. Code fences balanced (120, even). |
| `CHANGELOG.md` | New `## [1.5.0] — 2026-06-11` entry (Added / Security / Notes), referencing ADR-042 + ADR-043; explicit "no new dependencies, no schema/migration change" note. Added `[1.5.0]` (and backfilled missing `[1.4.0]`) link refs. | Prose only (matches house style; no fenced code in entry). |
| `README.md` | Added bulk bullet to Task Management features; added 3 endpoint rows to the API reference table (N-weighted); added a bulk-create curl example; updated the global-rate-limit note to mention N-weighting. | curl example body is valid JSON. |

### Version chosen
**[1.5.0]** — additive feature (3 new endpoints, no breaking change) → MINOR bump over [1.4.0]. Correct next bump per SemVer.

### New .env.example Variables
None. Bulk operations introduce no new configuration, dependencies, schema, or migration (reuses existing task model + `@fastify/rate-limit` store via the ADR-043 adapter).

### Verdict: DONE
<!-- /agent: tech-writer -->

<!-- receipt: tech-writer -->
AGENT: tech-writer
STATUS: DONE
TIER: 3
COMPLETED: Bulk Task Operations (BULK-2026-06-11) documentation
KEY_DECISIONS:
  - Version bumped to [1.5.0] (additive: 3 new endpoints, no breaking change → MINOR over [1.4.0]).
  - failed.reason documented as a deliberate SECURITY property (NOT_FOUND collapses missing+unauthorized, anti-enumeration per ADR-042), not a limitation; no FORBIDDEN/DUPLICATE token invented.
  - N-weighted rate limit (50-item batch = 50 of 100/min, ADR-043) + 50-item hard cap documented as user-facing behavior; "no new deps/schema/migration" noted.
BLOCKERS: none
RECOMMENDED_NEXT: none (Gate 4 SHIP IT documented; docs complete). Note for orchestrator: a separate P3 infra item (repo .eslintrc, devops/tech-lead) remains, unrelated to this feature.
HANDOFF_NOTES: Files modified (docs only, no code/tests): docs/api.md, CHANGELOG.md, README.md. All curl/JSON examples validated; signatures cross-checked against tasks.routes.ts / tasks.schemas.ts / tasks.service.ts.
<!-- /receipt: tech-writer -->

<!-- receipt: orchestrator -->
AGENT: orchestrator
STATUS: DONE
TIER: 1
COMPLETED: BULK-2026-06-11 Bulk Task Operations — RESUMED from interrupted run; ruled H5, drove H5 impl + H6 fix + security re-review + qa ‖ code-quality + quality-lead gate + tech-writer. SHIP IT.
KEY_DECISIONS:
- H5 RULING (ADR-043): adopted Option 3 (encapsulated incrByN adapter over existing @fastify/rate-limit@9.1.0, no new dep) — the only path satisfying BOTH frozen requirements ("no new dependency" + "batch counts as N"). Verified the no-weight-primitive claim against installed plugin source. Fenced behind one module + a version-pin test (fail-loud on upgrade); security-engineer re-review required and BLESSED.
- ROUTED the P1 bug backend-dev surfaced during H5 (bulkUpdateItemSchema z.intersection 422-ing every PATCH bulk-update payload) straight to a scoped backend-dev fix (H6) BEFORE review phase — fixed via updateTaskObject.extend({id}).refine() without reopening H2 mass-assignment (security re-confirmed).
- Quality gate sequence honored end-to-end: security re-review → qa ‖ code-quality (parallel) → quality-lead SHIP IT → tech-writer. No gate skipped.
BLOCKERS: none. SHIP IT issued by quality-lead; all 4 gates GREEN independently verified (orchestrator re-ran: tsc exit 0, 543/543 tests).
RECOMMENDED_NEXT: none for this feature. SEPARATE backlog item: P3 infra — repo has no eslint config (pre-existing, not this feature) → route to devops/tech-lead in a future maintenance task.
HANDOFF_NOTES: Working tree NOT committed (per instruction). Final state: 543 tests (483 original baseline + 60 new across H5/H6/qa), tsc 0, new-code coverage ~100% line. ADR-042 + ADR-043 in decisions.md (43 ADRs total). .quality-baseline.json bumped 1.1.0→1.2.0. Docs: docs/api.md + CHANGELOG [1.5.0] + README.
<!-- /receipt: orchestrator -->

---
---

<!-- agent: orchestrator -->
<!-- domain: architecture -->
