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
