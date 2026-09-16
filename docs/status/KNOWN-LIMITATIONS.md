# Known limitations

**Read this before deploying to the public internet.**

This is the honest list of what Aether does *not* do. Several entries are deliberate design choices
with a stated trade-off; others are work not yet done. Each says which it is, so you can tell
"unfinished" from "won't fix".

The codebase references this file from six places; the corresponding entries are marked with
**→ referenced by code**.

---

## Security-relevant

### 1. The refresh token lives in `localStorage`

**→ referenced by `packages/frontend/src/lib/api-client.ts`**

The access token is held in memory only and never touches storage. The **refresh token is persisted
in `localStorage`**, because otherwise every page reload would sign the user out.

*Impact:* any XSS on the app's origin can read the refresh token and mint access tokens
indefinitely — until the session is revoked server-side.

*Mitigations in place:* a strict Content-Security-Policy with no `unsafe-inline` for scripts, no
`dangerouslySetInnerHTML` anywhere in the frontend package, and server-side session revocation that
makes a stolen token revocable.

*The correct fix* is an httpOnly cookie plus a CSRF token. That is a backend change (token issuance
and refresh would move to a cookie) and is not scheduled. **This is the largest single weakness in
the project.**

### 2. Session revocation takes up to five seconds to take effect

**→ referenced by `packages/backend/src/middleware/auth.ts`**

Every authenticated request performs a session lookup so a revoked session stops working
immediately, rather than only when its JWT expires. That lookup is cached for a few seconds.

*Impact:* after "revoke this session" or "revoke all sessions", the revoked token keeps working for
up to ~5 seconds. Not a meaningful window for an attacker who just lost access, but it is not
instant, and "log out everywhere" should not be described as instantaneous.

*Why:* without the cache, every API call becomes a database round-trip.

### 3. Rate limiting is per-process unless Redis is configured

**→ see [CONFIGURATION.md](../reference/CONFIGURATION.md#redis_url)**

WebSocket tickets and rate-limit counters live in the cache. With the default in-process cache, they
are per-backend-process.

*Impact:* running more than one backend replica without `REDIS_URL` means each replica enforces its
own rate limits and cannot redeem another replica's WebSocket ticket. The backend detects this and
logs loudly, but it does **not** refuse to start.

*Rule:* more than one replica requires `REDIS_URL`. One replica is fine without it.

### 4. No two-factor authentication

There is no TOTP, no WebAuthn, no recovery codes. A password is the only factor.

### 5. No external security audit

This project has not been penetration-tested or audited. The threat model in
[SECURITY-MODEL.md](../security/SECURITY-MODEL.md) is the authors' own reasoning, not a third-party
assessment.

---

## Functional gaps

### 6. Per-process CPU usage is always reported as `0`

**→ referenced by `packages/backend/src/services/system.service.ts` and
`packages/host-agent/src/capabilities/processes.ts`**

Reading `/proc/<pid>/stat` gives a process's *cumulative* CPU time. A percentage requires two
samples separated in time. Aether currently takes one sample and reports `0` rather than inventing a
number.

*Impact:* the Task Manager's CPU column is permanently empty. Memory, state, PID, parent, and
command are all real. System-wide CPU (from `/proc/stat` deltas) *is* implemented; only the
per-process column is affected.

*Fix:* keep the previous sample per PID and compute the delta. Not scheduled.

### 7. File search matches names, not contents

**→ referenced by `packages/backend/src/services/files.service.ts`**

`GET /api/files/search` does a case-insensitive substring match over entry *names*. There is no
content indexing and no full-text search.

*Impact:* searching for a phrase inside a file finds nothing. There is no grep-like capability in
the UI.

### 8. Code Studio has no syntax highlighting

**→ referenced by `packages/frontend/src/apps/code-studio/CodeStudioApp.tsx`**

It is a `textarea` with a line-number gutter, not a code editor. No editor library is a dependency of
the frontend package, and a half-configured one was judged worse than an honest plain editor.

*Impact:* editing works and is safe; there is no highlighting, autocomplete, or bracket matching.

*Related safety rule:* a file the backend truncated for display can never be written back — saving
would silently discard everything past the truncation point. Saving is disabled in that case.

### 9. Applications are compiled in — there is no third-party app installation

The app registry (`packages/frontend/src/apps/registry.ts`) is a static array of React components
built into the bundle. The "App Catalog" app lists that registry; it does not download anything.

*Impact:* there is no app store, no plugin system, and no sandbox for untrusted third-party code.
Adding an app means adding a component and a registry entry. Any future runtime for third-party code
would need its own sandbox design, which does not exist yet.

### 10. No cloud storage, file sync, or multi-device sync

There is no S3/MinIO client, no object storage, and no sync engine. Uploads are written to the
backend's local `UPLOAD_DIR`.

*Impact:* files are not shared between instances, and there is no conflict resolution because there
is no replication. Multiple *users* of one instance share the workspace; multiple *instances* do not
share anything.

### 11. No AI assistant

No agent, no tool-calling layer, no model integration.

### 12. No offline mode / PWA

There is no service worker and no web app manifest. The frontend requires a live connection.

### 13. Host agent is Linux-only

`packages/host-agent` uses `/proc`, `systemd`, and POSIX PTYs. There is no Windows or macOS agent.

---

## Operational

### 14. Windows and macOS agents, and ARM host images

Only relevant to the *agent* (the backend and frontend are platform-independent). Deploying the
agent on a non-`x86_64` host requires building `node-pty` from source; the installer installs a
compiler toolchain, so this works, but the build is slow.

### 15. Process signalling is off by default

`AETHER_PROCESS_SIGNAL_ENABLED` defaults to `false`. Ending a process is the one API action that can
take a host down — a careless click on `sshd` locks the operator out — so it is opt-in. Even when
enabled, the backend refuses to signal PID 1, itself, or any of its own ancestors.

### 16. Backups are operator-driven, and unencrypted

The `aether backup` command produces a complete archive (database, volumes, configuration) with a
SHA-256 checksum, and the script applies a 30-day retention policy. What it does **not** do is run
itself: there is no scheduler built in, so a nightly backup means one cron line the operator adds —
and no built-in scheduling means there is no monitoring of whether backups are actually succeeding.
A failed backup only surfaces when someone looks.

The archive is also **plaintext**, not encrypted: it contains `.env`, so it holds every secret.
Storing it off-host means encrypting it yourself. See
[BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

### 17. No horizontal scaling of the WebSocket layer beyond Redis

Redis makes WebSocket *tickets* portable between replicas, so a client can connect to any replica.
There is no cross-replica fan-out of terminal output or agent events: a terminal session is owned by
the replica that created it. Sticky sessions at the proxy are therefore still required for terminals
in a multi-replica deployment.

---

## Versioning

`AETHER_VERSION` in `packages/shared/src/constants.ts` is `0.1.0`. There is no schema-version
negotiation between backend and frontend, and no support for a frontend older than the backend it
talks to. Deploy them together.
