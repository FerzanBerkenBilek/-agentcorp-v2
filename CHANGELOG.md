# Changelog

All notable changes to the Task Management API are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://keepachangelog.com/en/1.1.0/
