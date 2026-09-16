# Security model

What Aether defends against, how, and — more usefully — what it does not defend against. Every
claim here is traceable to code; where something is configured but does nothing, that is stated
rather than glossed over.

> **Aether has not been through an external security audit.** This document describes the design
> intent and the mechanisms that exist. It is not a substitute for a penetration test before
> exposing an instance to the internet.

---

## The trust boundary

The critical thing to internalise: **the backend does not touch the managed host directly.**

```
browser ──HTTPS/WSS──▶ backend ──WSS──▶ host agent ──▶ the machine
                       (container)      (on the host, as root)
```

The backend runs in a container with no access to the host filesystem, no Docker socket, and no
inbound port on the managed machine. Compromising the backend does **not** by itself grant a shell
on a managed host — an attacker would also need a valid, non-revoked agent credential, and the agent
only executes operations from a fixed capability list.

Conversely, the agent is the most privileged component in the system: it runs as `root` on the host
it manages, and it is deliberately designed to read files, spawn PTYs, and list processes. Treat the
pairing token as equivalent to a root credential for that host — because it is.

| Component  | Runs as | Can reach                                  |
| ---------- | ------- | ------------------------------------------ |
| Caddy      | root in a container | ports 80/443 only             |
| Backend    | uid 1001 in a container | PostgreSQL, Redis, outbound WSS |
| PostgreSQL | uid 999 in a container, `internal: true` network | nothing outside |
| Host agent | **root on the managed host** | everything on that host, scoped by workspace config |

---

## Authentication

### Passwords

Hashed with **bcrypt at cost 12** (`packages/backend/src/services/auth.service.ts:16`), roughly 250 ms
per hash on server hardware.

Login also burns a bcrypt comparison against a fixed dummy hash when the username does not exist
(`burnPasswordComparison`). Without it, "unknown user" would return in microseconds while "wrong
password" takes ~250 ms, and an attacker could enumerate valid usernames by timing alone.

### Access tokens

A JWT, **HS256 with the algorithm pinned** on verification. Accepting whatever the token header
claims is the classic `alg: none` / algorithm-confusion vulnerability; `verifyAccessToken` passes
`algorithms: ['HS256']` and `issuer: 'aether'` explicitly (`auth.service.ts:83`).

Claims: `sub` (user id), `sid` (session id), `username`, `role`. Lifetime is
`JWT_ACCESS_TOKEN_EXPIRY`, **15 minutes** by default.

### Refresh tokens

**Not JWTs.** An opaque 256-bit random value, stored in the database only as a **SHA-256 digest**, so
a database dump does not hand an attacker usable session tokens.

SHA-256 rather than bcrypt is deliberate: the input is already 256 bits of entropy, so there is
nothing to brute-force and the lookup must be fast.

**Rotation with reuse detection.** Every refresh consumes the old token and issues a new one. If a
token that has already been rotated is presented again, the entire session is revoked
(`rotateSession`, `auth.service.ts:240`). That is the standard heuristic: a replayed refresh token
means either theft or a broken client, and both warrant a forced re-login.

### Session revocation

A stateless JWT cannot be revoked, which would make logout and "revoke all sessions" purely
cosmetic. So every authenticated request does a second check: the session row must exist, not be
revoked, and not be expired (`middleware/auth.ts:45`).

The result is cached for **5 seconds** (`SESSION_CACHE_TTL_MS`). A revoked session therefore keeps
working for up to five seconds. This is a deliberate trade-off — without it every request pays a
database round trip — and it is documented in
[KNOWN-LIMITATIONS.md](../status/KNOWN-LIMITATIONS.md).

The cache is the `Cache` abstraction, so with a Redis backend this TTL applies across replicas rather
than per process.

### Bootstrap

`POST /api/auth/bootstrap` creates the first owner account. It is refused unconditionally once any
user exists. When `AETHER_BOOTSTRAP_TOKEN` is set, the request must also carry it in the
`X-Bootstrap-Token` header.

The installer always generates the token. In development it is left unset so the first-run screen
needs no token — which is safe only because a development instance is not reachable from the
internet.

---

## Authorization

Four roles, 11 permissions, enforced server-side on every request by `requirePermission(...)` as a
Fastify pre-handler **after** `authenticate`.

| Role       | Permissions granted                                                                     |
| ---------- | --------------------------------------------------------------------------------------- |
| `owner`    | **All 11.** The account created at first run.                                            |
| `admin`    | files read/write/delete, terminal create/attach, process read/manage, system read, settings, audit read — **but not `users:manage`** |
| `operator` | files read/write, terminal create/attach, process read, system read — **no delete, no signalling, no audit** |
| `viewer`   | files read, process read, system read. **No terminal, no audit.**                        |

Two things surprise people, so they are worth stating outright:

- **`admin` cannot manage users.** It is the one permission deliberately withheld, so that account
  administration stays with `owner`.
- **`viewer` cannot read the audit log.** `audit:read` is not in the viewer set, so the Security
  Center is empty for them.

Permissions are checked against the role, not against anything the client sends. A denied check
records a `permission.denied` audit event including the required permission and the caller's role —
so a privilege-escalation attempt is visible in the log rather than looking like any other 403.

> A terminal is not a sandbox. It is a shell with the agent's privileges. That is why `viewer` does
> not have `terminal:create` and why granting `operator` is a meaningful decision.

---

## Rate limiting

Global limit: **100 requests per 60 seconds per IP** (`RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`).

Tighter limits on the endpoints worth brute-forcing:

| Endpoint                    | Limit               |
| --------------------------- | ------------------- |
| `POST /api/auth/login`      | 10 / 15 minutes     |
| `POST /api/auth/bootstrap`  | 10 / 5 minutes      |
| `POST /api/auth/password`   | 60 / 5 minutes      |

The key is the client IP, and **the number of trusted proxy hops is pinned** via `TRUST_PROXY_HOPS`
(default 1, for Caddy). Trusting `X-Forwarded-For` unconditionally would let a direct client spoof
its own IP and bypass the per-IP limit entirely.

WebSocket connections are separately rate-limited — a socket that exceeds the limit is closed with
code `4029`.

**This limiter is per-process and in-memory.** Running more than one backend replica multiplies every
limit by the number of replicas. See [KNOWN-LIMITATIONS.md](../status/KNOWN-LIMITATIONS.md).

---

## The filesystem sandbox

`AETHER_WORKSPACE_ROOT` is the only tree the UI can read or write, and
`security/workspace.ts` enforces it. Three layers:

1. **Shape.** Absolute paths, `~`, Windows drive letters, NUL bytes, and any `..` segment are
   rejected before the disk is touched (`isSafeRelativePath`).
2. **Reads.** The path is resolved with `fs.realpath` — which follows every symlink — and the
   *resolved* path must still be inside the root. This defeats `workspace/escape -> /etc`.
3. **Writes.** The parent directory is resolved with `realpath` and must be inside the root, and the
   final segment must not itself be a symlink (otherwise the write would follow the link out of the
   sandbox).

Containment is compared **segment-wise**, so `/data/workspace-evil` is correctly rejected for a root
of `/data/workspace`. A naive `startsWith` would accept it.

Rejection is always an error, never a silent rewrite — silently clamping a path would let a caller
believe it read a different file than it did.

Size limits: 100 MB per file (`MAX_FILE_SIZE`), 5 MB read into the text viewer (larger files are
truncated, not rejected), 5000 directory entries per listing, 512 MB per upload.

**The agent enforces the same rules independently.** It does not assume the backend already checked.

---

## The terminal

A browser cannot set an `Authorization` header on a WebSocket handshake. The two usual workarounds
are both poor: putting the access token in the query string writes a long-lived credential into every
reverse-proxy access log, and putting it in a cookie makes it attachable by any page on the origin
(CSRF against the socket).

Instead: the client requests a **ticket** over an authenticated HTTP request, then presents it during
the handshake. A ticket is 256 bits of randomness, valid for **30 seconds**, **single-use**, and bound
to one session id and one user id (`security/ws-ticket.ts`).

Redemption always consumes the ticket, whether or not the binding matches, so a mismatched attempt
cannot be used to probe. A ticket that leaks through a log is useless within seconds and cannot be
replayed.

Beyond the handshake:

- The shell must appear in `TERMINAL_ALLOWED_SHELLS`. The backend does not accept a caller-supplied
  command line, and neither does the agent.
- Maximum **10 sessions per user, 50 globally**, with a 30-minute idle timeout.
- WebSocket payloads are capped at 1 MB.

---

## Audit trail

Sensitive operations are recorded in `aether.audit_events`: authentication events, permission
denials, user management, agent pairing and revocation, session revocation.

Each row records the action, outcome, actor id **and denormalised username**, session id, IP, user
agent, target, and a JSON metadata blob.

Two properties worth noting:

- **The API is append-only.** The only audit route is `GET /api/audit` — there is no endpoint that
  updates or deletes an event. Removing a row requires database access.
- **`actor_user_id` is `ON DELETE SET NULL`**, with the username denormalised alongside it. Deleting
  a user therefore does not erase the record of what they did.

There is **no external log shipping**. An attacker with database access can remove their own trail.
See [KNOWN-LIMITATIONS.md](../status/KNOWN-LIMITATIONS.md).

---

## Web and transport

**Helmet** sets a Content Security Policy: `default-src 'self'`, `script-src 'self'`,
`object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`. `unsafe-inline` is granted for
styles only, because xterm.js injects a style element for its renderer — scripts are not.

**CORS** is an explicit allowlist (`ALLOWED_ORIGINS`), not a wildcard, and only the headers the API
actually uses are permitted.

**TLS** is terminated by Caddy with automatic Let's Encrypt certificates when a domain is configured.
The installer supports HTTP-only mode, and in that mode credentials and terminal keystrokes travel in
the clear — the documentation says so plainly.

**Internal ports are not published.** PostgreSQL, Redis, and the backend listen only on the internal
compose network. Only Caddy binds a host port. The installer's final step verifies that 5432, 6379,
and 3000 are not reachable from outside and reports it if they are.

---

## Injection

**Every SQL query is parameterized.** There is exactly one place where SQL is assembled dynamically —
the audit query's `WHERE` clause (`services/audit.service.ts:75`) — and it joins a fixed set of
hardcoded column fragments while the *values* remain bound parameters. No user input reaches the
query text.

Frontend rendering is React, which escapes by default; there is no `dangerouslySetInnerHTML` in the
codebase. Terminal output goes through xterm.js, which writes to a canvas rather than the DOM.

---

## Secrets

Generated with `openssl rand`, never `$RANDOM`. Each lives in its own file under `<install>/secrets`
(directory `700`, files `600`). They are never echoed, never written to the install log, and **never
regenerated on upgrade**.

The logger redacts any field whose key matches a known secret name — `password`, `token`,
`authorization`, `JWT_SECRET`, `ENCRYPTION_KEY`, and others (`utils/logger.ts`). Startup logs the
*shape* of the configuration (`encryptionKeyConfigured: true`) rather than values.

A backup archive contains `.env` and therefore every secret in plaintext. It is as sensitive as the
server itself — see [BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

### Two secrets that are configured but unused

Neither of these does anything today. They are listed here so their presence in `.env` is not
mistaken for a security property the system has.

| Variable         | Status                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `ENCRYPTION_KEY` | **Required in production** (`config.ts:161`), redacted in logs, **never read by any code**. A placeholder for column-level encryption that has not been built. |
| `SESSION_SECRET` | Optional, defined at `config.ts:66`, **never read by any code**.          |

The consequence is that `ENCRYPTION_KEY`'s requirement is misleading: it implies data is encrypted
at rest when it is not. Removing the requirement is a breaking change for existing deployments, so it
stays — but **do not take its presence as evidence of encryption**.

Rotation is harmless precisely because nothing reads them; rotating `JWT_SECRET` is the one that
matters, and it invalidates every existing token. Documented in
[KNOWN-LIMITATIONS.md](../status/KNOWN-LIMITATIONS.md).

---

## What is not defended against

Stated plainly, because a security document that only lists strengths is a sales document:

- **Refresh token in `localStorage`.** Any XSS on the origin can read it. The CSP makes XSS harder
  and React's escaping makes it harder still, but this is the largest single weakness in the project.
- **No 2FA.** A stolen password is a full compromise.
- **No protection against a malicious owner.** The `owner` role is absolute by design.
- **No external audit trail.** Logs live in the same database an attacker would already have.
- **No cross-replica rate limiting**, and no shared WebSocket fan-out.
- **A compromised agent is a root compromise** of that host. This is inherent to the design, not a
  bug: the agent must be privileged to do its job.
- **The installer's supply chain is trusted.** It downloads Docker, Node, and the repository over
  HTTPS from third parties without signature verification.
- **No abuse protection on the WebSocket upgrade beyond rate limiting** — no maximum concurrent
  connection count per user is enforced at the backend layer for agent sockets.

---

## Reporting a vulnerability

There is no security contact configured yet, and no `SECURITY.md` at the repository root. Until one
exists, report privately to the maintainer rather than opening a public issue, and include the
version, the affected endpoint, and a reproduction.

Do not include a bootstrap token, a pairing token, or `.env` contents in a report.
