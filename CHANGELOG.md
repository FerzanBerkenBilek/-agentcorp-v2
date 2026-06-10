# Changelog

All notable changes to the Task Management API are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-06-10

Adds a real-time WebSocket channel that pushes task changes to connected clients
as they happen — no polling required.

### Added

- **Real-time task updates over WebSocket.** Connect to `ws://localhost:3000/ws`
  (`wss://` in production) and receive a push event whenever a task you own or are
  assigned to is created, updated, or deleted. Each event carries the task in the
  same shape as the REST API plus an event type (`task.created`, `task.updated`,
  `task.deleted`) and a timestamp. See the
  [API reference](docs/api.md#websocket--real-time-task-updates).
- **Subscribe to your own feed.** After connecting, send `{"type":"subscribe"}`
  to start receiving events, and `{"type":"unsubscribe"}` to stop. The channel is
  read-only — all changes are still made through the REST API.
- **Two ways to authenticate the connection.** Pass your access token either as a
  WebSocket subprotocol (`access_token.<jwt>`, preferred — keeps the token out of
  the URL) or, for command-line tools, as a `?token=<jwt>` query parameter.

### Security

- **Authenticated, origin-checked connections.** Every connection requires a
  valid access token on the handshake and is closed automatically when that token
  expires. The connection's `Origin` is checked against the `CORS_ORIGINS`
  allowlist to defend against cross-site WebSocket hijacking; in production an
  unlisted or empty-allowlist origin is rejected outright. When the token is
  supplied via the query-param fallback, it is stripped from server request logs
  so it cannot leak.
- **No IDOR on the push channel.** You can only ever subscribe to your own feed —
  a subscribe naming another user is silently ignored, never confirming that the
  other feed exists. Events are delivered only to a task's owner and assignee
  (never broadcast), enforced per event with the same owner-or-assignee rule the
  REST API uses, so a change in assignment is always respected.
- **Abuse and resource limits.** Each user is limited to 10 concurrent
  connections, inbound frames are capped at 8 KB and 20 frames per 10 seconds, and
  a heartbeat reaps dead connections — bounding the resource cost of the new
  channel.

### Notes / Known limitations

- **In-process, single instance, no replay.** Real-time delivery runs in-process
  on a single instance, consistent with the existing scaling note. There is no
  missed-message backfill: a client that is offline (or not yet subscribed) when
  an event fires will not receive it on reconnect. Running multiple instances
  behind a load balancer requires a shared pub/sub layer (Redis) before clients on
  different instances see each other's events. See ADR-025.

---

## [1.1.0] — 2026-06-09

Adds a URL shortener to the API: create short links, resolve them with an
anonymous redirect, and track clicks on links you own.

### Added

- **URL shortener.** Four new endpoints: shorten a long URL (`POST /shorten`),
  resolve a code with an anonymous redirect (`GET /:code`), read a link's click
  analytics (`GET /:code/stats`, owner-only), and delete a link
  (`DELETE /:code`, owner-only). See the
  [API reference](docs/api.md#url-shortener).
- **Short codes.** Each link gets a unique 6-character code drawn from a
  cryptographically secure random source, so codes cannot be guessed or
  enumerated.
- **Click analytics.** Every resolution of a short link increments its click
  count and records the last-accessed time, visible to the link owner via
  `GET /:code/stats`.
- **Per-IP shorten rate limit.** Creating short links is limited to 10 requests
  per minute per IP address to curb abuse.

### Security

- **SSRF-hardened URL validation.** Submitted URLs are validated before they are
  stored: only `http`/`https` schemes are allowed; only ports 80 and 443; URLs
  with embedded credentials are rejected; and every DNS-resolved address is
  range-checked, blocking `localhost`/loopback, private (RFC1918) ranges,
  link-local and cloud-metadata addresses (`169.254.169.254`), CGNAT, IPv6
  unique-local/link-local, and IPv4-mapped IPv6 equivalents. DNS resolution
  fails closed (rejects on error or timeout).
- **Owner-only analytics and deletion.** Only the link owner can read a link's
  stats or delete it. Requests from anyone else return `404 Not Found` (never
  `403`), so the existence of a code is not disclosed.
- **Takedown-safe redirects.** The redirect returns `302 Found` with
  `Cache-Control: no-store` rather than a permanently-cached `301`, so deleting
  a link takes effect immediately and abusive links can be retracted — and
  click counting keeps working on every hit.

---

## [1.0.0] — 2026-06-09

Initial public release of the Task Management API: a REST API for creating,
organizing, assigning, and tracking tasks, with secure JWT-based authentication.

### Added

#### Accounts and authentication
- **User registration and login.** Create an account and sign in with an email
  and password.
- **JWT-based sessions.** Successful login issues a short-lived access token
  (15 minutes) for API calls and a long-lived refresh token (7 days) delivered
  as a secure, HttpOnly cookie.
- **Token refresh and logout.** Exchange a valid refresh token for a new access
  token without re-entering credentials; log out to end the session and revoke
  the refresh token.
- **Refresh token rotation with reuse detection.** Every refresh issues a brand
  new refresh token and retires the old one. If a previously used (stolen)
  refresh token is replayed, the entire token family is revoked — forcing a
  re-login and shutting down a hijacked session.
- **Rate limiting on authentication.** Registration and login are limited to
  5 requests per 15 minutes per IP address to slow brute-force attempts.

#### Tasks
- **Task management (create, read, update, delete).** Full lifecycle control
  over your tasks.
- **Task assignment.** Assign any task to another registered user; assignees can
  view and update tasks assigned to them.
- **Filtering by status and priority.** Filter task lists by status
  (`TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`) and priority
  (`LOW`, `MEDIUM`, `HIGH`, `URGENT`).
- **Pagination.** Task lists are paginated (default 20 items per page, maximum
  100) to keep responses fast and bounded.

#### Profile
- **Profile endpoint.** Retrieve the authenticated user's own profile.

#### API surface
- 10 REST endpoints: 4 for authentication, 5 for tasks, and 1 for the user
  profile. See the [API reference](docs/api.md) for full request and response
  details, error codes, and working examples.

### Security

- **Object-level authorization (no IDOR).** You can only access tasks you own or
  that are assigned to you. Requests for other users' tasks return a `404 Not
  Found` — never confirming that a task exists — so resources cannot be
  enumerated by guessing IDs.
- **Refresh token reuse detection.** Replaying a stolen, already-used refresh
  token revokes the whole token family, neutralizing the stolen credential.
- **Generic authentication errors.** Login failures return a single, generic
  "invalid credentials" message regardless of whether the email exists, and
  token errors do not disclose token state — preventing user enumeration and
  information leakage.
- **Hardened by default.** Passwords are stored only as bcrypt hashes; JWTs are
  pinned to the HS256 algorithm (forged "no-algorithm" tokens are rejected);
  security headers (helmet) and a strict CORS policy are enforced; and
  security-relevant actions are written to an audit log.

### Notes / Known limitations

- **Single-instance scaling.** Rate limiting and refresh-token storage currently
  operate per instance. Running multiple instances behind a load balancer
  requires a shared store (Redis) for correct distributed counting before
  horizontal scaling. See ADR-014 and ADR-018.
- **No container or CI tooling yet.** The repository does not ship a Dockerfile,
  `docker-compose.yml`, or a CI workflow. Local setup uses a single `docker run`
  for PostgreSQL (see the [README](README.md)). Containerization and CI are
  planned for a future operations sprint.

[1.2.0]: https://keepachangelog.com/en/1.1.0/
[1.1.0]: https://keepachangelog.com/en/1.1.0/
[1.0.0]: https://keepachangelog.com/en/1.1.0/
