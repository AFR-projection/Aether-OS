# HTTP API reference

Base path: `/api`. All responses are JSON.

## Conventions

**Success is wrapped.** Every successful response body is `{ "data": … }`. The frontend's
`apiRequest` unwraps it; a bare object is never returned.

**Errors are uniform.**

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Missing required permission: files:write",
    "details": { "path": "docs" }
  }
}
```

**Authentication** is a bearer token:

```
Authorization: Bearer <access token>
```

Access tokens last 15 minutes. Exchange the refresh token at `POST /api/auth/refresh` for a new
pair. See [SECURITY-MODEL.md](../security/SECURITY-MODEL.md) and
[REALTIME.md](../architecture/REALTIME.md) for the WebSocket side.

**Authorization** is per-route, via `requirePermission`. The permission column below is what the
server enforces. Hiding a button in the UI is not access control.

**Roles → permissions** (`packages/shared/src/constants.ts`):

| Permission        | owner | admin | operator | viewer |
| ----------------- | :---: | :---: | :------: | :----: |
| `files:read`      |   ●   |   ●   |    ●     |   ●    |
| `files:write`     |   ●   |   ●   |    ●     |        |
| `files:delete`    |   ●   |   ●   |          |        |
| `terminal:create` |   ●   |   ●   |    ●     |        |
| `terminal:attach` |   ●   |   ●   |    ●     |        |
| `process:read`    |   ●   |   ●   |    ●     |   ●    |
| `process:manage`  |   ●   |   ●   |          |        |
| `system:read`     |   ●   |   ●   |    ●     |   ●    |
| `settings:manage` |   ●   |   ●   |          |        |
| `users:manage`    |   ●   |       |          |        |
| `audit:read`      |   ●   |   ●   |          |        |

`owner` holds every permission. `admin` is everything except managing other users.

---

## Health

### `GET /health`

Unauthenticated, deliberately cheap — polled by the installer, Docker's health check, and Caddy.

```json
{ "status": "ok", "version": "0.1.0", "uptimeSeconds": 42, "timestamp": "…" }
```

### `GET /api/health`

Readiness. `200` when healthy, `503` when not.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "…",
  "uptimeSeconds": 42,
  "checks": {
    "database": { "ok": true, "latencyMs": 3 },
    "cache": { "ok": true, "backend": "redis" },
    "terminal": { "ok": true, "activeSessions": 2, "maxSessionsPerUser": 10 }
  }
}
```

**Only the database affects the status.** A memory cache backend is healthy; a Redis backend that is
down has already degraded to the fallback. Downgrading the instance because a _cache_ is unavailable
would turn a performance problem into an outage.

### `GET /api/version`

```json
{ "version": "0.1.0", "terminalAvailable": true, "node": "v20.14.0" }
```

---

## Authentication

### `GET /api/auth/bootstrap-status`

Unauthenticated. Tells the first-run screen whether to show account creation.

```json
{ "data": { "requiresBootstrap": true } }
```

`requiresBootstrap` is `true` only when **zero** users exist.

### `POST /api/auth/bootstrap`

Unauthenticated but rate-limited (10 requests / 15 min). Creates the owner account. Refused with
`409` if any user already exists.

If `AETHER_BOOTSTRAP_TOKEN` is set, the request **must** carry it:

```
X-Bootstrap-Token: <token>
```

Without this, anyone who can reach a freshly installed instance can claim the owner account. In
development the variable is normally unset so the first-run screen needs no token.

**Body** `{ "username": "…", "password": "…", "email": "…"? }` **Returns** `201` with a token pair.

### `POST /api/auth/login`

Rate-limited. **Body** `{ "username": "…", "password": "…" }` **Returns**
`{ data: { accessToken, refreshToken, expiresIn, user } }`

Repeated failures increment `failed_login_attempts` and eventually set `locked_until`.

### `POST /api/auth/refresh`

**Body** `{ "refreshToken": "…" }` → a new token pair.

Refresh tokens are single-use: the presented token's session row is rotated, and the old token stops
working. The token is stored only as a SHA-256 hash, so a database leak does not yield usable
tokens.

### `POST /api/auth/logout` · permission: _authenticated_

Revokes the current session.

### `GET /api/auth/me` · permission: _authenticated_

The current user with their effective permissions.

### `GET /api/auth/sessions` · permission: _authenticated_

Live sessions for the current user — the data behind Settings → Sessions.

### `DELETE /api/auth/sessions/:id` · permission: _authenticated_

Revokes one session. Takes up to ~5 seconds to fully propagate; see
[Known limitations](../status/KNOWN-LIMITATIONS.md#2-session-revocation-takes-up-to-five-seconds-to-take-effect).

### `POST /api/auth/password` · permission: _authenticated_

**Body** `{ "currentPassword": "…", "newPassword": "…" }`. Changing the password revokes other
sessions.

---

## Users · permission: `users:manage`

| Method   | Path             | Purpose                         |
| -------- | ---------------- | ------------------------------- |
| `GET`    | `/api/users`     | List users                      |
| `POST`   | `/api/users`     | Create a user                   |
| `PATCH`  | `/api/users/:id` | Change role, active flag, email |
| `DELETE` | `/api/users/:id` | Delete a user                   |

The single-owner constraint is enforced by a database index, so a second `POST` with `role: "owner"`
fails even under concurrency. Deleting a user sets `audit_events.actor_user_id` to NULL rather than
deleting their history.

---

## Files

Every path is **relative to `AETHER_WORKSPACE_ROOT`** and validated
(`packages/backend/src/security/workspace.ts`). Absolute paths, `..` escapes, and symlinks that
leave the root are rejected.

| Method | Path                  | Permission     | Purpose                                            |
| ------ | --------------------- | -------------- | -------------------------------------------------- |
| `GET`  | `/api/files/list`     | `files:read`   | List a directory                                   |
| `GET`  | `/api/files/stat`     | `files:read`   | Metadata for one entry                             |
| `GET`  | `/api/files/read`     | `files:read`   | Read a file (truncated past `MAX_FILE_READ_BYTES`) |
| `GET`  | `/api/files/download` | `files:read`   | Stream a download                                  |
| `GET`  | `/api/files/search`   | `files:read`   | **Name** substring search — not content            |
| `POST` | `/api/files/write`    | `files:write`  | Write a file                                       |
| `POST` | `/api/files/mkdir`    | `files:write`  | Create a directory                                 |
| `POST` | `/api/files/rename`   | `files:write`  | Rename or move                                     |
| `POST` | `/api/files/upload`   | `files:write`  | Upload (up to `MAX_UPLOAD_BYTES`)                  |
| `POST` | `/api/files/delete`   | `files:delete` | Delete (destructive permission)                    |

Deleting requires its own permission, separate from writing: overwriting your own mistake and
removing someone else's data are different risks.

A file that the backend truncated for display is flagged in the response, and the UI disables saving
— writing it back would silently discard everything past the truncation point.

---

## Terminal

| Method   | Path                                | Permission        | Purpose                          |
| -------- | ----------------------------------- | ----------------- | -------------------------------- |
| `GET`    | `/api/terminal/status`              | _authenticated_   | Terminal subsystem status        |
| `GET`    | `/api/terminal/available`           | _none_            | Whether a PTY can be allocated   |
| `GET`    | `/api/terminal/sessions`            | `terminal:attach` | List sessions                    |
| `POST`   | `/api/terminal/sessions`            | `terminal:create` | Create a session                 |
| `GET`    | `/api/terminal/sessions/:id`        | `terminal:attach` | One session's metadata           |
| `POST`   | `/api/terminal/sessions/:id/input`  | `terminal:attach` | Write to the PTY                 |
| `POST`   | `/api/terminal/sessions/:id/resize` | `terminal:attach` | Resize the PTY                   |
| `POST`   | `/api/terminal/sessions/:id/ticket` | `terminal:attach` | Mint a one-time WebSocket ticket |
| `DELETE` | `/api/terminal/sessions/:id`        | `terminal:attach` | Close a session                  |

The ticket exists because **a WebSocket URL cannot carry an `Authorization` header**, and putting
the access token in a query string writes it into proxy logs and browser history. The ticket is
short-lived and single-use, and is redeemed at `/ws/terminal/:id`.

---

## System

| Method | Path                                | Permission        | Purpose                                  |
| ------ | ----------------------------------- | ----------------- | ---------------------------------------- |
| `GET`  | `/api/system/info`                  | `system:read`     | CPU, memory, disk, load, uptime          |
| `GET`  | `/api/system/processes`             | `process:read`    | Process list                             |
| `POST` | `/api/system/processes/:pid/signal` | `process:manage`  | Send a signal to a process               |
| `GET`  | `/api/system/settings`              | `system:read`     | Instance settings                        |
| `PUT`  | `/api/system/settings`              | `settings:manage` | Update instance settings                 |
| `GET`  | `/api/system/instance`              | _none_            | Public instance identity (name, version) |

**`POST /api/system/processes/:pid/signal`** is the one endpoint that can take a host down. It is
gated on `process:manage` **and** on `AETHER_PROCESS_SIGNAL_ENABLED`, which defaults to `false`.
Even when enabled, the backend refuses to signal PID 1, itself, or any of its own ancestors, and
reports `signalable: false` on those processes in the list response so the UI can grey them out.

---

## Host agents

| Method   | Path                   | Permission        | Purpose                       |
| -------- | ---------------------- | ----------------- | ----------------------------- |
| `GET`    | `/api/agents`          | `settings:manage` | List paired agents            |
| `POST`   | `/api/agents/pair`     | `settings:manage` | Mint a one-time pairing token |
| `DELETE` | `/api/agents/:agentId` | `settings:manage` | Revoke an agent               |

`GET /api/agents` returns `connected` and `connectedAt` from the live connection registry, so a
paired-but-offline agent is distinguishable from a connected one:

```json
{
  "data": [
    {
      "agentId": "…",
      "label": "web-01",
      "ownerUserId": "…",
      "createdAt": "2026-09-17T…",
      "connected": true,
      "connectedAt": "2026-09-17T…"
    }
  ]
}
```

`POST /api/agents/pair` returns `201` with the token **exactly once** — only its SHA-256 hash is
stored, so it can never be shown again. If it is lost, revoke the agent and pair again.

Deletion is a **soft** revoke (`revoked_at`), so the record of what was paired survives.

---

## Audit

### `GET /api/audit` · permission: `audit:read`

Query parameters:

| Parameter     | Type   | Notes                                                |
| ------------- | ------ | ---------------------------------------------------- |
| `action`      | enum   | One of the known audit actions (see `AUDIT_ACTIONS`) |
| `actorUserId` | uuid   | Filter to one actor                                  |
| `limit`       | number | 1–500, default 100                                   |
| `offset`      | number | Pagination offset                                    |

There is **no outcome filter and no time-range filter** — the Security Center pages through with
`limit`/`offset` and filters client-side. Indexed by `at DESC`, `(action, at DESC)`, and
`(actor_user_id, at DESC)`, which covers the filters that do exist.

---

## WebSocket

| Path               | Auth                          | Direction            |
| ------------------ | ----------------------------- | -------------------- |
| `/ws/terminal/:id` | One-time ticket (`?ticket=…`) | browser ↔ backend    |
| `/ws/agent`        | Pairing token                 | host agent ↔ backend |

Message shapes, close codes, and the full handshakes are in
[REALTIME.md](../architecture/REALTIME.md) and [WEBSOCKET.md](WEBSOCKET.md).
