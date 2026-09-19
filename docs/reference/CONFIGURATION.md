# Configuration

Every setting is an environment variable, validated at boot by
[`packages/backend/src/config.ts`](../../packages/backend/src/config.ts). A value that fails
validation is a **fatal startup error** with a readable message — the backend does not limp along
with a broken configuration.

`.env.example` in the repository root is the template. The installer writes a real `.env` for you.

## Rules that matter

1. **No inline comments after a value.** Docker Compose's `env_file` parser treats everything after
   `=` as the value, so `PORT=3000  # http` becomes the literal string `3000  # http`. Put comments
   on their own line.
2. **Blank is not "use the default".** A required key that is absent is an error. Optional keys
   documented as "leave blank" accept an empty value.
3. **Secrets have no defaults and no fallbacks.** There is no `?? 'changeme'` anywhere in the config
   layer.

Generate secrets with:

```bash
openssl rand -base64 48   # JWT_SECRET, SESSION_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY
```

---

## Runtime

| Variable   | Default       | Notes                                                                                  |
| ---------- | ------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV` | `development` | One of `development`, `test`, `production`. Enables the extra production checks below. |

## HTTP

| Variable          | Default                                       | Notes                                                                                     |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`            | `3000`                                        | 1–65535                                                                                   |
| `HOST`            | `0.0.0.0`                                     |                                                                                           |
| `BASE_URL`        | `http://localhost:3000`                       | Must parse as a URL. Used for links the backend generates.                                |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated CORS allowlist. Must include the Vite dev server for local frontend work. |

## Database

PostgreSQL is **required**; the backend will not start without it.

| Variable                        | Default | Notes                                                                          |
| ------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                  | —       | Required. `postgresql://user:pass@host:5432/db`                                |
| `DATABASE_POOL_MAX`             | `10`    | 1–100                                                                          |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | `0` disables the timeout. Guards against a runaway query holding a connection. |

The schema is created and migrated by the backend at startup. Never create tables by hand — see
[DATA-MODEL.md](../architecture/DATA-MODEL.md) for why that specifically has caused a failure
before.

## <a id="redis_url"></a>Cache — `REDIS_URL`

| Variable    | Default | Notes                                     |
| ----------- | ------- | ----------------------------------------- |
| `REDIS_URL` | _unset_ | Optional. `redis://[:password@]host:port` |

**This is the setting that decides whether you can run more than one replica.**

- **Unset** → an in-process cache is used. WebSocket tickets and rate-limit counters are
  per-process. This is correct **only for a single backend replica.**
- **Set and reachable** → shared state in Redis, so tickets issued by one replica work on another.
- **Set but unreachable** → the backend logs the degradation loudly and falls back to the in-process
  cache. It does **not** refuse to start: a cache outage must not become a total outage for a
  management plane.

Check which backend is live:

```bash
curl -s localhost:3000/api/health | jq .checks.cache
# { "ok": true, "backend": "redis" }
```

## Secrets

| Variable                   | Default | Notes                                                                                                                     |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`               | —       | **Required**, minimum 32 characters.                                                                                      |
| `JWT_ACCESS_TOKEN_EXPIRY`  | `15m`   |                                                                                                                           |
| `JWT_REFRESH_TOKEN_EXPIRY` | `30d`   |                                                                                                                           |
| `ENCRYPTION_KEY`           | —       | **Required in production.** Rotating it makes existing ciphertext unreadable, so the installer reuses it across upgrades. |
| `SESSION_SECRET`           | _unset_ | Optional.                                                                                                                 |

## Logging

| Variable     | Default | Notes                                                                                                             |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`  | `info`  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. `debug` and `trace` are **rejected in production**. |
| `LOG_FORMAT` | `json`  | `json` or `pretty`. `pretty` is **rejected in production**.                                                       |

Debug logging in production is refused because verbose request logging writes payloads into log
storage.

## Rate limiting

| Variable                  | Default | Notes                          |
| ------------------------- | ------- | ------------------------------ |
| `RATE_LIMIT_ENABLED`      | `true`  | Accepts `1`/`true`/`yes`/`on`. |
| `RATE_LIMIT_MAX_REQUESTS` | `100`   |                                |
| `RATE_LIMIT_WINDOW_MS`    | `60000` | Minimum 1000 ms.               |

Counters live in the cache, so they are per-process unless `REDIS_URL` is set.

## Filesystem sandbox

| Variable                | Default       | Notes                                                                                                                                                                                        |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AETHER_WORKSPACE_ROOT` | `./workspace` | **The only tree the Files app and the terminal may touch.** Resolved with `fs.realpath` at startup; nothing outside it is reachable, regardless of what the process user can otherwise read. |
| `MAX_FILE_SIZE`         | `104857600`   | 100 MiB.                                                                                                                                                                                     |
| `UPLOAD_DIR`            | `./uploads`   | Where uploads are written.                                                                                                                                                                   |

## Terminal

| Variable                    | Default             | Notes                                                    |
| --------------------------- | ------------------- | -------------------------------------------------------- |
| `TERMINAL_ENABLED`          | `true`              |                                                          |
| `TERMINAL_MAX_SESSIONS`     | `10`                | 1–200.                                                   |
| `TERMINAL_IDLE_TIMEOUT`     | `1800000`           | 30 minutes. Minimum 60 s.                                |
| `TERMINAL_SCROLLBACK_LINES` | `10000`             | Minimum 100.                                             |
| `TERMINAL_ALLOWED_SHELLS`   | `/bin/bash,/bin/sh` | Comma-separated allowlist of shells that may be spawned. |

## First-run bootstrap

| Variable                 | Default | Notes                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AETHER_BOOTSTRAP_TOKEN` | _unset_ | When set, `POST /api/auth/bootstrap` additionally requires this value in the `X-Bootstrap-Token` header. Without it, anyone who can reach a fresh instance can claim the owner account. Bootstrap is refused unconditionally once a user exists. Left unset in development so the first-run screen needs no token; the installer always generates one. |
| `AETHER_INSTANCE_ID`     | _unset_ | Stable identifier, generated by the installer and shown on Settings → About.                                                                                                                                                                                                                                                                           |

## Process management

| Variable                        | Default | Notes                                                                                                                                                                                                                         |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AETHER_PROCESS_SIGNAL_ENABLED` | `false` | Whether the Task Manager may signal processes. Defaults off because ending a process is the one API action that can take a host down. Even when enabled, Aether refuses to signal PID 1, itself, or any of its own ancestors. |

## Port previews

A server started on the host — `npm run dev`, `python -m http.server`, anything — binds to loopback
and is therefore invisible to a browser. A preview serves one of those ports from this same hostname
on a spare port, so the project sees itself at the root of its own origin and the desktop can frame
it. See [HOST-AGENTS.md](../operations/HOST-AGENTS.md#port-previews) for how it works end to end.

**`AETHER_PREVIEW_ENABLED`** (default `true`) turns the whole feature off: no address is offered,
and `POST /api/ports/preview` refuses. Listing what the host listens on is part of `ports:read` and
is unaffected.

**`AETHER_PREVIEW_PORT_START`** (default `8443`) is the first preview port. It must not collide with
anything else on the host, and it must be published by Docker and open in the firewall — the
installer keeps those three in step, but only for the range that was in `.env` at install time.

**`AETHER_PREVIEW_PORT_COUNT`** (default `10`) is how many previews can be open at once. A preview
that is stopped frees its address, and so does its twelve-hour expiry.

Two things the installer does with these values, and neither can be inferred at runtime:

- **Published ports.** `docker-compose.yml` forwards the range to Caddy. Compose cannot expand a
  loop, so the range is written into the file when it is generated; changing `.env` alone leaves
  Docker forwarding the old range.
- **Firewall.** `ufw` gets one rule for the range, because the connection is made by the operator's
  browser rather than by the machine. `aether update` writes the same rule, so an instance installed
  before previews existed — or whose `ufw` was enabled afterwards — ends up with it too, including
  when the update has no source changes to apply; see
  [the deployment guide](../operations/DEPLOYMENT.md#the-firewall).

The backend reads the same three values to decide which addresses it will answer on, which is why a
mismatch shows up as a preview that opens a connection nobody accepts.

## Static frontend

| Variable            | Default | Notes                                                                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AETHER_STATIC_DIR` | _unset_ | Directory holding the built frontend, served when it exists. Blank in development — Vite serves the UI and proxies to the backend instead. |

## Trusted proxy

| Variable           | Default | Notes                                                                                                                                                                                                             |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY_HOPS` | `1`     | Number of reverse proxies in front of the backend (Caddy = 1). **Trusting more hops than are actually present lets a client spoof its IP and bypass rate limits.** Set to `0` if the backend is exposed directly. |

---

## Inspecting the running configuration

`describeConfig()` produces a redacted summary — secrets are reported as present/absent, never as
values — and it is logged at startup. It is also never included in an error message, so a malformed
secret cannot end up in a log file or a CI transcript.

```bash
aether logs backend | grep 'aether backend starting' | head -1 | jq .config
```
