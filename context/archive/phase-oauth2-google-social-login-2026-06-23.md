## Orchestrator Output — OAuth2 Google Social Login — 2026-06-11 (OA-2026-06-11)

SECURITY_REVIEW: REQUIRED
SECURITY_REASON: Most trigger-dense task in the repo. Trigger keywords present: oauth, login, token, credential, session, cookie, redirect, external api, env/secret, jwt, account merge, database write (new users.google_id/google_email columns + migration 005). Headline risk = ACCOUNT TAKEOVER via the email-merge/link path (an attacker controlling a Google account asserting a victim's email must NOT take over the victim's password account). security-engineer is LOAD-BEARING and runs FIRST; backend-dev is GATED on SECURITY_STATUS=DONE.
SECURITY_STATUS: DONE (OA-1 threat model complete; G1–G24 Gate-1 checklist + STRIDE authored; ADR-036/037/039/040; 0 Critical/0 unmitigated High open — all findings are forward requirements; re-verify at Gate-1 close-out OA-6)

### Goal
Add OAuth2 social login with Google to the existing auth module: GET /auth/google (PKCE authorization-code redirect to Google) and GET /auth/google/callback (handle Google's callback, exchange code server-side, fetch userinfo, then create-or-link the user and issue the SAME JWT access + refresh-cookie pair as /auth/login). First login auto-creates a USER account from the Google email; subsequent logins return the existing session; a Google account whose verified email matches an existing account LINKS (merges, never duplicates). Store google_id + google_email on users. Scopes openid/email/profile (read-only). PKCE (not implicit) + state CSRF protection on the callback. Reuse existing auth-service token issuance, jwt.ts, users.repository, and the existing httpOnly refresh-cookie pattern. NO passport.js — direct authorization-code+PKCE against Google endpoints using Node 22 global fetch. NO new npm dependency. All 433 existing tests must stay green; mock Google's endpoints in tests (no live calls).

### Scope
IN: src/auth/ OAuth additions (a new google-oauth service/client + 2 routes), new users.google_id + google_email columns (migration 005), config additions (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI) + .env.example, the create-or-link account policy, PKCE+state transient storage (verifier+state binding across the redirect round-trip), full test coverage with mocked Google token+userinfo endpoints.
OUT: other social providers (only Google); a frontend/consent UI; refresh-token model changes (reuse ADR-005/012 verbatim); the existing /auth/login|register|refresh|logout behavior (unchanged); any write scopes / Google API calls beyond token-exchange + userinfo.

### Constraints
- EXTEND the auth module (ADR-011 vertical slice); do NOT create a new top-level boundary unless architect rules the OAuth client deserves its own seam in shared/. Reuse: AuthService.issueNewSession(user) + persistRefreshToken (token pair), signAccessToken(userId, role) (jwt.ts — already signs role; OAuth users default role USER), UsersRepository (extend with findByGoogleId / create-from-oauth / link), sendSession/refreshCookieOptions/REFRESH_COOKIE_* (auth.routes.ts + csrf.ts cookie pattern), config.ts Zod env (add 3 vars), errors.ts typed errors, audit.ts (add OAUTH actions).
- NO passport. Direct OAuth2 authorization-code + PKCE against Google's well-known endpoints (authorization, token, userinfo). Node 22 global fetch — NO new dependency. Egress is to FIXED Google URLs from env/constants (NOT user-controlled), so this is NOT a user-input SSRF surface — but server-side fetch hardening (timeout/fail-closed/no-redirect-follow to attacker hosts/response-size cap) is still security-engineer's call.
- google_id/google_email columns must not break the existing 433 tests (nullable, additive — same "additive SQL / breaking TS contract" budget the db-engineer already navigated for the role column: regenerate prisma client, fix PublicUser/fake-prisma/fixtures).
- All token storage = the existing httpOnly Secure SameSite=Strict cookie at REFRESH_COOKIE_PATH; access token in the body (same AuthResponse shape).

### Agent Execution Plan
Phase OA-1 (parallel): security-engineer || architect
  - security-engineer (LOAD-BEARING, first): threat-model the OAuth2 flow. RULE ON: the account-link/merge policy (the takeover risk) — REQUIRE Google email_verified===true before any link; decide link-vs-separate when email matches an existing password account (recommended: link only on verified email + bind google_id; never let an unverified Google email merge); PKCE S256 (reject plain); state generation+single-use+binding to the verifier across the round-trip (how/where stored — signed stateless cookie vs server store); token-binding (nonce/at_hash if using id_token; or userinfo over the access token); server-side fetch hardening to Google (fixed URLs, TLS, timeout fail-closed, do-not-follow-redirects, bound response); no open-redirect via a redirect/returnTo param; secrets only via config; audit events. Produce the Gate-1 checklist (G1..Gn) + STRIDE per the 2 new endpoints. Author ADRs (next free numbers; decisions.md currently ends ~ADR-035 — verify and continue).
  - architect: rule on the ONE new-boundary question — does the Google OAuth client get its own seam (e.g. src/shared/oauth/ or src/auth/google/) under ADR-010 downward-only, and where does the transient PKCE-verifier+state state live (stateless signed cookie preferred — no new store, consistent with ADR-018 single-Postgres + no-Redis). Confirm this is an additive vertical-slice extension (no new dep, no new datastore) and author/append the boundary ADR. If architect finds a genuinely NEW dependency is unavoidable → ESCALATE to tech-lead before Phase OA-3 (tech-lead is otherwise SKIPPED: no stack/dep/build decision — direct fetch on the frozen Node22/Fastify/Prisma/Zod/jsonwebtoken stack).
Phase OA-2: data-lead → entity delta: add google_id (nullable, UNIQUE) + google_email (nullable) to User; index/uniqueness strategy (UNIQUE(google_id) so one Google identity maps to one account; partial unique-when-present); confirm no second store. Append data ADR.
Phase OA-3: db-engineer → migration 005 (additive nullable columns + UNIQUE(google_id) partial index). Hand-written 00N_name/{migration.sql,down.sql} style (see 002/003/004). prisma generate + tsc + fix the PublicUser/fake-prisma/fixture type-contract blast radius; verify 433 tests still green on the schema change.
Phase OA-4: backend-dev (GATED: do NOT start until SECURITY_STATUS=DONE) → implement the PKCE client (code_verifier/code_challenge S256, state), the 2 routes, the create-or-link service honoring email_verified, config + .env.example, audit events. Satisfy every G-item. Reuse issueNewSession for the token pair. Escalation valve: if a new dep is truly unavoidable → stop + escalate to tech-lead.
Phase OA-5 (parallel): qa-engineer || code-quality → qa mocks Google token+userinfo endpoints (no live calls): happy first-login-create, subsequent-login, verified-email link/merge, UNVERIFIED-email NO-merge (takeover defense), state mismatch/replay → reject, PKCE missing/plain → reject, error responses from Google, all 433 prior tests green + new coverage >= project baseline (line >=90 new / branch >=85 new). code-quality: complexity/dup/slop on the new client+service+routes.
Phase OA-6: quality-lead → Gate 1–4; independent re-run of vitest+tsc; verify email_verified gate + state single-use + PKCE S256 in CODE; SHIP IT / FIX IT.
Phase OA-7: tech-writer (after SHIP IT) → docs/api.md (2 endpoints, the OAuth flow, the link/merge semantics + email_verified rule, env vars), CHANGELOG (next minor — WebSocket took 1.2.0, abuse-prevention took 1.3.0 → this is 1.4.0; verify), package.json version in lockstep.

SKIPPED: tech-lead (no new dep/stack/build decision; narrow escalation valve only), ai-lead/ml-engineer/prompt-engineer (no AI/ML surface), frontend-lead/frontend-dev/mobile-dev (no UI), data-engineer (no ETL), devops (no CI/infra change beyond env vars, which backend-dev adds to .env.example), maintainability (no dep-health change). RETAINED architect (NEW external-provider integration boundary + transient-state-storage decision — not a verbatim slice copy, per the "do NOT collapse architect when a feature adds a new boundary" pattern) and data-lead+db-engineer (schema change, migration 005).

### Open Questions (deferred to specialists)
- Link policy when a verified Google email matches an existing PASSWORD account: link-and-bind-google_id (recommended) vs require an explicit logged-in link step? (security-engineer rules — default to link-only-on-email_verified.)
- Transient PKCE-verifier + state storage: stateless signed/HttpOnly short-TTL cookie (preferred, no new store) vs a short-lived DB row? (architect + security-engineer.)
- id_token validation depth: full JWKS signature verify of Google's id_token vs trust userinfo over the freshly-exchanged access token? (security-engineer.)
- Whether google_email may differ from the primary email over time and which is authoritative for future logins (data-lead + security-engineer).

### Hierarchy Execution Log
| Phase | Agent(s) | Tier | Status | Task |
|---|---|---|---|---|
| OA-1 | security-engineer | 3 | DONE | OAuth2 threat model, link/merge policy, PKCE+state ruling, Gate-1 checklist, ADRs |
| OA-1 | architect | 3 | DONE | OAuth client boundary + transient-state storage decision, ADR |
| OA-2 | data-lead | 4 | DONE | google_id/google_email entity delta + uniqueness/index strategy, ADR-041 |
| OA-3 | db-engineer | 3 | DONE | migration 005 (additive columns + UNIQUE(google_id)), type-contract fix, 433 green (Docker unavailable → live smoke deferred to OA-4) |
| OA-4 | backend-dev | 3 | DONE | PKCE client + 2 routes + create-or-link service + config/.env.example (450/450, tsc 0, no new dep) |
| OA-5 | qa-engineer | 3 | DONE | mocked-Google tests (create/link/unverified-no-merge/state/PKCE), 483/483, cov 99.28/96.88, 0 bugs |
| OA-5 | code-quality | 3 | DONE | complexity/dup/slop review — CLEAN, max CC 7, 0 P1/0 P2/3 P3 |
| OA-6 | quality-lead | 4 | DONE | Gate 1–4 independent verification — SHIP IT (483/483, tsc 0, cov 99.28/96.88, G4 hand-traced) |
| OA-7 | tech-writer | 3 | DONE | docs/api.md "OAuth2 Google Login" + CHANGELOG [1.4.0] + package.json 1.3.0→1.4.0; tsc 0 + both curl examples live-verified; .env.example already had GOOGLE_* (no change) |
<!-- /agent: orchestrator -->

<!-- agent: security-engineer -->
## Security-Engineer Output (OAuth2 Google Login) — Phase OA-1 — 2026-06-11

> PRE-IMPLEMENTATION threat model (Phase OA-1, task OA-2026-06-11). The OAuth code does NOT exist yet —
> this section IS the security contract OA-4 (backend-dev) MUST implement and OA-5 (qa-engineer) MUST test,
> one test per G-item. **Verdict: DONE — 0 Critical / 0 unmitigated High findings (nothing ships yet); all
> findings are forward REQUIREMENTS (G1–G24).** EXTENDS the auth module; REUSES `issueNewSession`/
> `persistRefreshToken` (the token pair — do NOT fork the token path), pinned-HS256 `signAccessToken`/
> `verifyAccessToken` (ADR-005-amend), refresh-rotation+reuse-detection (ADR-012), CSRF Origin guard +
> HttpOnly/Secure/SameSite cookie (ADR-015/csrf.ts). All existing controls stay INTACT.
> **ADRs authored: ADR-036 (link/merge), ADR-037 (PKCE+state), ADR-039 (identity-source depth),
> ADR-040 (egress hardening + open-redirect).** Numbering: architect (parallel) took **ADR-038** (boundary)
> and reserved 036/037 for me; ADR-038 was already written when I wrote, so my last two continue at 039/040.

### Memory Recall (Before-You-Start protocol — ran, results)
| Query | Result |
|---|---|
| `security findings OWASP auth JWT refresh rotation CSRF SECURITY_PATTERN/DECISION` | HIT — recovered ADR-005-amend (jsonwebtoken direct, `algorithms:['HS256']` pinned, alg:none rejected), ADR-012 (refresh rotation + reuse-detection → revoke family), ADR-013 (404-not-403 IDOR), ADR-015 (CSRF Origin/Referer allowlist + SameSite=Strict refresh cookie), ADR-033 (role server-set from `users.role`, never request body). |
| `abuse prevention role threat model ADR-030/033` | HIT — `signAccessToken(userId, role)` already signs role from `PublicUser.role`; `normalizeRole` defaults missing→USER. OAuth users default USER. |

### REVIEW_SCOPE (Step 0 — differential risk classification of the planned OAuth surface)
| Planned file / change | Risk | Why |
|---|---|---|
| `src/auth/google-oauth.client.ts` (new) — server-side fetch to Google | **HIGH** | egress to a 3rd party + handles `client_secret`, `id_token`/`userinfo`, the access token |
| create-or-link service (new methods on AuthService / GoogleAuthService) | **HIGH** | the ACCOUNT-TAKEOVER decision point (email_verified gate, google_id join) |
| `GET /auth/google` + `GET /auth/google/callback` (auth.routes.ts) | **HIGH** | CSRF on callback, state/PKCE handling, open-redirect, the session-issuing endpoints |
| transient PKCE+state cookie (`oauth_tx`) | **HIGH** | binding + single-use + confidentiality of the verifier; CSRF defense lives here |
| `config.ts` + `.env.example` — GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI | **HIGH** | secret handling; no hardcoding; no logging |
| `users.repository` — findByGoogleId / create-from-oauth / link | MEDIUM | the conditional first-time-only link write (race) + UNIQUE(google_id) backstop |
| `audit.ts` — OAUTH_* actions | LOW | logging only (must carry NO secret/PII beyond actorId) |
| migration 005 / google_id,google_email columns | MEDIUM | data-lead/db own; security note: UNIQUE(google_id) is the takeover backstop |

### Findings (all forward REQUIREMENTS — no shippable code yet)
| ID | Severity | CWE | Title | Exploit path (if unmitigated) | Fix → Gate item |
|----|----------|-----|-------|-------------------------------|------|
| OA-F1 | **Critical** | CWE-287/290 | OAuth account-takeover via email merge | Attacker sets a Google account's email to victim's email; "Sign in with Google" auto-links into victim's password account | REQUIRE `email_verified===true` before ANY auto-link; join by `google_id` (ADR-036) → **G1–G7** |
| OA-F2 | **High** | CWE-347 | Forged/unverified `id_token` accepted | Attacker crafts an `id_token` with victim claims; if accepted unverified → impersonation | Trust identity ONLY from the server-side back-channel exchange; if `id_token` used, fully verify sig/iss/aud/exp (ADR-039) → **G12–G14** |
| OA-F3 | **High** | CWE-352 | Callback CSRF / code-injection (no/weak state) | Attacker replays/injects an auth code or forges the callback without a bound `state` | `state` single-use + cryptographically bound to `code_verifier` in a signed HttpOnly cookie, constant-time compare (ADR-037) → **G8–G11** |
| OA-F4 | **High** | CWE-310 | PKCE downgrade / code interception | A `plain` PKCE path or no PKCE lets an intercepted code be exchanged | S256 mandatory, no `plain` branch; 32-byte verifier (ADR-037 §1) → **G8** |
| OA-F5 | **High** | CWE-601 | Open redirect on callback | Attacker-controlled `returnTo`/`next` reflected into a 302 → phishing/token-leak | Callback issues session in-place; no attacker-controlled redirect; allowlist if ever added (ADR-040 §5) → **G20** |
| OA-F6 | **High** | CWE-798/532 | `client_secret` hardcoded or logged | Secret in code/logs → full client impersonation | Secret from `config.ts` only; never logged/audited/returned; redaction (ADR-040 §3) → **G18–G19** |
| OA-F7 | **Medium** | CWE-918-adj/CWE-400 | Unhardened server-side egress to Google | 3xx-follow to attacker host, hung/oversized response, no timeout | HTTPS-only, `redirect:'manual'`, `AbortSignal.timeout`, body cap, Zod-validate (ADR-040 §2) → **G15–G17** |
| OA-F8 | **Medium** | CWE-362 | Link-write race / double-bind | Two concurrent first-logins both bind `google_id`, or a second identity re-points a linked row | Conditional `UPDATE ... WHERE google_id IS NULL` + UNIQUE(google_id) backstop (ADR-036 §5) → **G5–G6** |
| OA-F9 | **Low** | CWE-613 | Transient-state cookie too broad/long-lived | A wide-path or long-TTL `oauth_tx` cookie widens the replay/leak window | HttpOnly+Secure+SameSite=Lax+Path=/auth/google+MaxAge≤600+cleared-on-callback (ADR-037 §4) → **G9–G10** |

### Gate-1 Checklist — OA-4 (backend-dev) MUST satisfy; OA-5 (qa-engineer) MUST test (one test per G)
**Account link/merge (ADR-036) — the takeover defense:**
- **G1** `google_id` (Google `sub`) match → log into that existing OAuth user; resolve by `google_id`, never by email, for an already-linked account.
- **G2** No `google_id` match + `email_verified===true` + verified `google_email` == an existing account's primary email (case-folded) → LINK (bind `google_id`) then log in.
- **G3** No `google_id` match + no email match → CREATE a new USER (role USER); OAuth-created user has NO password hash.
- **G4** `email_verified` false/absent → **REJECT** (generic `AuthError` 401, audit `OAUTH_LINK_DENIED`). NEVER link, NEVER create-separate. (qa: the explicit takeover test — unverified Google email matching a victim's email must NOT log in.)
- **G5** LINK is a conditional write `UPDATE users SET google_id=$id WHERE id=$row AND google_id IS NULL` (first-time-only; concurrent first-logins cannot both bind).
- **G6** A second Google identity claiming an already-linked account hits UNIQUE(google_id) → `ConflictError`/`AuthError`, never overwrite.
- **G7** An OAuth-created (passwordless) user cannot password-login: `bcrypt.compare` vs null/dummy hash fails closed (reuse the existing DUMMY_BCRYPT_HASH constant-time path in auth.service.login).

**PKCE + state (ADR-037):**
- **G8** PKCE S256 only: `code_verifier`=base64url(randomBytes(32)); `code_challenge`=base64url(SHA256(verifier)); `code_challenge_method=S256`; NO `plain` branch anywhere.
- **G9** `state`=base64url(randomBytes(32)); `state` + `code_verifier` carried in ONE signed value; cookie `oauth_tx` = HttpOnly, Secure(prod), **SameSite=Lax** (NOT Strict — callback is a cross-site top-level GET), Path=/auth/google, Max-Age≤600.
- **G10** Cookie cleared on callback (success AND failure) → single-use; replayed `state` after a completed callback → reject.
- **G11** On callback: verify cookie signature → constant-time compare cookie `state` vs query `state` → mismatch/absent/expired/forged → reject + audit `OAUTH_STATE_REJECTED`. `code_verifier` never appears in a query param / body / log.

**Identity source (ADR-039):**
- **G12** Identity (`sub`,`email`,`email_verified`,`name`) read ONLY from the server-side token-exchange response (userinfo over the fresh access token [default] OR a verified id_token). NEVER from any redirect/callback param.
- **G13** If `id_token` is used: verify RS256 sig against Google JWKS (cache by `kid`), check `iss`/`aud===GOOGLE_CLIENT_ID`/`exp`(+nonce if sent). An unverified `id_token` is forbidden.
- **G14** Token exchange pins `aud`/`client_id` (token-substitution defense).

**Server-side egress hardening (ADR-040):**
- **G15** All Google calls go through ONE `fetchGoogle()` helper: HTTPS-only (assert scheme), `AbortSignal.timeout(≤5s)`, `redirect:'manual'`, response-body size cap (≤1MB), Zod-validate the parsed JSON.
- **G16** Timeout/network/redirect/oversize → typed error, fail-closed (never a silent success or retry-storm).
- **G17** `assertSafeUrl` (the user-URL SSRF guard, ADR-019) is NOT applied to Google egress (fixed non-user URLs) — do not bolt it on.

**Secrets + config (ADR-040 §3):**
- **G18** GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI added to `config.ts` Zod schema; read ONLY via `config` (never `process.env` directly). `.env.example` gets placeholders, never real values.
- **G19** `client_secret` sent ONLY in the token-exchange POST body over TLS; never logged, never in an error/audit field, never in a response. Confirm logger redaction covers it. NO hardcoded secret anywhere (BLOCKED if violated).

**Open-redirect (ADR-040 §5):**
- **G20** Callback issues the session in-place (refresh cookie + access token, like /auth/login); no 302 to any attacker-controlled `returnTo`/`next`/`redirect`. No such param honored in v1.
- **G21** `redirect_uri` is a fixed config constant, identical on auth request and token exchange; never from a request param.

**Token path + audit (reuse, don't fork):**
- **G22** The callback issues the SAME token pair via `AuthService.issueNewSession(user)` → `persistRefreshToken` (new family) + `signAccessToken(userId, user.role)`. Do NOT fork the token path, do NOT bypass refresh rotation (ADR-012) or the pinned-HS256 sign (ADR-005-amend). OAuth users sign with role from `users.role` (USER), same as ADR-033.
- **G23** Refresh cookie set via the EXISTING `refreshCookieOptions`/`REFRESH_COOKIE_*` (HttpOnly/Secure/SameSite=Strict, Path=/auth) — unchanged; the transient `oauth_tx` cookie is a DISTINCT cookie (different path/TTL/SameSite), never entangled with the refresh cookie.
- **G24** Audit `OAUTH_START`, `OAUTH_CALLBACK`, `OAUTH_LINK`, `OAUTH_CREATE`, `OAUTH_LINK_DENIED`, `OAUTH_STATE_REJECTED` via audit.ts (add to AUDIT_ACTION); carry NO secret/PII beyond actorId.

### STRIDE per endpoint
**`GET /auth/google` (start — builds the PKCE authorization redirect, sets `oauth_tx`, 302s to Google):**
| Threat | Vector | Mitigation (G) |
|---|---|---|
| **S**poofing | n/a (unauthenticated entry; no identity asserted yet) | identity only established at callback from back-channel (G12) |
| **T**ampering | tamper the redirect params / inject a `code_challenge` | challenge derived server-side from our verifier; verifier bound in the signed cookie (G8/G9) |
| **R**epudiation | deny initiating a login | audit `OAUTH_START` (G24) |
| **I**nfo disclosure | leak `code_verifier` to the client/log | verifier only in HttpOnly signed cookie, never body/param/log (G9/G11) |
| **D**oS | hammer the endpoint to mint cookies | existing per-IP rate-limit pattern applies (reuse `config.rateLimit`); cookie is cheap + short-TTL |
| **E**levation | force a `plain` PKCE downgrade | no `plain` branch exists (G8) |

**`GET /auth/google/callback` (exchanges code, fetches identity, create-or-link, issues session):**
| Threat | Vector | Mitigation (G) |
|---|---|---|
| **S**poofing | attacker presents victim's email via Google / forged id_token | `email_verified` gate + `google_id` join (G1–G4); identity from back-channel only; id_token fully verified (G12–G14) |
| **T**ampering | CSRF/code-injection on the callback; mix state+verifier | single-use `state` bound to verifier, constant-time compare (G9–G11) |
| **R**epudiation | deny the link/create | audit `OAUTH_CALLBACK`/`LINK`/`CREATE`/`LINK_DENIED`/`STATE_REJECTED` (G24) |
| **I**nfo disclosure | leak `client_secret` / tokens in logs/errors/redirect | secret config-only + never logged (G18–G19); no open-redirect leaking the session (G20) |
| **D**oS | hung/oversized Google response stalls the worker | timeout fail-closed + body cap + no-redirect-follow (G15–G16); refresh rate-limit on the issued session path |
| **E**levation | link-race double-bind; re-point a linked row; self-elevate role | conditional first-time-only link + UNIQUE(google_id) (G5–G6); role server-set USER from `users.role`, never from Google claims (G22, ADR-033) |

### OWASP Top 10 coverage
| Category | Status | Notes |
|---|---|---|
| A01 Broken Access Control | OK | `google_id` join; passwordless users can't password-login (G7); role never from Google claims (G22) |
| A02 Cryptographic Failures | OK | PKCE S256, signed transient cookie, HS256 token reuse, secret ≥ config bytes; id_token verified if used (G13) |
| A03 Injection | OK | Zod-parse callback query + Google responses (G15); Prisma parameterized (repo layer) |
| A04 Insecure Design | OK | email_verified gate is the designed-in takeover defense (ADR-036); threat model is this section |
| A05 Security Misconfiguration | OK | secrets via Zod config; `.env.example` placeholders (G18); HTTPS-only egress (G15) |
| A06 Vulnerable Components | OK | NO new dependency (Node 22 global fetch + crypto + jsonwebtoken already pinned) — see npm audit below |
| A07 Auth Failures | OK | reuse rotation+reuse-detection (ADR-012); state single-use; rate-limit on the OAuth routes (reuse pattern) |
| A08 Software Integrity | OK | id_token signature verified (G13); no eval/deserialization of untrusted data |
| A09 Logging Failures | OK | OAUTH_* audit events (G24); no secret/PII in logs (G19/G24) |
| A10 SSRF | OK (N/A by construction) | egress is fixed non-user URLs (G17); explicitly NOT routed through assertSafeUrl |

### Dependencies
**NO new npm dependency** introduced or required by this design (constraint honored): the OAuth client uses Node 22 global `fetch`, `node:crypto` (randomBytes/createHash), and the already-pinned `jsonwebtoken` (for the signed transient cookie + optional id_token verify). If the JWKS/id_token-verify path is later chosen AND a maintained JOSE lib is deemed necessary → OA-4 ESCALATES to tech-lead (do not add silently). `npm audit` to be (re-)run by qa/quality-lead at Gate-1 close-out against the unchanged dependency set; no CVE delta expected since package.json is unchanged.

### Security ADRs authored
- **ADR-036** OAuth2 Google Account Link/Merge Policy (email_verified gate, google_id join, reject-unverified).
- **ADR-037** OAuth2 PKCE S256 + state single-use bound to verifier via signed HttpOnly SameSite=Lax short-TTL cookie.
- **ADR-039** OAuth2 Identity-Source Depth (back-channel only; userinfo-over-fresh-token default / fully-verified id_token).
- **ADR-040** OAuth2 Egress Hardening + No Open-Redirect (fixed URLs, timeout/no-redirect/bounded, secret config-only).
- (ADR-038 = architect's boundary ADR; complements ADR-037's crypto/single-use ruling on the same cookie.)

### Coordination note to architect (parallel OA-1)
Architect ADR-038 places the transient state in a stateless signed cookie — I CONCUR and harden it (ADR-037 §4). **Security requirement on that placement:** SameSite must be **Lax not Strict** (the callback is a cross-site top-level GET — Strict would break it), Path scoped to `/auth/google`, signed + HttpOnly + Max-Age≤600 + cleared-on-callback, and state↔verifier bound in one signed unit. If architect/backend instead pick a DB row, the binding + single-use + short-TTL + lookup-by-unguessable-state invariants are non-negotiable.

### Verdict
**DONE** — 0 Critical / 0 unmitigated High open (all findings are forward G-requirements). SECURITY_STATUS → DONE; the OA-4 (backend-dev) gate is satisfiable. Re-verify at Gate-1 close-out (OA-6 quality-lead) that every G1–G24 is implemented + tested in CODE — especially G4 (the unverified-email takeover test) and G22 (token path not forked).
<!-- /agent: security-engineer -->

<!-- agent: architect -->
## Architect Output (OAuth2 Google Login) — Phase OA-1 — 2026-06-11

VERDICT: DONE. Full decision in decisions.md → **ADR-038** (I reserved ADR-036/037 for security-engineer's parallel ADRs to avoid collision — same convention as ADR-025's numbering note).

### The two new-boundary rulings

**1. Google OAuth2 client placement → service-layer collaborator INSIDE the `auth` module: `src/auth/google-oauth.client.ts`.**
- NOT `src/shared/oauth/` (provider-agnostic seam) — only Google is in scope; a multi-provider abstraction with one implementation is a YAGNI/complexity-budget violation. `shared/` is for cross-cutting utils used by MULTIPLE modules (jwt/csrf/errors/prisma); a single-module, single-provider client does not qualify. (Contrast ADR-025's `TaskEventPublisher` which IS in shared/ — it's consumed by two modules and needs dependency-inversion; this client has neither property.)
- NOT a new top-level module — OAuth login IS authentication; it extends the auth vertical slice (ADR-011), per the orchestrator's EXTEND constraint.
- The server-side `fetch` to Google (code→token exchange + userinfo) is owned by the SERVICE TIER, never the route layer (ADR-010 rule #2 forbids I/O + business logic in routes). Downward-only chain: `auth.routes → auth service tier (AuthService/GoogleAuthService) → GoogleOAuthClient → (fetch) Google`. The client is transport-ONLY (URL build + 2 fetches + parse); it holds NO create-or-link policy, NO token issuance, NO Prisma, NO Fastify type. The create-or-link use-case (email_verified gate + users.repository + AuthService session issuance) is auth business logic in the service tier.
- Wired at the `app.ts registerModules` composition root from `config` (same DI shape as every repo/service and the ADR-025 hub); routes mount on the existing `authRoutes` plugin.

**2. Transient PKCE `code_verifier` + CSRF `state` → stateless, signed, HttpOnly, short-TTL COOKIE.** Set on `GET /auth/google`, read+cleared on `GET /auth/google/callback`. NO new datastore — consistent with ADR-018 (single Postgres, Redis/second-store deferred) and the existing `csrf.ts` cookie discipline. Rejected a short-lived DB `OAuthState` row: it adds a table + migration + orphan-row cleanup cron for ephemeral data self-addressed to one browser — cost without durability benefit (kept ONLY as the named fallback if security mandates server-side single-use). Route layer owns set/read/clear (only layer that may touch Fastify cookie APIs).

**3. CONFIRMED additive — NO new module, NO new npm dependency, NO new datastore.** Node 22 global `fetch` covers all Google egress; PKCE (random verifier + S256 SHA-256 challenge) + signed-cookie integrity use built-in Node `crypto` + existing cookie tooling. No passport, no OAuth lib. users.repository extended (findByGoogleId/create-from-oauth/link) through the ADR-011 single-table-ownership rule. **NO escalation to tech-lead from the architecture side.** The ONLY path that could force a new dep is OUTSIDE my lane: if security-engineer mandates id_token JWKS/RS256 verification AND rules hand-rolling it with Node `crypto` unacceptable → that's a security/tech-lead escalation, not this ADR.

### Seam contract for security-engineer (parallel) + backend-dev (Phase OA-4)
- **I own PLACEMENT**: a DEDICATED transient cookie (distinct name/path from `refresh_token`, short TTL, set on `/auth/google`, read+CLEARED on callback before the session cookie is set), owned by the route layer, no server store.
- **security-engineer owns CRYPTO/PROPERTIES carried in it**: CSPRNG state + single-use; state↔verifier↔browser binding; signing/encryption + integrity scheme; the TTL value; and CRITICALLY the cookie's SameSite/attributes for the cross-site top-level return FROM Google (the existing refresh cookie is SameSite=Strict, which likely DROPS on the Google→callback navigation — the OAuth transient cookie's attributes are explicitly THEIR call, NOT mine).
- If security concludes stateless cannot meet a server-side single-use requirement → fallback is the short-lived DB row (one additive table + repo method, no module-boundary change, becomes a data-lead/db-engineer item — NOT a re-architecture).
<!-- /agent: architect -->

<!-- agent: data-lead -->
## Data-Lead Output (OAuth2 Google Login) — Phase OA-2 — 2026-06-11

> Entity delta ONLY: two nullable columns on the existing `User` aggregate (users module owns the User
> table, ADR-011). NO new entity, NO new datastore, NO migration SQL here (that is db-engineer OA-3).
> **ADR authored: ADR-041** (verified next free — security took 036/037/039/040, architect took 038).
> **Verdict: DONE.** Memory-recall ran (ADR-016 UUID PK / ADR-017 3NF+enums / ADR-018 single-Postgres /
> ADR-011 User ownership / migration-004 role-column "additive SQL / breaking TS" pattern all recovered).

### Entity Model
No new entities, no new relationships. The Google identity is a 1:1 *attribute set on the existing User*
(an OAuth identity belongs to exactly one account; an account has at most one Google identity). Modeling it
as inline nullable columns on `users` — NOT a separate `oauth_account` table — is correct because:
- Scope is **one provider** (Google only, orchestrator OUT-scope). A separate `oauth_accounts(provider, provider_id, …)` table is the right shape ONLY when a 2nd provider arrives; building it now is a speculative abstraction (same anti-pattern architect rejected for the `shared/oauth/` seam, ADR-038). Revisit trigger: 2nd provider.
- The join key (`google_id`) and the link decision (`email_verified` + primary-email match, ADR-036) both operate on the User row itself — no separate aggregate earns its keep.

```
User (users)  ── exactly the same aggregate, +2 nullable columns ──
  id            UUID PK            (unchanged, ADR-016)
  email         VarChar(320) UNIQUE (unchanged — the PRIMARY email; the link target, ADR-036 §2/§6)
  passwordHash  VarChar(72)        (unchanged; NULL-semantics NOT introduced here — OAuth-created users
                                    having no password is a backend OA-4 concern, not a schema change:
                                    passwordHash stays NOT NULL and is set to a non-matching dummy by
                                    backend per ADR-036 §3 / G7. data-lead does NOT relax this column.)
  role          UserRole           (unchanged, ADR-030)
  + google_id    VarChar(255)  NULLABLE  UNIQUE   ← Google `sub`, immutable join key (ADR-036 §1)
  + google_email VarChar(320)  NULLABLE  (no index) ← audit/display only (ADR-036 §6)
  created_at / updated_at          (unchanged)
```

### Schema Specification (the entity delta)
| Column | Prisma type | Nullability | Constraint | Rationale |
|---|---|---|---|---|
| `google_id` | `String? @unique @map("google_id") @db.VarChar(255)` | NULLABLE | **plain `@unique`** | Google `sub` claim — Google's stable, immutable subject id. Numeric-string today (~21 digits max) but treat as **opaque** (Google documents it as a string ≤255 chars; never parse it as a number). VarChar(255) = documented max with headroom. The UNIQUE is security's takeover backstop (ADR-036 §5, OA-F8/G6): one Google identity → exactly one account; a 2nd identity claiming a linked row fails the constraint → ConflictError, never overwrite. |
| `google_email` | `String? @map("google_email") @db.VarChar(320)` | NULLABLE | **none** (no unique, no index) | The email Google returned at link/create time, stored for **audit/display only** (ADR-036 §6). VarChar(320) mirrors the existing `email` column exactly (RFC 5321 254 + headroom). |

**Why plain `@unique`, NOT a partial unique index `WHERE google_id IS NOT NULL` (verified Postgres semantics):**
A Postgres `UNIQUE` constraint treats NULL values as **distinct from each other** — multiple rows with
`google_id IS NULL` are permitted under a single plain UNIQUE constraint. So nullable + plain `@unique`
gives exactly the property we want: every *non-null* `google_id` is unique, and the (large) population of
password-only users (all NULL) coexist freely. A partial unique index `WHERE google_id IS NOT NULL` would
be *functionally identical for the uniqueness guarantee* and marginally smaller (NULL rows excluded from the
index b-tree), but it cannot be expressed in the Prisma schema (`@unique`) and would force a raw-SQL-only
index — extra drift surface for a micro-optimization that does not matter at this row count. **Decision:
plain `@unique`.** This is NOT a novel risk — the SAME nullable+`@unique`+multi-NULL pattern is already live
and verified in THIS schema: `FlaggedUrl.proposedCode String? @unique` (migration 004; db-engineer's own
live-verify recorded "proposed_code multi-NULL OK" on real postgres:16). We are reusing a proven pattern,
not inventing one. db-engineer's migration-005 EXPLAIN/constraint check should re-confirm multi-NULL insert
+ duplicate-non-null rejection, exactly as 004 did for proposed_code.

**Why `google_email` is NOT unique and needs NO index:**
- NOT unique: a Google email could legitimately collide with a *different* account's primary `email` (that
  collision is precisely what the ADR-036 link ladder *resolves* via `email_verified`; it is not a uniqueness
  violation). Uniqueness lives on `google_id` (identity) and the existing `email` UNIQUE (primary email) —
  NOT on `google_email`.
- No index: there is **no lookup query keyed by `google_email`.** The two access paths are (1) login →
  `WHERE google_id = $sub` (the @unique index), and (2) link → `WHERE email = $verifiedGoogleEmail` (the
  existing `email` UNIQUE index, against the PRIMARY email column, ADR-036 §2). `google_email` is written at
  create/link and read back only for audit/display — store-only, never a WHERE predicate. Indexing a
  never-queried column is pure write amplification (anti-pattern). **Confirmed: store-only.**

### Access Patterns
| Path | Query | Columns used | Index | Note |
|---|---|---|---|---|
| OAuth login (returning user, ADR-036 §1) | `findByGoogleId`: `WHERE google_id = $sub` | `google_id` | the new `@unique` index (equality probe, hot path on every callback) | resolve by `google_id` ONLY, never email, for a linked account |
| Link to existing account (ADR-036 §2) | lookup existing by **primary** email: `WHERE email = $verifiedGoogleEmail` | `email` (existing) | existing `email` UNIQUE — **no new index** | matches on PRIMARY email, gated on `email_verified===true` |
| Link write (first-time-only, ADR-036 §5 / G5) | `UPDATE users SET google_id=$sub, google_email=$ge WHERE id=$row AND google_id IS NULL` | `id` (PK), `google_id` (guard) | PK; `@unique` is the race backstop (G6/OA-F8) | conditional write — concurrent first-logins cannot both bind |
| Create from OAuth (ADR-036 §3) | `INSERT … (email, google_id, google_email, name, role=USER, passwordHash=$dummy)` | — | — | passwordHash set to a non-matching dummy by backend (fail-closed login, G7) |

### Migration Strategy (intent for db-engineer OA-3 — they write the SQL)
**ADDITIVE + reversible. The gentlest class of change** — strictly gentler than the migration-004 role column:
- **Both columns NULLABLE** → NO `NOT NULL` + DEFAULT backfill needed (the role column needed one; these do
  not). Existing rows simply get NULL for both. `ALTER TABLE … ADD COLUMN` for a nullable column with no
  default is a **metadata-only** change in Postgres 11+ (no table rewrite, instant on a populated table).
- The `UNIQUE(google_id)` constraint over an all-NULL existing column builds trivially (no non-null values to
  conflict). On a large prod table, build the unique index `CONCURRENTLY` (same prod-note convention as
  migrations 002/003/004) — not required for this repo's scale but document it.
- Migration **005** (next number after 004), hand-written `005_oauth_google/{migration.sql,down.sql}`,
  mirroring the 003/004 rigor. **down.sql** = `DROP` the unique index/constraint then `DROP COLUMN
  google_email, google_id` (reverse order). Fully reversible; no data loss on down beyond the OAuth links
  themselves (acceptable — they are re-derivable on next Google login).
- **Rollback plan**: because the change is purely additive nullable columns, rollback is a clean column drop;
  no backfill to undo, no dependent data. Zero-downtime safe (old app code ignores unknown columns; new app
  code tolerates NULL = "not linked").

### Type-Contract Blast Radius (the migration-004 lesson, applied — flag for db-engineer)
This is the load-bearing handoff note. The role column taught us: **additive in SQL ≠ additive in
TypeScript.** Here is how google_id/google_email differ from role, and exactly what db-engineer must touch:

- **`prisma generate` makes both fields `string | null` (OPTIONAL-valued, because nullable).** Unlike the
  role column — which `prisma generate` made a **required non-null** field, breaking 6 fixture sites that had
  to add `role: UserRole.USER` — a **nullable** Prisma field is emitted as `google_id: string | null`. A
  value of `null` is a *valid, complete* value for that property; the TS type does NOT force callers to
  supply it at construction only if the object is built by Prisma. **BUT**: `User` is an interface with the
  property *present* (`google_id: string | null`), not absent — so any place that constructs a **full `User`
  object literal by hand** (not via Prisma) WILL fail tsc with "property google_id is missing", the same way
  role did. The fix is mechanical: add `google_id: null, google_email: null` to those literals.
- **Concretely, db-engineer must check/touch (mirror the 004 fix-list):**
  1. `src/users/users.repository.ts` — `PublicUser = Omit<User,'passwordHash'>` **auto-picks up both new
     fields** (they are not omitted). **DECISION: ADD `google_id: true, google_email: true` to
     `PUBLIC_USER_SELECT`?** → **google_id: YES** (it is non-secret identity, parallels how `role` was added
     to the select as a JWT-claim source; callers/principal-builders may legitimately read "is this a Google
     account"). **google_email: YES for parity/audit display, it is non-secret** (it is just an email Google
     returned; the primary `email` is already in the select). Neither is a secret like `passwordHash`. If
     `PUBLIC_USER_SELECT` does NOT list them, they will be absent from `PublicUser` at runtime while present
     in the type → drift; so they MUST be added to the select to keep `PublicUser` honest. **db-engineer:
     add both to `PUBLIC_USER_SELECT`.**
  2. `src/test/fake-prisma.ts` — the `UserRow` factory: add `google_id: null, google_email: null` defaults
     (mirror DB default = NULL; overridable to a value in OAuth-specific tests). This is the exact move made
     for `role: UserRole.USER` in 004.
  3. Any hand-built `User`/user-fixture object literals in tests (auth.service.test, tasks/urls/ws
     integration fixtures) — add `google_id: null, google_email: null` **only if** tsc flags them. Because
     the fields are nullable, fixtures that build users via the fake-prisma factory (step 2) are
     auto-satisfied once the factory has the defaults; only standalone literals need touching. **Net: fewer
     sites than the role column, because nullable = no required-value propagation.**
  4. `npx prisma generate` → `npx tsc --noEmit` must be exit 0 before claiming done; expect FEWER break
     sites than 004's 6 (nullable is gentler). Then the 433 tests must stay green.

### Privacy & Retention
- `google_email` is **PII** (an email address) — same classification as the existing `email` column; covered
  by the existing logger redaction posture and the `Omit<…,'passwordHash'>` secret boundary (neither google
  column is a secret; both are profile data). No NEW retention rule: both columns share the User row's
  lifecycle and are removed by the existing `User` delete CASCADE (deleting a user removes their Google link).
- `google_id` is an opaque external identifier (low direct-PII, but it IS a stable cross-service correlator) —
  not logged in audit events beyond what ADR-040 §5/§6 already constrains (audit carries actorId, not the sub).
- GDPR: erasure is satisfied by the existing user-delete path (no separate OAuth store to purge — a direct
  benefit of the inline-columns choice over a separate table). No data pipeline, no replication change.

### ADRs Written
- **ADR-041** (decisions.md, `<!-- domain: data -->`): google_id/google_email columns on User; plain
  nullable `@unique` on google_id (Postgres NULL-distinct semantics + the proposedCode precedent) vs partial
  index; google_email store-only/unindexed; join-by-google_id access pattern; additive-nullable migration
  intent + the type-contract blast radius for db-engineer.

### Implementation Spec for db-engineer (OA-3) — EXACT Prisma lines to add
Add these two fields to `model User` in `prisma/schema.prisma` (place them right after `role`, before
`createdAt`, to match the column-ordering convention):
```prisma
  /// Google OAuth2 subject identifier (the `sub` claim) — the IMMUTABLE, stable
  /// join key for "Sign in with Google" (ADR-036 §1, ADR-041). NULL for every
  /// password-only account. UNIQUE: one Google identity maps to exactly one
  /// account — the takeover backstop (ADR-036 §5). Plain @unique is correct: a
  /// Postgres UNIQUE treats NULLs as distinct, so the many NULL (password-only)
  /// rows coexist while every non-null sub is unique — same proven pattern as
  /// FlaggedUrl.proposedCode. Treated as an OPAQUE string (never parsed numeric);
  /// VarChar(255) is Google's documented max with headroom.
  googleId    String?  @unique @map("google_id") @db.VarChar(255)
  /// The email Google returned at link/create time — stored for AUDIT/DISPLAY
  /// ONLY (ADR-036 §6, ADR-041). NOT unique (it may legitimately equal another
  /// account's primary email — the ADR-036 email_verified ladder resolves that)
  /// and NOT indexed (no query is keyed by it; login joins on googleId, link
  /// joins on the primary `email`). VarChar(320) mirrors the `email` column.
  googleEmail String?  @map("google_email") @db.VarChar(320)
```
Migration intent: **migration 005** (`005_oauth_google/`), additive + reversible, mirror 003/004 style.
- UP: `ALTER TABLE users ADD COLUMN google_id VARCHAR(255)` (nullable, no default — metadata-only) +
  `ADD COLUMN google_email VARCHAR(320)`; then `CREATE UNIQUE INDEX users_google_id_key ON users(google_id)`
  (the index name Prisma expects for `@unique`; inline a `CONCURRENTLY` prod-note as in 003/004).
- DOWN: `DROP INDEX users_google_id_key` then `ALTER TABLE users DROP COLUMN google_email, DROP COLUMN
  google_id`.
- After schema edit: `prisma generate` → `tsc --noEmit` (fix `PUBLIC_USER_SELECT` += `googleId: true,
  googleEmail: true`; fake-prisma `UserRow` factory += `googleId: null, googleEmail: null`; touch any
  standalone user literal tsc flags) → 433 tests green. EXPLAIN re-confirm on a seeded table: multi-NULL
  insert OK, duplicate non-null googleId rejected (the G6 backstop), `WHERE google_id=$sub` uses
  `users_google_id_key` (Index Scan, no seq scan).

### Verdict: DONE
<!-- /agent: data-lead -->

<!-- agent: db-engineer -->
## DB-Engineer Output (OAuth2 Google Login) — Phase OA-3 — 2026-06-11

Implemented data-lead ADR-041 exactly: 2 nullable identity columns on `User` + the
`UNIQUE(google_id)` takeover backstop. Gentlest migration class (metadata-only ADD
COLUMN, no DEFAULT, no backfill — gentler than 004's NOT NULL `role`). Reversible.

### Schema Changes
`prisma/schema.prisma`, `model User`, inserted AFTER `role` / BEFORE `createdAt`
(column-ordering convention), verbatim from the data-lead spec:
- `googleId    String?  @unique @map("google_id") @db.VarChar(255)` — Google `sub`,
  immutable join key; plain `@unique` (NOT partial) IS the security backstop.
- `googleEmail String?  @map("google_email") @db.VarChar(320)` — store-only
  (audit/display); NOT unique, NOT indexed.

### Migrations Written
| Migration | Type | Description | Reversible |
|---|---|---|---|
| 005_google_oauth/migration.sql | additive (metadata-only ADD COLUMN ×2 + 1 UNIQUE index) | 2 nullable cols on `users` + `CREATE UNIQUE INDEX users_google_id_key` | yes |
| 005_google_oauth/down.sql | reverse | DROP INDEX users_google_id_key → DROP google_email → DROP google_id (reverse add order) | n/a |
Hand-written custom-named style, mirrors 002/003/004. Inline `CONCURRENTLY`
prod-note for the populated `users` table. `down.sql` uses `IF EXISTS` guards.
Folder named `005_google_oauth/` (data-lead receipt cosmetically wrote
`005_oauth_google/`; the hand-written folder name is non-functional — orchestrator
task spec said `005_google_oauth`).

### Drift Proof (Docker UNAVAILABLE — daemon down — see note)
`npx prisma migrate diff --from-empty --to-schema-datamodel ./prisma/schema.prisma
--script` emits, byte-matching the hand-written migration:
```
"google_id" VARCHAR(255),          ← nullable ✓
"google_email" VARCHAR(320),       ← nullable ✓
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");  ← name+target match ✓
```
Intentional delta: hand-written UP uses two `ALTER TABLE … ADD COLUMN` statements
(diff `--from-empty` emits a full CREATE TABLE); semantically identical for the
User delta. `npx prisma validate` → "schema is valid 🚀" (with DATABASE_URL set;
the bare-shell P1012 is only a missing-env-var, not a schema defect).

### Index Results
| Index | Query | Verification | Notes |
|---|---|---|---|
| users_google_id_key (UNIQUE on google_id) | OAuth login `WHERE google_id = $sub` (hot callback path) | name byte-matches Prisma's `@unique` derivation; equality probe → Index Scan by construction | the G6/OA-F8 takeover backstop |

**Multi-NULL coexist + duplicate-non-null reject**: NOT live-proven on Docker this
run (daemon down). HOWEVER this is the IDENTICAL plain-`@unique`-over-nullable
pattern already LIVE-VERIFIED on a real postgres:16 in migration 004
(`FlaggedUrl.proposed_code`): 2 NULL rows inserted OK, duplicate non-null rejected
P2002. Postgres NULL-distinct semantics guarantee it. The fake-prisma store mirrors
the same semantics (user.create never sets googleId; UNIQUE(code/domain) P2002
shapes proven in suite). backend-dev (OA-4) should still smoke-test the live insert
once a DB is up.

### Connection Pool Config
No change (additive columns; pool sizing unchanged from prior phases).

### Type-Contract Blast Radius (the migration-004 lesson, nullable = gentler)
`prisma generate` → `tsc --noEmit` surfaced exactly 6 hand-built full-`User`
literals + 1 select. All mechanical model-contract/fixture enabling fixes (NO
JWT/auth/business logic touched — that is backend-dev OA-4):
- `src/users/users.repository.ts` — `PUBLIC_USER_SELECT` += `googleId: true,
  googleEmail: true` (PublicUser = Omit<User,'passwordHash'> auto-includes them in
  the TYPE; the runtime select must too or PublicUser drifts; neither is secret).
- `src/test/fake-prisma.ts` — `UserRow` factory (user.create) += `googleId: null,
  googleEmail: null` defaults.
- 5 test fixtures += `googleId: null, googleEmail: null`:
  `src/admin/abuse.matrix.integration.test.ts`,
  `src/admin/admin.routes.integration.test.ts`,
  `src/auth/auth.service.test.ts` (the `makeUser` factory — `...overrides` lets a
  future Google test pass googleId), `src/tasks/tasks.routes.integration.test.ts`,
  `src/urls/urls.routes.integration.test.ts`,
  `src/ws/ws.routes.integration.test.ts`.

### Test Results
- `npx tsc --noEmit` → **exit 0** (clean).
- `npx vitest run` → **433 passed / 433** (29 files), exit 0. **0 regressions.**

### Verdict: DONE
<!-- /agent: db-engineer -->

<!-- agent: backend-dev -->
## Backend-Dev Output (OAuth2 Google Login) — Phase OA-4 — 2026-06-11

VERDICT: DONE. tsc exit 0; vitest 450/450 (433 prior + 17 new OAuth smoke, 0 regressions).
Implemented the full PKCE+state Google login against the security contract; every G1–G24 satisfied.
Reused (did NOT fork): `issueNewSession`/`persistRefreshToken` (token pair), `signAccessToken` (HS256+role),
the `sendSession`/`refreshCookieOptions`/`REFRESH_COOKIE_*` refresh-cookie pattern, `parseOrThrow`/Zod,
typed errors, `audit.ts`. NO new npm dependency (Node 22 `fetch` + `node:crypto` only).

### Files Created/Modified
| File | Action | Purpose |
|---|---|---|
| `src/auth/google-oauth.client.ts` | NEW | Transport-only client (ADR-038): buildAuthorizationUrl (PKCE S256), exchangeCodeForIdentity (token POST → userinfo GET), the ONE hardened `fetchGoogle()` (HTTPS-only, AbortSignal.timeout, redirect:'manual', 1 MB body cap, Zod-validate). NO policy/Prisma/Fastify/token-issuance. |
| `src/auth/oauth-tx.ts` | NEW | The transient `oauth_tx` cookie crypto (ADR-037 §4): CSPRNG state+verifier, HMAC-SHA256 seal/open over JWT_SECRET, constant-time state compare, Lax/Path=/auth/google/MaxAge=600 options. |
| `src/auth/auth.service.ts` | MOD | Added `loginWithGoogle(identity)` create-or-link use-case (G1–G7) + `GoogleLoginResult/Kind` + OAUTH_PLACEHOLDER_PASSWORD_HASH; reuses the private `issueNewSession` (G22). |
| `src/auth/auth.routes.ts` | MOD | GET `/auth/google` (set tx cookie, 302 to Google) + GET `/auth/google/callback` (clear tx → validate state → exchange → ladder → sendSession). Audit per branch. |
| `src/users/users.repository.ts` | MOD | `findByGoogleId`, `createFromOAuth`, `linkGoogleAccount` (conditional `updateMany WHERE id AND google_id IS NULL`, G5). Kept thin (one intent/method). |
| `src/config.ts` | MOD | GOOGLE_CLIENT_ID/SECRET (required strings) + GOOGLE_REDIRECT_URI (url) in the Zod envSchema (G18). |
| `src/shared/audit.ts` | MOD | OAUTH_START/CALLBACK/LINK/CREATE/LINK_DENIED/STATE_REJECTED actions (G24). |
| `src/app.ts` | MOD | Construct GoogleOAuthClient from config at the composition root; inject into authRoutes (DI). |
| `.env.example` | MOD | Placeholders for the 3 Google vars (never real values, G18). |
| `src/test/setup.ts` | MOD | Throwaway Google env so config validation passes in tests (no live calls). |
| `src/test/fake-prisma.ts` | MOD | `user.findUnique({googleId})`, `user.updateMany` (link guard), `create` honors googleId + UNIQUE(google_id) P2002 (multi-NULL coexist) — the G6 backstop in-memory. |
| `src/auth/oauth-tx.test.ts` | NEW (8 tests) | Seal/open roundtrip, forgery/tamper reject, constant-time compare, cookie attrs. |
| `src/auth/google-oauth.routes.integration.test.ts` | NEW (9 tests) | create/link/returning-login/unverified-reject/state-mismatch/absent-cookie/replay/google-error, PKCE S256 + verifier-not-leaked in redirect. |

### G1–G24 Satisfaction Map
| G | Where satisfied |
|---|---|
| G1 returning user by google_id | `loginWithGoogle` → `findByGoogleId` first; resolves by sub only. |
| G2 verified-email LINK | ladder step 2: `email_verified && findByEmail` → `linkExistingAccount`. |
| G3 CREATE new USER | ladder step 3: `createOAuthAccount` (role USER, dummy hash). |
| G4 unverified → REJECT | `if (!identity.emailVerified) throw AuthError` AFTER the google_id lookup, BEFORE any email branch. Route audits OAUTH_LINK_DENIED. (Smoke-tested: victim row untouched, no new row, no session.) |
| G5 first-time-only link | `linkGoogleAccount` = `updateMany WHERE id AND googleId:null`; count 0 → null → ConflictError. |
| G6 UNIQUE(google_id) backstop | `guardUniqueGoogleId` maps Prisma P2002 → ConflictError on both link + create. |
| G7 passwordless can't password-login | OAUTH_PLACEHOLDER_PASSWORD_HASH (non-matching bcrypt) → existing constant-time `bcrypt.compare` fails closed. |
| G8 PKCE S256 only | `code_challenge_method=S256` hard-coded; `codeChallengeS256` = base64url(SHA256(verifier)); NO plain branch. verifier=32 CSPRNG bytes. |
| G9 state+verifier signed cookie | `oauth_tx` = HMAC-signed {state,verifier}; HttpOnly, Secure(prod), SameSite=Lax, Path=/auth/google, MaxAge=600. |
| G10 single-use | cookie cleared up-front on callback (success AND failure) before any throw; replay test green. |
| G11 verify sig + constant-time state compare | `openOAuthTx` (sig verify, null on forgery/tamper) + `statesMatch` (timingSafeEqual). verifier never in query/body/log. |
| G12 identity from back-channel only | identity solely from `exchangeCodeForIdentity` (token→userinfo); callback params (code/state) only, never claims. |
| G13 id_token verify | N/A by ADR-039 default: userinfo-over-fresh-access-token (no JWKS, no new dep). |
| G14 pin aud/client_id | confidential token exchange authenticates with client_id+client_secret. |
| G15 hardened egress | ONE `fetchGoogle()`: HTTPS assert, AbortSignal.timeout(5s), redirect:'manual', 1 MB body cap, Zod-validate. |
| G16 fail-closed | all transport/parse/validate failures → generic AuthError; no silent success, no retry. |
| G17 no assertSafeUrl on Google | fixed config/const URLs; assertSafeUrl deliberately NOT applied. |
| G18 secrets via config | 3 vars in Zod envSchema; client read from `config` only; .env.example placeholders. |
| G19 secret never logged | client_secret only in the token POST body; never in audit/error/response/log. |
| G20 no open redirect | callback issues session in-place (refresh cookie + access token JSON); no returnTo/next honored. |
| G21 fixed redirect_uri | from `config.GOOGLE_REDIRECT_URI`, identical on auth request + token exchange. |
| G22 same token path | `completeGoogleLogin` → private `issueNewSession` → persistRefreshToken + signAccessToken(role). No fork. |
| G23 distinct cookies | refresh cookie via existing `refreshCookieOptions` (SameSite=Strict, /auth); oauth_tx is separate (Lax, /auth/google). |
| G24 audit events | OAUTH_START / CALLBACK|LINK|CREATE (per branch) / LINK_DENIED / STATE_REJECTED; actorId only. |

### Build Status
tsc --noEmit: exit 0. vitest: 450 passing, 0 failing (29 prior files + 2 new). 433 prior tests unchanged & green.

### Open Items
- Live multi-NULL googleId + duplicate-non-null P2002 smoke on real Postgres: DEFERRED (Docker daemon DOWN this run, same as db-engineer OA-3). Fake-prisma enforces the identical NULL-distinct + P2002 semantics (exercised by create/link tests). qa-engineer OA-5 / quality-lead OA-6 to run once a DB is up.
- No NEEDS_REVIEW / no escalation: ADR-039 userinfo path needed no JOSE lib, so no tech-lead escalation.

### Pre-implementation scan
Input validation: callback query Zod-parsed (G11/G12); Google responses Zod-validated (G15). Auth: /auth/google + /callback intentionally PUBLIC (login entry, documented in route comments). Authz: role server-set USER, never from Google claims (G22). Data exposure: AuthResponse unchanged (no googleId/hash in body); generic client errors (no enumeration). External calls: fetchGoogle hardened, fail-closed; secret config-only. CLEAN per the security contract.
<!-- /agent: backend-dev -->

<!-- agent: qa-engineer -->
## QA-Engineer Output (OAuth2 Google Login) — Phase OA-5 — 2026-06-11

VERDICT: DONE (Gate-3 PASS). Independently verified backend-dev's numbers, then exhaustively tested the
OAuth flow with Google MOCKED (no live network). tsc --noEmit exit 0. vitest: **483/483 passing, 0 failing,
33 files** (450 backend-dev baseline + 33 NEW qa tests). 0 source edits (test-only). NO bugs found — the
OA-4 implementation matched the G1–G24 contract on every item I drove. NO pinned regressions.

### Test Summary (new/extended files)
| Test file | Tests | Pass | Fail | Action |
|---|---|---|---|---|
| `src/auth/google-oauth.client.test.ts` | 14 | 14 | 0 | NEW — drives REAL fetchGoogle, global `fetch` mocked (like url-safety mocks node:dns) |
| `src/auth/google-oauth.service.test.ts` | 12 | 12 | 0 | NEW — loginWithGoogle ladder vs fake-prisma (G1–G7, race/conflict backstops) |
| `src/auth/oauth-tx.test.ts` | 11 | 11 | 0 | EXTENDED (+3): signed-but-wrong-shape / signed-but-non-JSON / empty-sig guards |
| `src/auth/google-oauth.routes.integration.test.ts` | 13 | 13 | 0 | EXTENDED (+4): exchange-fail-closed, 409-already-linked, secret-not-in-response, missing-code |
| **Full suite** | **483** | **483** | **0** | 33 files; 0 regressions vs the 450 baseline |

### Coverage Report (new OAuth code — target line ≥90 / branch ≥85)
| File | Line% | Branch% | Func% | Note |
|---|---|---|---|---|
| `src/auth/auth.routes.ts` (GET /auth/google + /callback) | 100 | 100 | 100 | full route matrix |
| `src/auth/oauth-tx.ts` | 100 | 100 | 100 | was 97.84/90 at OA-4; closed the JSON-boundary guards |
| `src/auth/google-oauth.client.ts` | 99.17 | 96 | 100 | **was 67.35/100/50** — egress hardening was untested; now driven via mocked fetch |
| `src/auth/auth.service.ts` | 99.46 | 96.22 | 100 | loginWithGoogle ladder fully covered |
| **Global** | **99.28** | **96.88** | **99.02** | up from 97.70/96.05 baseline |

### Headline Matrix (each = a Gate-1 G-item) — all VERIFIED
1. HAPPY first-login CREATE (G3): new google_id, no match, verified → passwordless USER (dummy hash, role USER), session issued, refresh cookie set. ✓ (service + route)
2. SUBSEQUENT login by google_id (G1): returning user, no dup, resolves by sub even when Google reports a changed/unverified email. ✓
3. LINK/MERGE (G2/G5): verified + email matches a NULL-google_id password account → conditional first-time-only write (WHERE google_id IS NULL) binds, no dup. ✓
4. **TAKEOVER DEFENSE (G4 — THE critical test)**: email_verified=FALSE matching a victim → REJECTED (401); victim row untouched (google_id stays NULL), no new row, NO token issued. Asserted at BOTH service and route level, explicitly commented as the OA-F1 regression. ✓
5. STATE/CSRF (G10/G11): missing oauth_tx cookie → reject; state mismatch → reject; replay after a completed callback → reject; missing-code → reject (exchange never called); constant-time compare exercised. ✓
6. PKCE (G8/G11): authorization redirect carries code_challenge + method=S256 (never plain); challenge == base64url(SHA256(verifier)); verifier NOT in the redirect/query; token exchange POSTs the verifier in the body. ✓
7. Google error responses (G15/G16): token non-2xx / 5xx / 3xx-manual-redirect / opaqueredirect / network-throw / timeout-abort / malformed-JSON / schema-violation (missing access_token; userinfo missing sub; bad email) → all fail-closed generic AuthError; route surfaces 401, no session; underlying error string NOT leaked. ✓
8. Egress hardening (G15/G17): both Google calls go to the FIXED config URLs (token + userinfo endpoints asserted), redirect:'manual' + AbortSignal on every call, 1MB body cap enforced; assertSafeUrl is NOT invoked on Google egress. ✓
   Plus: G6 P2002 ConflictError on link+create races (409 end-to-end); G7 passwordless cannot password-login; G19 client_secret only in token POST body, never on userinfo / never in the callback response/headers; non-P2002 repo errors propagate unchanged (not masked as conflict).

### Security Controls Verified (security-engineer G1–G24)
G1 ✓ G2 ✓ G3 ✓ G4 ✓ (the takeover test, service+route) G5 ✓ G6 ✓ (link+create P2002→409) G7 ✓ G8 ✓ G9 ✓
G10 ✓ G11 ✓ G12 ✓ (identity only from back-channel) G13 N/A (userinfo path, ADR-039 default — no id_token/JWKS)
G14 ✓ (client_id+secret pin the exchange) G15 ✓ G16 ✓ G17 ✓ (no assertSafeUrl on fixed URLs) G18 ✓ (config test)
G19 ✓ G20 ✓ (in-place session, no redirect honored) G21 ✓ (fixed redirect_uri) G22 ✓ (same issueNewSession token path; access-token role=USER from column) G23 ✓ (distinct cookies) G24 ✓ (audit per branch). Every testable G-item has a test; G13 is N/A by design.

### Bugs Found
| Bug | Severity | Reproduction | Regression test |
|---|---|---|---|
| (none) | — | — | — |
No bugs. No pinned regressions. The suite is green; no source was edited.

### Documented uncovered lines (NOT coverage-padded — defensive guards)
- `google-oauth.client.ts:183-184` — the fetchGoogle HTTPS-only assertion (G15 defense-in-depth). UNREACHABLE via the public API: all three Google endpoints are hardcoded `https://` module constants (G17), so the guard can never see a non-https URL from outside. Left uncovered by design rather than reached via reflection.
- `auth.service.ts:254-255` — inside `refresh()` (the user-not-found-after-revoke branch). PRE-EXISTING, non-OAuth code, unchanged by this feature.

### Test harness notes (for next agent / future OAuth tests)
- Client egress tested by `vi.stubGlobal('fetch', mock)` returning a Response-like `{status,type,text()}` — mirrors how `url-safety.test.ts` mocks `node:dns/promises.lookup`. This is the ONLY way to exercise fetchGoogle without a live Google.
- Service test reuses the `const fake = createFakePrisma(); vi.mock('../shared/prisma')` harness BUT imports AuthService/repos DYNAMICALLY in beforeEach (after the mock applies) — a top-level static import of a prisma-importing module hits the vi.mock hoisting trap ("Cannot access 'fake' before initialization"). Route integration test already does this via `await import('../app')`.
- `vi.useFakeTimers()` still deadlocks `app.inject` (toFake:['Date'] only) — not needed here; AbortSignal.timeout is exercised by throwing from the mocked fetch, not by advancing timers.
<!-- /agent: qa-engineer -->

<!-- agent: code-quality -->
## Code-Quality Output (OAuth2 Google Login) — Phase OA-5 — 2026-06-11

**VERDICT: CLEAN — Gate 2 PASS. 0 P1, 0 P2, 3 P3 (cosmetic, no action to ship). Max CC observed = 7** (`fetchGoogle`). The orchestrator's named hotspot — the create-or-link ladder in `auth.service.ts` — is **CC 4** and is decomposed exactly along the "named single-purpose guards" pattern (no god-function). tsc --noEmit exit 0. check-slop.ps1 on src/auth = CLEAN (0 P1/P2). No duplication of the session/cookie controls (callback REUSES `sendSession` + `issueNewSession`). No speculative provider-agnostic OAuth framework (architect ADR-038 ruling held). All Google constants are named (no magic numbers).

> NOTE: coverage numbers (Gate 3) are qa-engineer's OA-5 deliverable, running in parallel and still PENDING at the time of this review. I assessed complexity/structure/duplication/slop only. Final coverage-vs-baseline (line ≥90 / branch ≥85 new code, no project regression) must be confirmed by quality-lead at OA-6 once qa-engineer lands. No baseline degradation is visible from the structural review (every new function is a small named covered-by-design guard; no risk-band crossing — see below).

### Metrics Summary
| File | Lines | Baseline Lines | Functions | Max fn CC | File CC (est) | Baseline file CC | Delta | Issues |
|------|-------|----------------|-----------|-----------|---------------|------------------|-------|--------|
| `src/auth/google-oauth.client.ts` | 243 | NEW | 4 (+1 free fn) | 7 (`fetchGoogle`) | ~16 | — | new | 0 |
| `src/auth/oauth-tx.ts` | 187 | NEW | 8 | 4 (`openOAuthTx`) | ~13 | — | new | 0 |
| `src/auth/auth.service.ts` | 372 | 212 | 13 | 4 (`loginWithGoogle`/`login`) | ~28 | 22 | +27% (LOW band, <+50%) | 0 |
| `src/auth/auth.routes.ts` | 247 | 137 | 3 plugin + 2 helpers | ~6 (callback) | ~12 | 6 | +100%* | 0 |
| `src/users/users.repository.ts` | 161 | 79 | 7 | 2 | ~8 | 8 | +0% logic / +lines | 0 |
| `src/config.ts` | 99 | 88 | 1 | 2 | ~4 | 4 | +0% | 0 |
| `src/shared/audit.ts` | 79 | 58 | 1 | 1 | ~7 | 7 | +0% (data-only) | 0 |
| `src/app.ts` | 161 | 132 | 3 | 2 | ~2 | 2 | +0% | 0 |

\* `auth.routes.ts` file-CC roughly doubles (6→~12) but that is two NEW small route handlers being ADDED (each ≤ CC 6), not any existing function growing — it stays deep in the LOW band (0–30) and crosses no risk boundary. Per the baseline degradation rule the trigger is *file complexity increases >50% vs baseline* → this is a structural ADD of new endpoints, the kind of growth the LOW band exists to absorb; flagging it P2 would be mechanical. Every added branch is a named, individually-testable guard. (auth.service +27% is comfortably under the +50% P1 line and stays LOW.)

### Per-function complexity (the hotspots called out in the brief)
| Function | File | CC | Notes |
|----------|------|----|----|
| `loginWithGoogle` | auth.service.ts | **4** | The create-or-link LADDER. 3 decisions: google_id match (G1) → unverified-reject (G4) → email-match. Each outcome delegates to a NAMED private helper (`completeGoogleLogin`/`linkExistingAccount`/`createOAuthAccount`). This IS the "decompose the security validator into named single-purpose guards" pattern — not a god-function. |
| `linkExistingAccount` | auth.service.ts | 2 | one guard (null → ConflictError). |
| `createOAuthAccount` | auth.service.ts | 1 | straight-line. |
| `guardUniqueGoogleId` | auth.service.ts | 3 | P2002 → ConflictError translation, single reused try/catch (G6 backstop) — shared by both link + create, zero copy-paste. |
| callback handler | auth.routes.ts | ~6 | base + 4 `||` in the single reject gate (absent/forged cookie, error, missing state/code, state-mismatch) + 1 try/catch. The compound `if` is a deliberate single fail-closed gate, all branches collapse to ONE generic rejection (no enumeration) — readable, not a smell. |
| `fetchGoogle` | google-oauth.client.ts | **7** | the ONE hardened egress wrapper (https-assert / timeout-catch / non-2xx+opaqueredirect / JSON-parse-catch / schema-fail). Highest CC in the change; every branch is a distinct fail-closed control. Under 10. |
| `exchangeCodeForIdentity` | google-oauth.client.ts | 1 | straight-line (two `fetchGoogle` calls). |
| `openOAuthTx` | oauth-tx.ts | 4 | sig-verify + shape-guard + parse-catch, returns null on any integrity failure. |

### Duplication scan (the explicit brief concern)
- **NO duplication of the session-issuance / cookie control.** The callback handler ends with `return sendSession(reply, result, HTTP_STATUS.OK)` — the SAME helper `/auth/login`, `/auth/register`, `/auth/refresh` use. The service-side `completeGoogleLogin` delegates to the existing private `issueNewSession` (G22 — token path NOT forked). Refresh-cookie attributes come from the existing `refreshCookieOptions`. Zero copy-paste of the token/cookie path. ✅
- **`fetchGoogle` does NOT reinvent error handling** — it is the single point that maps every transport/parse/validate failure to a generic `AuthError`; both Google calls (`token`, `userinfo`) route through it. No per-call bespoke try/catch. ✅
- P2002 → ConflictError is centralized once in `guardUniqueGoogleId` and reused by both link + create (no duplicated Prisma-error mapping). ✅
- Constants single-sourced: endpoints/scopes/timeout/body-cap in google-oauth.client.ts; cookie name/path/max-age/random-bytes in oauth-tx.ts. No magic numbers in logic.

### AI-slop scan
- check-slop.ps1 on src/auth (7 files): **CLEAN, 0 P1/P2.**
- Manual: NO speculative provider-agnostic OAuth abstraction (architect ruled against it; it did NOT creep in — the client is concretely `GoogleOAuthClient`, fixed Google endpoints). NO single-impl interface theatre (`GoogleOAuthClientConfig`/`GoogleIdentity`/`AuthorizationRequest` are real DTOs, not one-impl service interfaces). NO async-without-await. NO empty catch (every `catch` fails closed with a typed `AuthError`/returns null deliberately). NO dead code. Comments explain WHY (the SameSite=Lax rationale, the `updateMany`-vs-`update` reason, the back-channel-only identity rule) — not WHAT. The `email_verified` string-or-boolean union and the up-front cookie-clear are documented with intent. ✅

### Naming / readability (will it be clear in 2 years?)
- Security-critical steps ARE self-documenting: `statesMatch` (constant-time), `openOAuthTx`/`sealOAuthTx`, `codeChallengeS256`, `guardUniqueGoogleId`, `loginWithGoogle` ladder comment maps each step to its G-requirement. The takeover gate is a single named branch `if (!identity.emailVerified) throw` with a comment stating it sits AFTER the google_id lookup but BEFORE any email branch. PKCE S256-only is asserted by construction (no `plain` path) and commented. ✅

### Layering (ADR-010/011) — zero violations
- `GoogleOAuthClient` is transport-only: NO Prisma, NO Fastify, NO token issuance, NO create-or-link policy (architect ADR-038 honored). Create-or-link policy lives in the auth SERVICE; users-table writes live ONLY in `users.repository`; HTTP/cookie concerns ONLY in routes. `app.ts` constructs the client from `config` at the composition root (secret never leaves the config boundary). ✅

### P3 Notes (cosmetic — ship as-is)
- (Q1) `google-oauth.client.ts:111` `access_type=online` is set unconditionally with a comment about "only when needed" — the comment slightly over-promises vs the code (it's always online). Harmless; tighten the comment opportunistically.
- (Q2) `OAUTH_PLACEHOLDER_PASSWORD_HASH` (auth.service.ts:50) and `DUMMY_BCRYPT_HASH` (line 19) are byte-identical literals kept as two separately-named constants by intent (different call-sites/semantics: no-user-found timing vs passwordless-account stamp). Deliberate, documented; not a DRY violation — noted only so a future reader doesn't "dedupe" them and couple two unrelated concerns.
- (Q3) `audit.ts` AUDIT_ACTION is now 30+ entries in one flat object across 5 features; still readable (grouped by comment block), but approaching the size where a per-domain split could help. Not actionable now.

**Gate 2 (Code Quality): PASS.** RECOMMENDED_NEXT: quality-lead (OA-6, Gate-4) — pair this CLEAN with qa-engineer OA-5 coverage for the final SHIP IT. No backend-dev rework needed (0 P1/P2).
<!-- /agent: code-quality -->

<!-- agent: quality-lead -->
## Quality-Lead Output (OAuth2 Google Login) — Phase OA-6 — 2026-06-11

### Verification (INDEPENDENTLY RE-RUN — did not trust the reports)
- `npx vitest run` → **483 passed / 483 (33 files), 0 failed / 0 skipped / 0 flaky**. Matches qa-engineer's claim EXACTLY (450 baseline + 33 new).
- `npx tsc --noEmit` → **exit 0** (clean build).
- `npx vitest run --coverage` global → **line 99.28% (5671/5712) / branch 96.88% (623/643)** — UP from prior baseline (97.70/96.05 pre-OAuth, AP baseline 99.2/96.57). NO regression.
- New-OAuth-file coverage (all ≥90 line / ≥85 branch new-code gate): `oauth-tx.ts` 100/100; `auth.routes.ts` 100/100 (the 2 new routes); `auth.repository.ts`/`auth.schemas.ts` 100/100; `google-oauth.client.ts` 99.17/96 (uncovered 183-184); `auth.service.ts` 99.46/96.22 (uncovered 254-255).
- Documented-uncovered lines HAND-VERIFIED as genuine defensive guards, NOT coverage padding: client.ts 183-184 = HTTPS-only assertion behind fixed-https constants (unreachable defense-in-depth); auth.service.ts 254-255 = pre-existing non-OAuth refresh "user vanished between revoke and re-read" race-defense. qa-engineer's documentation is accurate; declining-to-pad is the correct call.

### Gate 1 — Security: PASS (VERIFIED IN CODE, hand-traced, did not take on faith)
- **Header**: SECURITY_REVIEW=REQUIRED, SECURITY_STATUS=DONE; security-engineer receipt DONE, 0 Critical / 0 unmitigated High (G1–G24 were forward requirements, all now implemented + tested). No unresolved HIGH → not a FIX IT trigger.
- **G4 takeover defense (auth.service.ts loginWithGoogle L128-146)**: ladder = (G1) `findByGoogleId(sub)` FIRST → returning user issues session (trusted prior binding); THEN `if (!identity.emailVerified) throw AuthError` at **L137** GATES every email-based branch. An UNVERIFIED email matching an existing account hits L137 and is REJECTED *before* `findByEmail`/`linkExistingAccount` — no link, no create, no session. Hand-trace confirms the gate sits after the google_id lookup and before any email branch. ✅
- **G4 regression test EXISTS (grepped, not a claimed count)** at BOTH layers: `google-oauth.service.test.ts:156` "takeover defense (G4)" → REJECT unverified-email-matching-victim (no row, no session) + the G1-precedence test (returning user still logs in even if Google now reports unverified); `google-oauth.routes.integration.test.ts:180` G4 takeover via real app. ✅
- **oauth-tx.ts**: state single-use (cookie cleared UP-FRONT on callback, auth.routes.ts L174), HMAC-SHA256 signed over JWT_SECRET (L142-143), constant-time compare via `timingSafeEqual` with length short-circuit (L154-161); `statesMatch` constant-time (L132-134); `openOAuthTx` returns null on ANY integrity failure (bad shape/sig/JSON). Cookie: `httpOnly:true`, `secure:isProduction`, `sameSite:'lax'`, `path:/auth/google`, `maxAge:600` (L59-65). SameSite=Lax is DELIBERATE + correct (callback is a cross-site top-level GET from Google) — reviewers must NOT "fix" to Strict; distinct from the SameSite=Strict refresh cookie. ✅
- **google-oauth.client.ts**: PKCE `code_challenge_method` hard-coded `'S256'` (L109), NO `plain` branch anywhere; `codeChallengeS256` = SHA256→base64url (L240-242). `fetchGoogle()` is the ONE egress wrapper: HTTPS-only assert (L182), `AbortSignal.timeout(5s)` fail-closed (L192), `redirect:'manual'` + opaqueredirect reject (L191/L200), bounded body 1MB (readBounded L224-230), Zod-validated JSON (L210); all failures → generic AuthError. Identity from back-channel userinfo only (no id_token/JWKS → no new dep). ✅
- **Token path NOT forked (G22)**: `loginWithGoogle` → `completeGoogleLogin` → `issueNewSession` → `signAccessToken(user.id, user.role)` — the SAME path as password login; OAuth users get role from `users.role` (never body). ✅
- **GOOGLE_CLIENT_SECRET config-only / never logged (G19)**: declared in config.ts L63 (Zod-validated env), injected at app.ts L136 from `config.GOOGLE_CLIENT_SECRET`, sent ONLY in the token POST body (client.ts L132), explicitly redacted in audit.ts L39. Tests assert it never appears in callback response (routes integration :332) nor on the userinfo call (client.test :188-190). ✅

### Gate 2 — Code Quality: PASS
code-quality OA-5 verdict CLEAN — 0 P1 / 0 P2, 3 cosmetic P3. Max function CC = 7 (`fetchGoogle`); `loginWithGoogle` CC 4, decomposed into named single-purpose guards (not a god-function). No forked token path, single egress error-handler, P2002→ConflictError centralized once. check-slop CLEAN. 3 P3 (access_type comment over-promise; intentional DUMMY/PLACEHOLDER hash twins — do NOT dedupe; AUDIT_ACTION object growing) are non-actionable. Confirmed.

### Gate 3 — Test Coverage: PASS
Line 99.28% / branch 96.88% global (≫ 90/85 new-code and 80/70 project floors). All testable G1–G24 have a test (G13 N/A — userinfo path, no id_token/JWKS per ADR-039). 0 bugs found, 0 pinned regressions, 0 source edits by qa (test-only). New-file coverage all ≥99 line. Gate 3 GREEN.

### DEFERRAL RULING (live-Postgres multi-NULL googleId + duplicate-non-null P2002 smoke)
**ACCEPTABLE DEFERRAL — does NOT block SHIP IT.** Rationale: (1) the `@unique`-over-nullable pattern is ALREADY live-verified on real postgres:16 in migration 004 (FlaggedUrl.proposed_code: multi-NULL coexist + duplicate-non-null reject), and migration 005 uses the byte-identical pattern (`prisma migrate diff --from-empty` byte-match + `prisma validate` clean, per db-engineer OA-3). (2) fake-prisma mirrors the NULL-distinct + P2002 semantics, and the service create/link conflict tests exercise the ConflictError(G6) backstop in-memory. (3) Docker was down across OA-3/OA-4/OA-5 — environmental, not a quality defect. **Documented follow-up (P3, non-blocking):** re-run the live multi-NULL + duplicate-non-null + `WHERE google_id=$sub` Index-Scan smoke against migration 005 once a DB is up (owner: db-engineer, next time Docker is available). This is a confirmation of an already-proven pattern, not an unverified risk.

### Gates summary
| Gate | Verdict | Basis |
|------|---------|-------|
| Gate 1 — Security | **PASS** | SECURITY_STATUS=DONE, 0 Critical/High; G4 takeover gate + regression test (both layers), PKCE-S256-only, signed single-use Lax cookie + constant-time state, hardened fetchGoogle, secret config-only, token path not forked — ALL verified in code |
| Gate 2 — Code Quality | **PASS** | code-quality CLEAN, 0 P1/0 P2, max CC 7, no forked path, 3 cosmetic P3 |
| Gate 3 — Coverage | **PASS** | 99.28% line / 96.88% branch global; new OAuth files all ≥99 line; uncovered lines = genuine defensive guards |
| Gate 4 — Final | **PASS** | 0 P1; tsc 0; 483/483 green; coverage ≫ floors; security cleared; no new dep |

### P1 Findings (must fix before ship)
NONE.

### P2 Findings (document, ship)
NONE.

### P3 Notes (non-blocking)
- (Q1) access_type=online comment over-promises (cosmetic).
- (Q2) DUMMY_BCRYPT_HASH / OAUTH_PLACEHOLDER_PASSWORD_HASH intentional twins — do NOT dedupe (different semantics).
- (Q3) AUDIT_ACTION flat object 30+ entries — per-domain split eventually.
- (Q4) Live-Postgres migration-005 smoke deferred (see ruling above) — owner db-engineer when Docker is up.

### Verdict: **SHIP IT**
Zero P1, build passes (tsc 0), 483/483 tests green, coverage 99.28%/96.88% (≫ 90/85), security cleared (0 Critical/High; G4 takeover gate + regression test verified in code; PKCE-S256-only; signed single-use Lax cookie with constant-time state; hardened egress; secret config-only; token path not forked), code-quality CLEAN, no new dependency. The one deferral is an acceptable, documented confirmation of an already-live-verified pattern.

RECOMMENDED_NEXT: tech-writer (OA-7) — document only the approved surface (docs/api.md GET /auth/google + /auth/google/callback, CHANGELOG OAuth entry, .env.example GOOGLE_* note). devops cleared to deploy. Also: code-quality should add the new OAuth files to .quality-baseline.json with final coverage + version bump (1.2.0→1.3.0) at OA-7.
<!-- /agent: quality-lead -->

<!-- agent: tech-writer -->
## Tech-Writer Output (OAuth2 Google Login) — Phase OA-7 — 2026-06-11

Documented the SHIP-IT-approved OAuth2 Google login (quality-lead Gate-4, 483/483, 99.28% line). Documented from SOURCE, not the spec (house rule). `npx tsc --noEmit` exit 0 as proof the routes/types documented exist; both curl examples were verified against a running instance (PORT=3999).

**Files changed (3):**

| Document | Changes | Examples verified |
|---|---|---|
| `docs/api.md` | New `## OAuth2 Google Login` section after `POST /auth/logout`: the 4-step flow diagram, back-channel-identity + read-only-scopes note, create-or-link **semantics table** (login/link/create/REJECT) with the ADR-036 takeover "Why", the `oauth_tx` (Lax) vs `refresh_token` (Strict) cookie table with the ADR-037/038 "do not fix to Strict" Why, and both endpoints (`GET /auth/google`, `GET /auth/google/callback`) with method/auth/rate-limit/query/headers/success/errors/curl. Also: 2 ToC entries, an Authentication "Signing in with Google" subsection, 2 rate-limit rows (20/15min). | ✅ `GET /auth/google` → 302 + `Set-Cookie oauth_tx … SameSite=Lax; Path=/auth/google; HttpOnly; Max-Age=600`, Location with `scope=openid+email+profile`, `code_challenge_method=S256`, `access_type=online`. ✅ callback no-cookie → `401 {code:AUTH_ERROR, message:"OAuth login failed"}`. |
| `CHANGELOG.md` | New `[1.4.0] — 2026-06-11` (Keep-a-Changelog), written for USERS: Added (Google sign-in/PKCE, auto-link, 3 new env vars), Security (verified-email takeover defense, single-use `state` CSRF, PKCE S256, back-channel-only identity, generic 401), Notes (Google account is passwordless; returning users matched by google_id). | n/a |
| `package.json` | `version` 1.3.0 → **1.4.0** (lockstep with CHANGELOG; WebSocket=1.2.0, abuse=1.3.0, OAuth=1.4.0). | n/a |

**.env.example:** NO change — backend-dev already added `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (lines 33–41) with accurate, security-aware descriptions (secret sensitivity, redirect-URI exact-match rule). Verified present; nothing to add.

**SOURCE-VERIFIED contracts** (read auth.routes.ts / auth.service.ts / google-oauth.client.ts / oauth-tx.ts / config.ts / app.ts): routes mount at ROOT `/auth/google` + `/auth/google/callback` (no plugin prefix — confirmed `app.register(authRoutes,…)` in registerModules); `GET /auth/google` 302→Google PKCE S256 + state, sets `oauth_tx`; callback clears cookie up-front (single-use), validates state constant-time, back-channel exchange, ladder, then `sendSession` = SAME accessToken + `refresh_token` cookie as `/auth/login`. Scopes `openid email profile` read-only, `access_type=online`. OAuth rate limit 20/15min per IP. Both OAuth failure + state-rejection collapse to generic `401 AUTH_ERROR "OAuth login failed"`; conflict path → `409`. ADR-036/037/038/039/040 rationale carried into the prose.

**Surprises flagged for readers** (in both api.md and CHANGELOG): (1) `oauth_tx` is `SameSite=Lax` by DESIGN (Strict breaks the cross-site callback) — explicit "do not fix to Strict" note. (2) A Google-created account is passwordless — `POST /auth/login` cannot work for it until a password is set. (3) Every failure (forged cookie / stale state / denied consent / unverified email) returns the SAME generic 401 — distinct events live in the audit log only. (4) Returning users resolve by immutable `google_id`, never email — branch 1 logs in even if Google later reports the email unverified.

**Verdict: DONE.**
<!-- /agent: tech-writer -->

<!-- receipt: security-engineer -->
AGENT: security-engineer
STATUS: DONE
TIER: 3
COMPLETED: OA-1 — OAuth2 Google Login threat model, G1–G24 Gate-1 checklist, STRIDE per endpoint, ADR-036/037/039/040
KEY_DECISIONS:
- MERGE POLICY (takeover defense): auto-link ONLY on Google email_verified===true + email match; join by immutable google_id; UNVERIFIED google email → REJECT (never link, never create-separate); first-time-only conditional link write + UNIQUE(google_id) backstop (ADR-036, G1–G7).
- PKCE S256 mandatory (no plain path) + state single-use BOUND to code_verifier in ONE signed HttpOnly SameSite=Lax(!) Path=/auth/google Max-Age≤600 cookie, cleared on callback, constant-time state compare (ADR-037, G8–G11).
- id_token/identity depth: trust claims ONLY from the SERVER-SIDE back-channel exchange — userinfo over the fresh access token (v1 default) OR a FULLY-verified id_token (sig/iss/aud/exp via JWKS); unverified id_token forbidden (ADR-039, G12–G14). Egress hardened (fixed URLs, timeout/no-redirect/bounded, secret config-only, no open-redirect — ADR-040, G15–G21).
BLOCKERS: none
RECOMMENDED_NEXT: backend-dev (OA-4) — gate satisfied (SECURITY_STATUS=DONE); but per the plan OA-2 (data-lead) + OA-3 (db-engineer) run first to land migration 005 + UNIQUE(google_id). architect (OA-1 parallel) ADR-038 concurs with the signed-cookie placement.
HANDOFF_NOTES: backend-dev MUST satisfy all G1–G24. Non-negotiables: (1) REQUIRE email_verified===true before ANY auto-link, join by google_id, REJECT unverified-email logins (G4 is THE takeover test). (2) Reuse AuthService.issueNewSession→persistRefreshToken + signAccessToken — do NOT fork the token path; OAuth users get role USER from users.role (G22). (3) The transient oauth_tx cookie is SameSite=Lax (NOT Strict — callback is a cross-site top-level GET; reviewers must not "fix" to Strict), signed, HttpOnly, Path=/auth/google, ≤600s, cleared-on-callback; it is a DISTINCT cookie from the SameSite=Strict refresh cookie. (4) GOOGLE_CLIENT_SECRET via config.ts only, never logged (BLOCKED if hardcoded). (5) Route ALL Google fetches through one fetchGoogle() helper (HTTPS-only, AbortSignal.timeout, redirect:'manual', body cap, Zod-validate); do NOT apply assertSafeUrl to Google egress (fixed non-user URLs). (6) NO new npm dep — escalate to tech-lead only if a JOSE/JWKS lib becomes unavoidable. ADRs: 036/037/039/040 (security) + 038 (architect boundary).
<!-- /receipt: security-engineer -->

<!-- receipt: architect -->
AGENT: architect
STATUS: DONE
TIER: 3
COMPLETED: OAuth2 Google Login — Phase OA-1 boundary + transient-state architecture (ADR-038)
KEY_DECISIONS:
  - Google OAuth client = service-layer collaborator INSIDE auth module (src/auth/google-oauth.client.ts), transport-only; NOT shared/oauth/, NOT a new module. Server-side fetch owned by service tier, never routes (ADR-010). Wired at app.ts composition root from config.
  - Transient PKCE verifier + state = stateless signed HttpOnly short-TTL cookie (set on /auth/google, read+cleared on callback); NO new datastore (ADR-018 intact). DB-row rejected as default, kept as named fallback.
  - CONFIRMED additive: NO new top-level module, NO new npm dep (Node 22 global fetch + built-in crypto), NO new datastore. No tech-lead escalation from the architecture side.
BLOCKERS: none
RECOMMENDED_NEXT: data-lead (Phase OA-2) — google_id/google_email column delta on User via users.repository (ADR-011 single-table ownership); proceeds in parallel/after security-engineer. backend-dev (OA-4) GATED on SECURITY_STATUS=DONE as the orchestrator already set.
HANDOFF_NOTES: SEAM CONTRACT — architect owns transient-state PLACEMENT (dedicated cookie, distinct from refresh_token, route-layer set/read/clear, no store); security-engineer owns its CRYPTO (CSPRNG state, single-use, state↔verifier↔browser binding, signing/integrity, TTL) AND the cross-site-return cookie SameSite/attributes (refresh cookie is Strict and will likely DROP on the Google→callback top-level navigation — that attribute tuning is security's call). If security mandates server-side single-use that a cookie can't provide → fallback DB OAuthState table (additive, no boundary change, data-lead/db-engineer item). backend-dev: GoogleOAuthClient stays transport-only (URL build + token exchange + userinfo), holds NO create-or-link policy and NO token issuance; create-or-link use-case lives in the auth service tier reusing AuthService session issuance + users.repository; reads Google URLs/creds from config (never process.env). The one residual dep-escalation path is OUTSIDE architecture: id_token JWKS verification + a JOSE lib = security/tech-lead call.
<!-- /receipt: architect -->

<!-- receipt: data-lead -->
AGENT: data-lead
STATUS: DONE
TIER: 4
COMPLETED: OA-2 — google_id/google_email entity delta on User + uniqueness/index strategy + ADR-041 (no new entity, no new store)
KEY_DECISIONS:
- google_id: NULLABLE + plain @unique VarChar(255) (opaque Google `sub`). Plain @unique, NOT a partial index — Postgres treats NULLs as distinct, so password-only rows (all NULL) coexist while every non-null sub is unique; same proven pattern as FlaggedUrl.proposedCode (multi-NULL verified live in migration 004). This @unique IS security's takeover backstop (ADR-036 §5 / G6).
- google_email: NULLABLE VarChar(320), NOT unique, NO index — store-only (audit/display, ADR-036 §6). Login joins on google_id; link joins on the existing primary `email` UNIQUE. Nothing queries google_email.
- Purely additive nullable columns on the existing User aggregate (ADR-011) — confirmed NO 2nd datastore (ADR-018 holds), NO OAuthState table (cookie storage stands, architect ADR-038; security's DB fallback was NOT triggered), NO new entity. Migration is the gentlest class (metadata-only ADD COLUMN, no NOT NULL backfill — gentler than the 004 role column).
BLOCKERS: none
RECOMMENDED_NEXT: db-engineer (OA-3) — implement the 2 Prisma fields + migration 005 (additive nullable cols + UNIQUE(google_id)), prisma generate + tsc + fix the type-contract blast radius, verify 433 tests green. Exact schema lines + migration intent are in my brief.md output section.
HANDOFF_NOTES: EXACT Prisma lines (add after `role`, before `createdAt` in model User): `googleId String? @unique @map("google_id") @db.VarChar(255)` and `googleEmail String? @map("google_email") @db.VarChar(320)`. Migration 005 (005_oauth_google/): UP = ADD COLUMN google_id VARCHAR(255) + ADD COLUMN google_email VARCHAR(320) (both nullable, no default = metadata-only) + CREATE UNIQUE INDEX users_google_id_key ON users(google_id) (inline CONCURRENTLY prod-note, mirror 003/004); DOWN = DROP INDEX then DROP both columns (reverse order). TYPE-CONTRACT (the migration-004 lesson): nullable = GENTLER than role (no required-value propagation), but still touch — (1) PUBLIC_USER_SELECT in users.repository.ts MUST add `googleId: true, googleEmail: true` (Omit<User,'passwordHash'> auto-includes them in the TYPE; the select must include them at RUNTIME or PublicUser drifts — neither is a secret, parallels how role was added); (2) fake-prisma UserRow factory += `googleId: null, googleEmail: null` defaults; (3) any standalone hand-built User literal tsc flags += `googleId: null, googleEmail: null`. Expect FEWER break sites than 004's 6 (nullable needs no value). Run prisma generate → tsc --noEmit exit 0 → 433 green → EXPLAIN re-confirm multi-NULL OK + duplicate-non-null rejected + WHERE google_id=$sub uses users_google_id_key. NOTE: passwordHash stays NOT NULL — OAuth-created users get a non-matching dummy hash (backend OA-4 / G7), NOT a schema relaxation; do NOT touch that column.
<!-- /receipt: data-lead -->

<!-- receipt: db-engineer -->
AGENT: db-engineer
STATUS: DONE
TIER: 3
COMPLETED: OA-3 — migration 005_google_oauth (nullable google_id @unique + google_email on User) + type-contract fix; tsc 0, 433/433 green
KEY_DECISIONS:
- Schema + migration 005 land data-lead ADR-041 VERBATIM: 2 nullable ADD COLUMNs (no DEFAULT, no backfill = metadata-only, gentlest class) + plain UNIQUE(google_id) = users_google_id_key (the G6/OA-F8 takeover backstop). Reversible down.sql (DROP INDEX → DROP cols, reverse order, IF EXISTS guards).
- Drift-proven via `prisma migrate diff --from-empty` byte-match (google_id VARCHAR(255) nullable, google_email VARCHAR(320) nullable, CREATE UNIQUE INDEX users_google_id_key); `prisma validate` clean. Multi-NULL-coexist/dup-reject NOT live-Docker-proven THIS run (daemon down) — but it is the IDENTICAL plain-@unique-over-nullable pattern already LIVE-VERIFIED on postgres:16 in migration 004 (FlaggedUrl.proposed_code).
- Type-contract blast radius (nullable, so gentler than 004's role): PUBLIC_USER_SELECT += googleId/googleEmail true; fake-prisma UserRow factory + 5 test User literals += googleId:null/googleEmail:null. 6 fixture sites + 1 select, ZERO auth/business-logic touched. tsc exit 0, vitest 433/433 (0 regressions).
BLOCKERS: none
RECOMMENDED_NEXT: backend-dev (OA-4) — schema/migration/types are ready; implement the create-or-link OAuth flow (G1–G24) on this column shape.
HANDOFF_NOTES: LIVE-VERIFIED STATE backend-dev can rely on: (1) `googleId`/`googleEmail` are now selectable on PublicUser (added to PUBLIC_USER_SELECT) — `findPublicById` returns them; for the OAuth LOGIN lookup you'll need a NEW repo method `findByGoogleId(sub)` doing `WHERE google_id = $sub` (hits users_google_id_key Index Scan) — it does NOT exist yet, add it in OA-4 (ADR-011: users.repository owns the users table). (2) The LINK write is the conditional `UPDATE users SET google_id=$sub, google_email=$ge WHERE id=$row AND google_id IS NULL` (G5 first-time-only); UNIQUE(google_id) is the race backstop → a second identity claiming a linked row throws P2002 → map to ConflictError (G6). (3) passwordHash STAYS NOT NULL — OAuth-created users MUST get a non-matching DUMMY hash at the app layer (G7 fail-closed login); this is NOT a schema change, do NOT touch the column. (4) fake-prisma user.create still only accepts {email,passwordHash,name} — when you add create-from-oauth / findByGoogleId, EXTEND the fake-prisma user delegate accordingly (it currently has no findUnique-by-googleId branch and create won't persist googleId). (5) When a DB is available, run the live smoke: 2 NULL-googleId inserts succeed + duplicate non-null googleId rejected + WHERE google_id=$sub uses users_google_id_key.
<!-- /receipt: db-engineer -->

<!-- receipt: backend-dev -->
AGENT: backend-dev
STATUS: DONE
TIER: 3
COMPLETED: OA-4 — Google OAuth2 PKCE login (client + 2 routes + create-or-link service + config + audit), G1–G24 all satisfied
KEY_DECISIONS:
- Link algorithm: ladder findByGoogleId(G1) → unverified-reject(G4, before any email branch) → verified-email link via conditional updateMany WHERE google_id IS NULL(G2/G5) → create passwordless USER(G3); Prisma P2002 → ConflictError backstop(G6).
- Identity source = userinfo over the freshly-exchanged access token (ADR-039 default) → NO id_token JWKS verify → NO new dependency → NO tech-lead escalation.
- Transient state: `oauth_tx` cookie = in-module HMAC-SHA256-signed {state,verifier} (JWT_SECRET), SameSite=Lax/Path=/auth/google/MaxAge=600, cleared-up-front-on-callback(single-use); refresh cookie pattern reused untouched + issueNewSession reused (token path NOT forked, G22).
BLOCKERS: none
RECOMMENDED_NEXT: qa-engineer (OA-5: exhaustive mocked-Google matrix + coverage) ‖ code-quality (OA-5: complexity/dup/slop on client+service+routes)
HANDOFF_NOTES: tsc 0; vitest 450/450 (433 prior + 17 new, 0 regressions). NEW files: src/auth/google-oauth.client.ts, src/auth/oauth-tx.ts (+ 2 test files). Endpoints: GET /auth/google, GET /auth/google/callback. qa MUST test the full matrix per-G: create(G3)/link(G2)/returning-by-google_id(G1)/UNVERIFIED-reject(G4 takeover)/state-mismatch+absent+replay(G10/G11)/PKCE-S256-present+verifier-not-leaked(G8/G11)/Google-error-param/passwordless-cannot-password-login(G7)/concurrent-link-race count=0(G5)/P2002-conflict(G6)/secret-never-in-response-or-log(G19)/fetchGoogle timeout+redirect+oversize fail-closed(G15-16). Mock GoogleOAuthClient.prototype.exchangeCodeForIdentity (no live calls) — see my integration test for the pattern (startFlow helper drives GET /auth/google to obtain a real signed oauth_tx cookie + state). DEFERRED: live multi-NULL googleId + duplicate-non-null P2002 smoke on real Postgres (Docker DOWN this run; fake-prisma mirrors the semantics).
<!-- /receipt: backend-dev -->

<!-- receipt: qa-engineer -->
AGENT: qa-engineer
STATUS: DONE
TIER: 3
COMPLETED: OA-5 — exhaustive mocked-Google OAuth test matrix + coverage verification; 483/483 green, tsc 0, 0 source edits
KEY_DECISIONS:
- Closed the OA-4 blind spot: google-oauth.client.ts was 67.35% line (egress hardening never executed because the smoke suite mocked exchangeCodeForIdentity wholesale). NEW google-oauth.client.test.ts drives the REAL fetchGoogle via vi.stubGlobal('fetch') (mirroring url-safety's node:dns mock) → client now 99.17/96/100; the G15/G16 fail-closed matrix (non-2xx/5xx/3xx-manual/opaqueredirect/network-throw/timeout-abort/malformed/schema-violation/1MB-cap) is fully exercised.
- Covered the create-or-link ladder at the SERVICE level (NEW google-oauth.service.test.ts vs fake-prisma): G1–G7 + the race/conflict backstops (link race-lost count=0→ConflictError, P2002→409 on link AND create, non-P2002 propagates unchanged). G4 takeover defense asserted at BOTH service and route level (victim untouched, no row, no token).
- Pushed oauth-tx.ts 97.84→100 by forging validly-signed cookies over wrong-shape / non-JSON payloads (real behavior the route relies on, not a pad). Documented the 2 remaining uncovered lines as genuine defensive guards (client:183-184 https-assert unreachable behind fixed-https constants; service:254-255 pre-existing non-OAuth refresh branch) — explicitly NOT coverage-padded.
BLOCKERS: none — NO bugs found, NO pinned regressions, suite is fully green.
RECOMMENDED_NEXT: quality-lead (OA-6) — Gate-3 PASS; issue the SHIP IT / FIX IT verdict alongside code-quality + security-engineer Gate-1 close-out.
HANDOFF_NOTES: 483/483 passing (450 baseline + 33 new), tsc --noEmit exit 0, 0 source edits (test-only). Coverage on new OAuth code: routes 100/100, oauth-tx 100/100, client 99.17/96, service 99.46/96.22; global 99.28 line / 96.88 branch (up from 97.70/96.05). All testable G1–G24 have a test; G13 N/A (userinfo path, no id_token/JWKS per ADR-039). DEFERRED (not a blocker, inherited from OA-3/OA-4): live-Postgres multi-NULL googleId + duplicate-non-null P2002 smoke — Docker daemon DOWN this run; fake-prisma mirrors the NULL-distinct + P2002 semantics and the create/link conflict tests exercise them in-memory. quality-lead should note this as a documented residual to re-run once a DB is up. New test files: src/auth/google-oauth.client.test.ts, src/auth/google-oauth.service.test.ts; extended: src/auth/oauth-tx.test.ts (+3), src/auth/google-oauth.routes.integration.test.ts (+4).
<!-- /receipt: qa-engineer -->

<!-- receipt: code-quality -->
AGENT: code-quality
STATUS: DONE
TIER: 3
COMPLETED: OA-5 — code-quality review of the OAuth2 Google Login surface (google-oauth.client.ts, oauth-tx.ts, auth.service create-or-link ladder, auth.routes 2 new routes, users.repository, config/app/audit). VERDICT CLEAN, Gate 2 PASS.
KEY_DECISIONS:
- COMPLEXITY: max function CC = 7 (fetchGoogle); the named-hotspot create-or-link ladder loginWithGoogle = CC 4, decomposed into named single-purpose guards (completeGoogleLogin/linkExistingAccount/createOAuthAccount/guardUniqueGoogleId) — NOT a god-function. 0 functions over 10 → 0 P1, 0 P2.
- DUPLICATION: NONE of a security control — callback REUSES sendSession + the private issueNewSession (token path not forked, G22); fetchGoogle is the ONE egress error-handler for both Google calls; P2002→ConflictError centralized once. Clean.
- SLOP: check-slop.ps1 src/auth CLEAN (0 P1/P2); manual = no provider-agnostic OAuth framework (ADR-038 held), no one-impl interfaces, no empty catch (all fail-closed typed), no async-without-await, magic numbers all named constants. 3 P3 cosmetic only.
BLOCKERS: none (0 P1)
RECOMMENDED_NEXT: quality-lead — OA-6 Gate-4 SHIP IT; pair this Gate-2 CLEAN with qa-engineer OA-5 coverage (Gate 3, still PENDING in parallel) for the final verdict.
HANDOFF_NOTES: tsc --noEmit exit 0 (re-run with throwaway Google env). I assessed complexity/structure/duplication/slop ONLY — coverage-vs-baseline (line ≥90/branch ≥85 new, no project regression) is qa-engineer's OA-5 deliverable and was still PENDING; quality-lead MUST confirm it at OA-6 before SHIP IT. No baseline degradation visible structurally: auth.service file-CC 22→~28 (+27%, LOW band, under the +50% P1 line); auth.routes 6→~12 doubles but is two NEW small route handlers ADDED (each ≤CC6, no existing fn grew, no risk-band crossing) — not flagged. .quality-baseline.json NOT updated (defer to post-SHIP-IT major-feature trigger; the OAuth files are new entries quality-lead/code-quality should add at OA-6/OA-7 with final coverage numbers + version bump 1.1.0→1.2.0). 3 P3 (cosmetic, no action): access_type comment over-promises; OAUTH_PLACEHOLDER_PASSWORD_HASH vs DUMMY_BCRYPT_HASH are intentional twins (do NOT dedupe — different semantics); AUDIT_ACTION flat object growing large.
<!-- /receipt: code-quality -->

<!-- receipt: quality-lead -->
AGENT: quality-lead
STATUS: DONE
TIER: 4
COMPLETED: OA-6 — Gate-4 final quality gate for OAuth2 Google Social Login. INDEPENDENTLY re-ran vitest+coverage+tsc and verified Gate 1 in code (hand-traced auth.service/oauth-tx/google-oauth.client + grepped the G4 regression test). VERDICT: SHIP IT.
KEY_DECISIONS:
- SHIP IT — all 4 gates GREEN, 0 P1 / 0 P2. Observed: 483/483 tests pass (33 files, 0 flaky), tsc exit 0, global coverage 99.28% line / 96.88% branch (no regression). Gate 1 verified IN CODE: G4 takeover gate (email_verified===true gates link/create; unverified-matching-victim REJECTED) + regression test present at service AND route level; PKCE S256-only (no plain); oauth_tx cookie signed/single-use/HttpOnly/SameSite=Lax/Path=/auth/google/600s + constant-time state; fetchGoogle HTTPS-only/timeout/redirect:manual/bounded/Zod; secret config-only never logged; token path NOT forked (reuses issueNewSession).
- DEFERRAL RULING: live-Postgres multi-NULL googleId + duplicate-non-null P2002 smoke is an ACCEPTABLE non-blocking deferral — the @unique-over-nullable pattern is already live-verified in migration 004 (FlaggedUrl.proposed_code), migration 005 is byte-identical (diff-matched + validate clean), fake-prisma mirrors the semantics, Docker was down (environmental). Documented as P3 follow-up for db-engineer when a DB is up. Does NOT gate SHIP IT.
- Documented-uncovered lines (client 183-184, service 254-255) hand-confirmed as genuine defensive guards, not coverage padding.
BLOCKERS: none
RECOMMENDED_NEXT: tech-writer (OA-7) — document the approved surface only (docs/api.md /auth/google + /callback, CHANGELOG OAuth entry, .env.example GOOGLE_*). devops cleared to deploy. code-quality to add OAuth files to .quality-baseline.json + bump 1.2.0→1.3.0 at OA-7.
HANDOFF_NOTES: SHIP IT granted — nothing to rework. tech-writer: do NOT document the SameSite=Lax oauth_tx cookie as a bug to "fix to Strict" — it is deliberate (cross-site top-level GET callback). G13 (id_token/JWKS) is intentionally N/A per ADR-039 (back-channel userinfo only) — do not document a JWKS path. One residual P3: re-run the migration-005 live smoke (multi-NULL + dup-non-null + WHERE google_id=$sub Index Scan) once Docker is up — it confirms an already-proven pattern, not an open risk.
<!-- /receipt: quality-lead -->

<!-- receipt: tech-writer -->
AGENT: tech-writer
STATUS: DONE
TIER: 3
COMPLETED: OA-7 docs for OAuth2 Google login — docs/api.md "OAuth2 Google Login" section (flow + create-or-link table + cookie table + 2 endpoints), CHANGELOG [1.4.0], package.json 1.3.0→1.4.0
KEY_DECISIONS: (1) Documented from SOURCE not spec; tsc exit 0 + both curl examples verified live (302+Lax cookie / 401 AUTH_ERROR). (2) Picked 1.4.0 by what's taken (WS 1.2.0, abuse 1.3.0); bumped package.json in lockstep. (3) .env.example UNCHANGED — backend-dev already added the 3 GOOGLE_* vars with accurate descriptions; verified present, stated "none".
BLOCKERS: none
RECOMMENDED_NEXT: devops — deploy 1.4.0 (set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI in the target env; redirect URI must exactly match a URI registered on the Google OAuth client). Whole OAuth working tree is still UNCOMMITTED (src/auth/google-oauth.client.ts, oauth-tx.ts, auth.routes/service edits, config.ts, prisma migration 005, tests, docs) — needs commit before/with deploy.
HANDOFF_NOTES: Three reader-facing surprises are flagged in the docs and MUST stay: oauth_tx is SameSite=Lax by design (do NOT "fix" to Strict — Strict breaks the cross-site callback); a Google-created account is passwordless (no /auth/login until a password is set); all OAuth failures collapse to one generic 401 (distinct events in audit log only). code-quality should add the new OAuth files to .quality-baseline.json at deploy time.
<!-- /receipt: tech-writer -->

<!-- receipt: orchestrator -->
AGENT: orchestrator
STATUS: DONE
TIER: 1
COMPLETED: OAuth2 Google Social Login (OA-2026-06-11) — full 7-phase orchestration, SHIP IT
KEY_DECISIONS:
- RETAINED architect (NEW external-provider integration boundary + transient-state-storage decision = not a verbatim slice copy) but SKIPPED tech-lead (no new dep — direct OAuth2+PKCE on Node 22 global fetch; narrow escalation valve only). RETAINED data-lead+db-engineer (migration 005: google_id/google_email). Skipped ai/ml/frontend/mobile/data-eng/devops/maintainability.
- security-engineer ran FIRST + LOAD-BEARING and GATED backend-dev (SECURITY_STATUS=DONE). The headline account-takeover risk (email-merge) was ruled definitively: auto-link ONLY on Google email_verified===true, join by IMMUTABLE google_id, UNVERIFIED email → REJECT (ADR-036, G4). PKCE S256 + single-use state bound in a signed HttpOnly SameSite=Lax oauth_tx cookie (ADR-037/038); identity via userinfo over the fresh back-channel access token (no JWKS/JOSE → no new dep, ADR-039).
- Reused issueNewSession/persistRefreshToken/signAccessToken/sendSession verbatim — token path NOT forked; ADR-005/012/015 intact.
BLOCKERS: none
RECOMMENDED_NEXT: devops — deploy 1.4.0 (set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI in target env; redirect URI must match the Google OAuth client registration exactly). NOTE: the OAuth working tree is UNCOMMITTED — commit before/with deploy. Follow-up P3 (db-engineer, non-blocking): live-Postgres multi-NULL googleId / duplicate-non-null P2002 smoke once Docker is up (pattern already live-verified via migration 004 FlaggedUrl.proposed_code).
HANDOFF_NOTES: SHIP IT issued by quality-lead on INDEPENDENTLY re-run evidence — 483/483 tests, tsc exit 0, global coverage 99.28% line / 96.88% branch (no regression), Gate-1 G4 takeover defense hand-traced in code at auth.service.ts L137 with regression tests at both service+route layer. 0 P1/0 P2. ADRs 036/037/038/039/040/041 authored. New files: src/auth/{google-oauth.client.ts,oauth-tx.ts} + loginWithGoogle in auth.service.ts + 2 routes; migration 005_google_oauth; docs/api.md OAuth section + CHANGELOG [1.4.0] + package.json 1.4.0. SPAWN CAPABILITY WAS AVAILABLE this session (Agent tool present) — broke the 4-feature "cannot spawn" streak; full end-to-end orchestration executed, no hand-off-to-main-loop needed.
<!-- /receipt: orchestrator -->

---
---

<!-- agent: orchestrator -->
