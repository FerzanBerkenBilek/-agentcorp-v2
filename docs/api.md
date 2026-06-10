# API Reference

REST API for the Task Management service.

- **Base URL (local):** `http://localhost:3000`
- **Content type:** `application/json` for all request and response bodies (except `204 No Content` responses, which have no body).

---

## Table of Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Error Codes](#error-codes)
- [Endpoints](#endpoints)
  - [POST /auth/register](#post-authregister)
  - [POST /auth/login](#post-authlogin)
  - [POST /auth/refresh](#post-authrefresh)
  - [POST /auth/logout](#post-authlogout)
  - [GET /tasks](#get-tasks)
  - [POST /tasks](#post-tasks)
  - [GET /tasks/:id](#get-tasksid)
  - [PATCH /tasks/:id](#patch-tasksid)
  - [DELETE /tasks/:id](#delete-tasksid)
  - [GET /users/me](#get-usersme)
  - [POST /shorten](#post-shorten)
  - [GET /:code](#get-code)
  - [GET /:code/stats](#get-codestats)
  - [DELETE /:code](#delete-code)
- [WebSocket — Real-Time Task Updates](#websocket--real-time-task-updates)

---

## Conventions

### Response envelope

Every response is a discriminated union.

**Success:**

```json
{ "success": true, "data": { } }
```

**Error:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": [ ]
  }
}
```

`details` is present only for validation errors (the per-field Zod issues).

### Enums

- **TaskStatus:** `TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`
- **TaskPriority:** `LOW`, `MEDIUM`, `HIGH`, `URGENT`

### IDs and timestamps

- All resource IDs are **UUID v4** strings (e.g. `3fa85f64-5717-4562-b3fc-2c963f66afa6`).
- All timestamps are **ISO-8601** strings in UTC (e.g. `2026-06-08T12:34:56.000Z`).

---

## Authentication

The API uses **JWT access tokens** for request authorization and **rotating refresh tokens** for session continuity.

### Obtaining tokens

Call [`POST /auth/register`](#post-authregister) or [`POST /auth/login`](#post-authlogin). Both return:

- An **access token** in the JSON body (`data.accessToken`). Lifetime: `ACCESS_TOKEN_TTL` (default **15 minutes**). Algorithm: HS256.
- A **refresh token** in an HttpOnly cookie named `refresh_token`. Lifetime: `REFRESH_TOKEN_TTL` (default **7 days**). The cookie is `HttpOnly`, `SameSite=Strict`, scoped to `Path=/auth`, and `Secure` in production.

### Using the access token

Send it as a Bearer token on every authenticated endpoint:

```
Authorization: Bearer <accessToken>
```

A missing or malformed header, or an invalid/expired/tampered token, returns `401 AUTH_ERROR`.

### Refreshing

When the access token expires, call [`POST /auth/refresh`](#post-authrefresh). The browser sends the `refresh_token` cookie automatically. The endpoint **rotates** the refresh token: the presented token is consumed and a new one is issued in the same family. Reusing an already-consumed refresh token is treated as theft and **revokes the entire token family** (forces a full re-login). See ADR-012.

Because the refresh and logout endpoints rely on a cookie, they are CSRF-protected: the cookie is `SameSite=Strict` and, when `CORS_ORIGINS` is configured, an `Origin`/`Referer` allowlist check is enforced (`403` on mismatch). See ADR-015.

### Logging out

Call [`POST /auth/logout`](#post-authlogout). It revokes the refresh-token family and clears the cookie. It is idempotent — a missing or unknown token still returns success.

---

## Error Codes

| `code` | HTTP status | When it occurs |
|---|---|---|
| `VALIDATION_ERROR` | `422` | Request body, query, or params failed schema validation, or a malformed/oversized body was sent. |
| `AUTH_ERROR` | `401` | Missing/malformed `Authorization` header, invalid/expired/tampered access token, invalid credentials, or missing/invalid/expired/reused refresh token. |
| `FORBIDDEN` | `403` | CSRF Origin/Referer check failed on a cookie endpoint. |
| `NOT_FOUND` | `404` | Resource does not exist **or** the caller is not authorized to see it (object-level authz returns 404, not 403, to prevent enumeration). |
| `CONFLICT` | `409` | Conflict with existing state (e.g. email already registered). |
| `RATE_LIMIT_EXCEEDED` | `429` | Rate limit exceeded for the endpoint. |
| `INTERNAL_ERROR` | `500` | Unexpected server error. The message is always generic; internals are never leaked. |

### Rate limits (ADR-014)

| Endpoint | Limit |
|---|---|
| `POST /auth/register` | 5 requests / 15 min per IP |
| `POST /auth/login` | 5 requests / 15 min per IP |
| `POST /auth/refresh` | 30 requests / 15 min per IP |
| `POST /shorten` | 10 requests / min per IP |
| All authenticated endpoints (global default) | 100 requests / min per IP |

---

## Endpoints

### POST /auth/register

Create a new account and start a session.

- **Auth:** none
- **Rate limit:** 5 / 15 min per IP

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Content-Type` | `application/json` | Yes |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | Yes | Valid email format. Stored lowercase. |
| `password` | string | Yes | 8–72 chars; at least one letter and one digit. |
| `name` | string | Yes | 1–100 chars. |

Unknown fields are rejected (`.strict()`).

**Success — `201 Created`**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "alice@example.com",
      "name": "Alice"
    }
  }
}
```

Also sets the `refresh_token` HttpOnly cookie.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `422` | `VALIDATION_ERROR` | Invalid/missing email, weak password, missing name, or unknown field. |
| `409` | `CONFLICT` | Email already registered. |
| `429` | `RATE_LIMIT_EXCEEDED` | More than 5 registrations / 15 min from this IP. |

**curl**

```bash
curl -i -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"Sup3rSecret","name":"Alice"}'
```

`-c cookies.txt` saves the refresh cookie for later use.

---

### POST /auth/login

Authenticate with email and password.

- **Auth:** none
- **Rate limit:** 5 / 15 min per IP

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Content-Type` | `application/json` | Yes |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | Yes | Valid email format. |
| `password` | string | Yes | Non-empty. |

**Success — `200 OK`**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "alice@example.com",
      "name": "Alice"
    }
  }
}
```

Also sets the `refresh_token` HttpOnly cookie.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `422` | `VALIDATION_ERROR` | Invalid/missing email or password, or unknown field. |
| `401` | `AUTH_ERROR` | Wrong password **or** unknown email. The message is the generic `Invalid email or password` in both cases (no user enumeration). |
| `429` | `RATE_LIMIT_EXCEEDED` | More than 5 attempts / 15 min from this IP. |

**curl**

```bash
curl -i -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"Sup3rSecret"}'
```

---

### POST /auth/refresh

Rotate the refresh token and issue a fresh access token.

- **Auth:** the `refresh_token` HttpOnly cookie (no Bearer header).
- **Rate limit:** 30 / 15 min per IP
- **CSRF:** Origin/Referer allowlist enforced when `CORS_ORIGINS` is configured.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Cookie` | `refresh_token=<token>` | Yes (sent automatically by browsers) |
| `Origin` | An allowlisted origin | Required only when `CORS_ORIGINS` is set |

No request body.

**Success — `200 OK`**

Same shape as login. A **new** `refresh_token` cookie is set; the old token is now invalid.

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "alice@example.com",
      "name": "Alice"
    }
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Cookie missing; token unknown, expired, or **reused** (reuse also revokes the whole family). |
| `403` | `FORBIDDEN` | `Origin`/`Referer` not on the `CORS_ORIGINS` allowlist (when configured). |
| `429` | `RATE_LIMIT_EXCEEDED` | More than 30 refreshes / 15 min from this IP. |

**curl**

```bash
curl -i -X POST http://localhost:3000/auth/refresh \
  -b cookies.txt -c cookies.txt
```

`-b cookies.txt` sends the saved refresh cookie; `-c cookies.txt` saves the rotated one.

---

### POST /auth/logout

Revoke the refresh-token family and clear the cookie.

- **Auth:** the `refresh_token` HttpOnly cookie (optional — endpoint is idempotent).
- **CSRF:** Origin/Referer allowlist enforced when `CORS_ORIGINS` is configured.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Cookie` | `refresh_token=<token>` | No (idempotent if absent) |
| `Origin` | An allowlisted origin | Required only when `CORS_ORIGINS` is set |

No request body.

**Success — `200 OK`**

```json
{ "success": true, "data": { "loggedOut": true } }
```

The `refresh_token` cookie is cleared. Returns `200` (with this body) whether or not a valid token was present.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `403` | `FORBIDDEN` | `Origin`/`Referer` not on the allowlist (when configured). |

**curl**

```bash
curl -i -X POST http://localhost:3000/auth/logout \
  -b cookies.txt -c cookies.txt
```

---

### GET /tasks

List tasks the caller owns or is assigned to, with optional filtering and pagination.

- **Auth:** Bearer access token.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | Yes |

**Query parameters**

| Param | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `status` | TaskStatus enum | No | — | One of `TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`. |
| `priority` | TaskPriority enum | No | — | One of `LOW`, `MEDIUM`, `HIGH`, `URGENT`. |
| `page` | integer | No | `1` | ≥ 1. Coerced from string. |
| `limit` | integer | No | `20` | 1–100 (hard cap). Coerced from string. |

Unknown query keys are rejected.

**Success — `200 OK`**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "9a1c...",
        "title": "Write the runbook",
        "description": "Cover setup, tests, migrations, deploy",
        "status": "IN_PROGRESS",
        "priority": "HIGH",
        "ownerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "assigneeId": null,
        "createdAt": "2026-06-08T10:00:00.000Z",
        "updatedAt": "2026-06-08T11:00:00.000Z"
      }
    ],
    "pageInfo": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | Bad enum value, `limit` > 100, non-integer page/limit, or unknown query key. |
| `429` | `RATE_LIMIT_EXCEEDED` | More than 100 requests / min from this IP. |

**curl**

```bash
ACCESS_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

curl -s "http://localhost:3000/tasks?status=IN_PROGRESS&priority=HIGH&page=1&limit=20" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

### POST /tasks

Create a task owned by the caller.

- **Auth:** Bearer access token.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | Yes |
| `Content-Type` | `application/json` | Yes |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | Yes | 1–255 chars. |
| `description` | string | No | Free text. |
| `status` | TaskStatus enum | No | Defaults to `TODO`. |
| `priority` | TaskPriority enum | No | Defaults to `MEDIUM`. |
| `assigneeId` | string (UUID) | No | Must be an existing user. |

`ownerId` is **never** accepted from the client — it is set server-side from the JWT. Unknown fields are rejected.

**Success — `201 Created`**

```json
{
  "success": true,
  "data": {
    "id": "9a1c...",
    "title": "Write the runbook",
    "description": null,
    "status": "TODO",
    "priority": "MEDIUM",
    "ownerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "assigneeId": null,
    "createdAt": "2026-06-08T10:00:00.000Z",
    "updatedAt": "2026-06-08T10:00:00.000Z"
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | Missing/empty title, bad enum, non-UUID `assigneeId`, an unknown field (e.g. attempting to set `ownerId`), **or an `assigneeId` that does not match an existing user**. |

**curl**

```bash
curl -i -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Write the runbook","priority":"HIGH"}'
```

With an assignee:

```bash
curl -i -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Review PR","assigneeId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}'
```

---

### GET /tasks/:id

Read a single task.

- **Auth:** Bearer access token. The caller must be the task **owner or assignee**.

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `id` | string (UUID) | Valid UUID. |

**Success — `200 OK`**

```json
{
  "success": true,
  "data": {
    "id": "9a1c...",
    "title": "Write the runbook",
    "description": null,
    "status": "TODO",
    "priority": "HIGH",
    "ownerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "assigneeId": null,
    "createdAt": "2026-06-08T10:00:00.000Z",
    "updatedAt": "2026-06-08T10:00:00.000Z"
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | `id` is not a valid UUID. |
| `404` | `NOT_FOUND` | Task does not exist, **or** the caller is neither owner nor assignee (404 instead of 403 to prevent enumeration). |

**curl**

```bash
curl -s http://localhost:3000/tasks/9a1c1234-5678-90ab-cdef-1234567890ab \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

### PATCH /tasks/:id

Update a task. At least one field must be provided.

- **Auth:** Bearer access token.
- **Authorization (ADR-013):**
  - Owner **or** assignee may update `title`, `description`, `status`, `priority`.
  - **Only the owner** may reassign or unassign (any request that includes the `assigneeId` key is treated as a reassign).
  - `ownerId` can never be changed (it is not an accepted field).

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `id` | string (UUID) | Valid UUID. |

**Request body** (at least one field required)

| Field | Type | Constraints |
|---|---|---|
| `title` | string | 1–255 chars. |
| `description` | string \| null | `null` clears the description. |
| `status` | TaskStatus enum | — |
| `priority` | TaskPriority enum | — |
| `assigneeId` | string (UUID) \| null | UUID of an existing user, or `null` to unassign. Owner-only. |

Unknown fields are rejected. An empty object (`{}`) is rejected with `422`.

**Success — `200 OK`** — returns the full updated task (same shape as `GET /tasks/:id`).

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | Invalid `id`, empty body, bad enum, non-UUID `assigneeId`, unknown field, or an `assigneeId` that does not match an existing user. |
| `404` | `NOT_FOUND` | Task does not exist, the caller may not update it, or a non-owner attempted to reassign. |

**curl**

Update status (owner or assignee):

```bash
curl -i -X PATCH http://localhost:3000/tasks/9a1c1234-5678-90ab-cdef-1234567890ab \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"DONE"}'
```

Reassign (owner only):

```bash
curl -i -X PATCH http://localhost:3000/tasks/9a1c1234-5678-90ab-cdef-1234567890ab \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assigneeId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}'
```

Unassign (owner only):

```bash
curl -i -X PATCH http://localhost:3000/tasks/9a1c1234-5678-90ab-cdef-1234567890ab \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assigneeId":null}'
```

---

### DELETE /tasks/:id

Delete a task.

- **Auth:** Bearer access token. **Owner only.**

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `id` | string (UUID) | Valid UUID. |

**Success — `204 No Content`** — empty body.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | `id` is not a valid UUID. |
| `404` | `NOT_FOUND` | Task does not exist, or the caller is not the owner. |

**curl**

```bash
curl -i -X DELETE http://localhost:3000/tasks/9a1c1234-5678-90ab-cdef-1234567890ab \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

### GET /users/me

Return the authenticated user's profile. The password hash is never included.

- **Auth:** Bearer access token.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | Yes |

**Success — `200 OK`**

```json
{
  "success": true,
  "data": {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "email": "alice@example.com",
    "name": "Alice",
    "createdAt": "2026-06-08T09:00:00.000Z",
    "updatedAt": "2026-06-08T09:00:00.000Z"
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `404` | `NOT_FOUND` | Token is valid but the account no longer exists (e.g. deleted). |

**curl**

```bash
curl -s http://localhost:3000/users/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## URL Shortener

Turn a long URL into a short 6-character code, then resolve that code with an
anonymous redirect. Owners can view click analytics and delete their links.

### Short codes

A short code is exactly **6 characters** from the base62 alphabet
(`A`–`Z`, `a`–`z`, `0`–`9`). Codes are generated from a cryptographically secure
random source (not sequential), so they are not enumerable. The code is the
public token used in the redirect URL (`http://localhost:3000/<code>`).

### URL safety policy (SSRF / open-redirect, ADR-019)

Every submitted URL is validated at creation time before it is stored. A URL is
accepted **only if** it passes all of:

- **Scheme:** `http:` or `https:` only. `javascript:`, `data:`, `file:`, `ftp:`,
  and all other schemes are rejected.
- **No embedded credentials:** a `user:pass@host` URL is rejected.
- **Port:** only the default web ports `80` and `443` (or no explicit port).
- **Host / resolved IP:** the host is resolved via DNS and **every** resolved
  address is range-checked. URLs that point at `localhost`, loopback
  (`127.0.0.0/8`, `::1`), private RFC1918 ranges (`10/8`, `172.16/12`,
  `192.168/16`), link-local / cloud metadata (`169.254.0.0/16`, including
  `169.254.169.254`), CGNAT (`100.64/10`), IPv6 ULA/link-local, and
  **IPv4-mapped IPv6** equivalents (e.g. `::ffff:127.0.0.1`) are rejected.
- **Length:** at most 2048 bytes.
- **Fail closed:** if DNS resolution fails or times out (3s), the URL is
  rejected.

Any violation returns `422 VALIDATION_ERROR`. The rejected URL is never echoed
back in the error message.

---

### POST /shorten

Create a short code for a long URL. The link is owned by the caller.

- **Auth:** Bearer access token.
- **Rate limit:** 10 / min per IP.

**Request headers**

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | Yes |
| `Content-Type` | `application/json` | Yes |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `url` | string | Yes | 1–2048 chars; must pass the [URL safety policy](#url-safety-policy-ssrf--open-redirect-adr-019). |

`url` is the **only** accepted field. Unknown fields are rejected (`.strict()`).
The owner, code, click count, and timestamps are all set server-side.

**Success — `201 Created`**

```json
{
  "success": true,
  "data": {
    "code": "aZ3xK9",
    "originalUrl": "https://example.com/some/very/long/path?ref=newsletter",
    "createdAt": "2026-06-09T12:00:00.000Z"
  }
}
```

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | Missing/empty/oversized `url`, an unknown field, or a URL that fails the safety policy (unsafe scheme, private/loopback/metadata host, disallowed port, embedded credentials, unresolvable host). |
| `429` | `RATE_LIMIT_EXCEEDED` | More than 10 shorten requests / min from this IP. |
| `409` | `CONFLICT` | Could not allocate a unique code after repeated collisions (effectively never — see ADR-022). |

**curl**

```bash
curl -i -X POST http://localhost:3000/shorten \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/some/very/long/path?ref=newsletter"}'
```

---

### GET /:code

Resolve a short code and redirect to the original URL. This is the **only**
shortener endpoint that does not require authentication.

- **Auth:** none (anonymous).
- **Side effect:** increments the link's click count and updates its
  last-accessed time.

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `code` | string | Exactly 6 base62 chars (`^[A-Za-z0-9]{6}$`). |

**Success — `302 Found`**

No body. Response headers:

| Header | Value |
|---|---|
| `Location` | The original (stored) URL. |
| `Cache-Control` | `no-store` |

**Why 302 and not 301 (ADR-020):** a `301 Moved Permanently` is cached
indefinitely by browsers and proxies. That would (a) stop click tracking after
the first hit, since the client never returns to the server, and (b) make a
deleted or abusive link irretractable — a cached 301 keeps redirecting even
after `DELETE /:code`. A `302 Found` with `Cache-Control: no-store` keeps every
click server-mediated, so analytics stay accurate and takedown is immediate.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `404` | — | The code does not exist (or was deleted). Returned with no body, and does not confirm whether any code ever existed. |
| `422` | `VALIDATION_ERROR` | The code is not 6 base62 characters. |

**curl**

```bash
# -i shows the 302 status, Location, and Cache-Control headers.
# Omit -L so curl does NOT auto-follow the redirect.
curl -i http://localhost:3000/aZ3xK9
```

---

### GET /:code/stats

Read click analytics for a short code. **Owner only.**

- **Auth:** Bearer access token. The caller must be the link's owner.

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `code` | string | Exactly 6 base62 chars. |

**Success — `200 OK`**

```json
{
  "success": true,
  "data": {
    "clickCount": 42,
    "createdAt": "2026-06-09T12:00:00.000Z",
    "lastAccessedAt": "2026-06-09T15:30:00.000Z"
  }
}
```

`lastAccessedAt` is `null` until the link has been resolved at least once.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | The code is not 6 base62 characters. |
| `404` | `NOT_FOUND` | The code does not exist, **or** the caller is not its owner (404 instead of 403 to prevent enumeration). See ADR-021. |

**curl**

```bash
curl -s http://localhost:3000/aZ3xK9/stats \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

### DELETE /:code

Delete a short code. **Owner only.** After deletion the redirect returns `404`.

- **Auth:** Bearer access token. The caller must be the link's owner.

**Path parameters**

| Param | Type | Constraints |
|---|---|---|
| `code` | string | Exactly 6 base62 chars. |

**Success — `204 No Content`** — empty body.

**Errors**

| Status | `code` | Cause |
|---|---|---|
| `401` | `AUTH_ERROR` | Missing/invalid access token. |
| `422` | `VALIDATION_ERROR` | The code is not 6 base62 characters. |
| `404` | `NOT_FOUND` | The code does not exist, **or** the caller is not its owner (404 instead of 403 to prevent enumeration). |

**curl**

```bash
curl -i -X DELETE http://localhost:3000/aZ3xK9 \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## WebSocket — Real-Time Task Updates

A WebSocket channel that pushes task lifecycle events to a client in real time.
Whenever a task you own or are assigned to is created, updated, or deleted via
the REST API, an event is delivered to your live, subscribed connections.

- **Endpoint:** `ws://localhost:3000/ws` (use `wss://` in production).
- **Direction:** the server pushes task events to you. The client sends only
  `subscribe`/`unsubscribe` control frames — **there are no mutations over
  WebSocket**; all writes stay on the REST API.
- **Auth:** a valid access token is required on the upgrade handshake (same token
  as REST, see [Authentication](#authentication)). The connection is rejected if
  the token is missing, invalid, expired, or the `Origin` is not allowed.

### Connecting and authenticating

The token is checked **during the upgrade handshake** — there is no
`Authorization` header on a WebSocket (the browser `WebSocket` constructor cannot
set one). Two transports are accepted:

| Transport | How | When to use |
|---|---|---|
| **Subprotocol (preferred)** | Send `Sec-WebSocket-Protocol: access_token.<jwt>` — i.e. `new WebSocket(url, ["access_token." + accessToken])`. | Browsers and any client that can set a WebSocket subprotocol. The token **never appears in the URL**. |
| **Query param (fallback)** | Append `?token=<jwt>` to the URL. | CLI tools (e.g. `wscat`) and clients that cannot set a subprotocol. |

If both are present, the subprotocol wins. When the subprotocol transport is
used, the server selects and echoes the matching `access_token.<jwt>` value back
per RFC 6455; the query-param transport echoes no subprotocol.

> **Why subprotocol is preferred (ADR-026):** a `?token=` URL is captured by
> access logs, proxies, browser history, and the `Referer` header (CWE-532). The
> `Sec-WebSocket-Protocol` header is set by the browser without putting the token
> in the URL. The query-param fallback is still accepted, but the server
> **redacts the token from its own request logs** so it cannot leak server-side.
> Prefer the subprotocol whenever your client supports it.

> **Caveat — query-param token leakage:** if you use `?token=`, the token can be
> recorded by any intermediary that logs URLs (reverse proxies, gateways) and by
> browser history. Treat it as a fallback for tooling, and always use `wss://`
> (TLS) in production so the URL is not exposed on the wire.

> **Why the `Origin` is checked, fail-closed in production (ADR-027):** WebSocket
> upgrades are **not** protected by the browser Same-Origin Policy the way
> `fetch` is, so a malicious page can open a socket with the victim's ambient
> credentials (Cross-Site WebSocket Hijacking). The upgrade enforces the same
> `CORS_ORIGINS` allowlist as the HTTP API. **In production, a missing, unlisted,
> or empty-allowlist `Origin` is rejected** — so a production deployment **must**
> set `CORS_ORIGINS` or every upgrade is refused. In non-production an empty
> allowlist skips the check (dev convenience).

### Connection lifecycle

- **Per-user connection cap:** at most **10** concurrent connections per user. An
  11th concurrent upgrade is rejected with close code `1013`.
- **Heartbeat:** the server pings every **30 seconds**; a connection that does
  not answer the previous ping is closed and reaped.
- **Token expiry:** the connection is force-closed when the access token expires
  (at its `exp`). Reconnect with a fresh token. With the default 15-minute access
  token TTL, expect to reconnect at least that often.
- **Frame limits (inbound):** each client frame is capped at **8 KB**; a client
  may send at most **20 frames per 10-second window**. Exceeding either closes the
  connection.
- **No replay buffer:** events are ephemeral and in-process. A client that is
  disconnected (or not yet subscribed) when an event fires **does not** receive it
  on reconnect — there is no missed-message backfill. On reconnect you get a fresh
  handshake and must re-subscribe.

### Subscribing

After connecting, send a `subscribe` frame to start receiving events for your own
feed. No events are delivered until you subscribe.

**Subscribe frame**

```json
{ "type": "subscribe" }
```

**Unsubscribe frame**

```json
{ "type": "unsubscribe" }
```

Both frames accept an **optional** `userId` field. If present, it **must equal
your own authenticated user id**. A subscribe/unsubscribe naming any other user
is **silently ignored** — the request is dropped with no error and no
acknowledgement, so the existence of another user's feed is never confirmed. You
can only ever subscribe to your own feed; you cannot tap another user's task
stream.

Frames are validated strictly: unknown fields, unknown `type` values, malformed
JSON, and any mutation-style frame are silently ignored (no error frame is
returned, to avoid confirming internal state).

### Event envelope (server → client)

Each pushed event is a JSON text frame with this shape:

```json
{
  "type": "task.updated",
  "task": {
    "id": "9a1c1234-5678-90ab-cdef-1234567890ab",
    "title": "Ship the API",
    "description": null,
    "status": "IN_PROGRESS",
    "priority": "URGENT",
    "ownerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "assigneeId": null,
    "createdAt": "2026-06-10T12:00:00.000Z",
    "updatedAt": "2026-06-10T12:05:00.000Z"
  },
  "timestamp": "2026-06-10T12:05:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | One of `task.created`, `task.updated`, `task.deleted`. |
| `task` | object | The task in the **same wire shape as the REST API** (see [POST /tasks](#post-tasks)). No extra or internal fields. |
| `timestamp` | string | ISO-8601 time the event was emitted. |

For `task.deleted`, the `task` payload is the task's state at deletion time
(including its `ownerId`/`assigneeId`), so the event can still be delivered to the
right recipients after the row is gone.

### Who receives an event (fan-out authorization)

An event is delivered to a connection **only if** all of the following hold:

1. The connection's user is the task's **owner OR its assignee** — the exact same
   owner-or-assignee rule used by the REST API's object-level authorization. There
   is **no global broadcast**; events are only ever sent to the owner and
   assignee.
2. That user has an active `subscribe`.

> **Why this matters (ADR-028 / IDOR defense):** the push channel reuses the
> single REST authorization predicate (`canAccessTask`) per recipient and
> per event — not once at subscribe time — so a change in assignment is always
> respected, and a connection that is neither owner nor assignee receives
> nothing. This is the same rule that makes REST return `404` for tasks you
> cannot see, applied to the real-time channel.

### Close codes

The server uses RFC 6455 close codes. Security rejections all use a generic close
reason (`policy violation`) that never reveals why, to avoid leaking state.

| Code | Meaning | When |
|---|---|---|
| `1000` | Normal closure | Normal client disconnect. |
| `1008` | Policy violation | **All security rejections**: auth failure (missing/invalid/expired token), `Origin` not allowed, inbound-frame rate abuse, and token-expiry force-close. Generic on purpose. |
| `1009` | Message too big | An inbound frame exceeded the 8 KB limit. |
| `1013` | Try again later | The per-user connection cap (10) was exceeded. |

A failed handshake is closed with a code (e.g. `1008`) — it never returns an HTTP
error body.

### Example — `wscat`

[`wscat`](https://github.com/websockets/wscat) (`npm i -g wscat`) is the simplest
way to try the channel. Below uses the **query-param** transport (wscat cannot set
a subprotocol). First obtain an access token (see the
[end-to-end example](#end-to-end-example)).

```bash
# Connect (query-param fallback transport)
wscat -c "ws://localhost:3000/ws?token=$ACCESS_TOKEN"

# Once connected, subscribe to your own feed by sending:
> {"type":"subscribe"}

# Now create or update a task over REST in another terminal:
#   curl -s -X POST http://localhost:3000/tasks \
#     -H "Authorization: Bearer $ACCESS_TOKEN" \
#     -H "Content-Type: application/json" \
#     -d '{"title":"Ship it","priority":"HIGH"}'
#
# The wscat session prints the pushed event:
< {"type":"task.created","task":{...},"timestamp":"2026-06-10T12:00:00.000Z"}
```

### Example — browser (subprotocol transport, preferred)

```js
// The token is passed as a subprotocol, NOT in the URL.
const ws = new WebSocket('wss://api.example.com/ws', [`access_token.${accessToken}`]);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe' }));
});

ws.addEventListener('message', (e) => {
  const event = JSON.parse(e.data); // { type, task, timestamp }
  console.log(event.type, event.task.id);
});
```

> Reconnect with a freshly issued access token when the socket closes — the
> server force-closes a connection at the token's expiry, and there is no replay,
> so re-subscribe after every reconnect.

---

## End-to-end example

A full session from registration to a created task:

```bash
# 1. Register (saves the refresh cookie to cookies.txt)
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"Sup3rSecret","name":"Alice"}'

# 2. Log in and capture the access token (requires jq)
ACCESS_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"alice@example.com","password":"Sup3rSecret"}' \
  | jq -r '.data.accessToken')

# 3. Create a task
curl -s -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship the API","priority":"URGENT"}'

# 4. List tasks
curl -s http://localhost:3000/tasks -H "Authorization: Bearer $ACCESS_TOKEN"
```
