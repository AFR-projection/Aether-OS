# Troubleshooting

Symptom first. For each one: how to confirm it, what causes it, how to fix it.

The two commands worth knowing before anything else:

```bash
sudo aether status              # container state
sudo aether logs backend        # follow the backend log
```

Every error response carries a `requestId`, and the backend echoes `x-request-id` on success too. If
you are reporting a problem, that id ties a browser error to the exact server-side log line:

```bash
sudo aether logs backend | grep '<request-id>'
```

---

## First run

### The page loads but there is no login form, only "create owner account"

That is correct on a fresh instance. There is no seeded user and no default password. See
[FIRST-RUN.md](../getting-started/FIRST-RUN.md).

### "A bootstrap token is required"

The installer generated `AETHER_BOOTSTRAP_TOKEN` and the backend is enforcing it.

```bash
sudo grep '^AETHER_BOOTSTRAP_TOKEN=' /opt/aether/.env
```

Paste that into the field. Do not paste it into a chat or a ticket. Once the owner account exists,
bootstrap is refused unconditionally and the token stops mattering.

### Everything returns 502 from Caddy

Caddy is up but the backend is not. Check in this order:

```bash
sudo aether status
sudo aether logs backend | tail -50
```

A backend that exits immediately on startup is almost always **configuration**. The usual causes:

| Log line                                          | Cause                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `Invalid environment configuration:` + a var name | A required variable is missing or malformed                   |
| `JWT_SECRET must be at least 32 characters`       | Truncated secret — the `.env` was edited by hand              |
| `ECONNREFUSED` connecting to postgres             | PostgreSQL is not up yet, or the password in `.env` is wrong  |
| `password authentication failed for user`         | `.env` DB password does not match the volume's actual cluster |

That last one deserves emphasis: **`POSTGRES_PASSWORD` only takes effect when the data volume is
created.** Changing it in `.env` later does not change the role's password in an existing cluster,
so the backend and the database disagree and authentication fails. Either restore the original
password or recreate the volume (which deletes the data — restore from a backup instead).

---

## Login and sessions

### "Too many requests. Please slow down." (429)

The login endpoint allows **10 attempts per 15 minutes per IP**.

Wait it out, or restart the backend to clear the in-memory limiter:

```bash
sudo aether restart
```

While you wait, check whether something is actually attacking you:

```bash
sudo aether logs backend | grep 'auth.login.failed'
```

If you are behind an additional proxy, see the `TRUST_PROXY_HOPS` note below — a misconfigured hop
count makes every client look like one IP, so one person's failures lock out everyone.

### Logged out after 15 minutes

That is the access token lifetime. The frontend refreshes silently using the refresh token, so this
should be invisible — unless refresh is failing. Check the browser console for a failed
`POST /api/auth/refresh`, and the backend log for `refresh token reuse detected`.

That message means a **replayed** refresh token was presented, and the whole session was revoked as
a precaution. Common causes: two tabs racing on the same token, or a client that retried a refresh
it had already sent. Log in again.

### "Session has been revoked or has expired" but I just logged in

Revocation propagates within **5 seconds** (the session cache TTL). If you were just logged out
elsewhere, waiting a moment is the fix. If it persists, the session row is gone — check **Settings →
Sessions**.

### Everyone gets rate-limited at once, or the audit log shows one IP for all users

`TRUST_PROXY_HOPS` is wrong. It must equal the number of proxies actually in front of the backend —
`1` for the standard Caddy deployment.

If it is **higher** than reality, a client can spoof its IP through a forged `X-Forwarded-For` and
bypass rate limiting entirely. If it is **lower**, every request appears to come from the proxy, so
all users share one bucket.

```bash
sudo grep '^TRUST_PROXY_HOPS=' /opt/aether/.env
```

---

## Terminal

### "Terminal support is not available on this host"

`node-pty` failed to load on the **backend** — not the agent.

```bash
curl -s localhost:3000/api/terminal/available
```

That is a native module; it needs a compiler at install time. In Docker this is baked into the
image, so a failure here usually means the image was built on an incompatible platform. Rebuild:

```bash
sudo aether update --no-pull
```

### The terminal connects then immediately closes

The WebSocket ticket is valid for **30 seconds and single-use**. A clock skew between the browser
and the server larger than that breaks the handshake. The browser console will show a close code.

| Close code | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `1000`     | Normal closure — the backend or agent ended the session                        |
| `1003`     | Unsupported data — a malformed frame was received                              |
| `1008`     | Policy violation                                                               |
| `1011`     | Backend error; check `aether logs backend`                                     |
| `4001`     | Unauthenticated — ticket invalid, expired, or already redeemed                 |
| `4003`     | Forbidden — ticket was issued for a different session, or a missing permission |
| `4004`     | Session not found — the session was revoked                                    |
| `4029`     | Rate limited — too many connections too quickly                                |

### Keystrokes lag or the terminal freezes

The terminal is proxied **backend → agent → PTY**. A slow link between backend and agent adds
latency to every keystroke. Check the agent's connection state on **Settings → Host agents**; a host
showing `connected: false` will make any open terminal there appear frozen.

---

## Host agents

The full matrix is in [HOST-AGENTS.md](../operations/HOST-AGENTS.md#troubleshooting). The four that
account for most failures:

**`aether status` says `Host Agent: not connected`.** The installer puts an agent on this machine
automatically; if it is not connected, the backend never acknowledged its handshake. Check both
sides, because either one alone can look fine:

```bash
sudo journalctl -u aether-host-agent -n 50 --no-pager     # does it say "paired with backend"?
sudo aether logs --tail 50 backend | grep 'agent connected'
sudo aether repair                                        # reinstalls and re-registers it
```

`aether doctor` separates the two cases for you: _"service up, not acknowledged by the backend"_ is
the backend side failing (the agent is dialling and being rejected), while _"not running"_ is the
agent side. Either way, `aether repair` is the fix — it reinstalls and re-registers the agent rather
than making you work out which half broke.

**The row stays grey.** On the managed host:

```bash
sudo journalctl -u aether-host-agent -n 50 --no-pager
```

`Unknown agent` means the agent id does not match any row the backend created — almost always a
hand-typed id. It must be the UUID from the pairing dialog.

**`--agent-id` is rejected as required.** Correct. The id is the primary key of a row the backend
already created; the setup script cannot invent one. Copy `AETHER_AGENT_ID` from the pair dialog.

**Everything works but Files is empty.** `AETHER_WORKSPACE_ROOT` must be set on **both** sides and
the agent's root must contain the backend's. Both are enforced independently.

---

## Files

### "Path contains disallowed segments" / "Path resolves outside the workspace"

Working as intended. The sandbox rejects absolute paths, `..`, `~`, drive letters, and symlinks that
point outside `AETHER_WORKSPACE_ROOT`.

If a legitimate path is being rejected, the usual cause is a **symlink inside the workspace pointing
out of it**. `realpath` follows it, the resolved path lands outside the root, and it is refused.
Move the target inside the workspace, or move the workspace root up.

### "Refusing to write through a symbolic link"

A deliberate refusal: writing through a symlink that points outside the sandbox would escape it.
Edit the file at its real location, inside the workspace.

### Upload fails partway through with no clear error

Uploads stream and are capped at 512 MB. The body is never buffered, so the size limit is enforced
while writing and a mid-upload failure surfaces as a broken connection rather than a JSON error.
Check the backend log — and check free disk:

```bash
df -h /var/lib/docker
```

### A large file opens truncated

Files over **5 MB** are truncated in the text viewer rather than rejected, so the editor stays
responsive. Download the file to see all of it.

---

## Backups and restore

### "Backup created successfully" but the archive is tiny

It should not be possible any more — the script fails hard if `pg_dump` fails rather than skipping
the database and reporting success. If you see a small archive, check:

```bash
sudo aether logs postgres | tail -20
```

Then verify the archive before trusting it:

```bash
cd /opt/aether/backups
sha256sum -c aether-backup-<timestamp>.tar.gz.sha256
tar tzf aether-backup-<timestamp>.tar.gz | head -20
```

The checksum file records a bare filename, so `sha256sum -c` only resolves it from inside
`/opt/aether/backups` — run it from there rather than passing the full path.

An archive holds one top-level directory containing `database.sql.gz`, `data.tar.gz` (the workspace
and uploads), `config/` (`.env`, `docker-compose.yml`, `caddy/`), and `metadata/` (the instance id,
the installer's stage checkpoints, and the host agent's identity). If any of those is missing the
backup is not one — `aether restore` will tell you which.

### Restore finished but the data is unchanged

Confirm the archive you restored is the one you meant — restores do not merge, they replace. Check
the service health after:

```bash
sudo aether status
sudo aether logs backend | grep 'aether backend starting'
```

### Restore says the checksum does not match

The archive is corrupt or was truncated in transit. Do not force it. Find an older archive.

### Restore refuses an archive with no checksum

Also deliberate. A missing `.sha256` means the archive's completeness is unverifiable, and restoring
a half-written dump over a healthy database destroys the good copy. If you know the archive is
intact — you made it by hand, or the checksum file was lost in transit —
`AETHER_ALLOW_UNVERIFIED=true aether restore <archive>` proceeds. Read the warning it prints first.

### Restore exits non-zero but the container is up

`aether restore` fails when the instance is not healthy _after_ the data is back: either the
database check inside the backend never passed, or the local host agent did not reconnect to the
backend within the timeout. The restore itself is not rolled back — there is nothing left to roll
back to — so treat the message as "now go look", not "nothing happened".

```bash
sudo aether status
sudo aether logs backend | grep -E 'agent connected|error'
sudo journalctl -u aether-host-agent -n 50 --no-pager
```

A restored archive carries the agent's pairing token in `metadata/agent.env`. If the agent does not
reconnect, its token no longer matches the `host_agents` row the database was restored to — the
archive predates the pairing, or a later re-pair rotated the token. `aether repair` handles this: it
reinstalls and re-registers the local agent, reusing the agent id in `agent.env` and upserting the
row, so the two sides agree again without you copying anything.

```bash
sudo aether repair
```

---

## Updates

### `aether update` fails with a merge conflict

It should not: it uses `git merge --ff-only` precisely so a deployed instance never lands in a
conflicted merge with nobody around to resolve it. A failure means the local source has diverged
from the remote — someone edited files in `/opt/aether/src` directly.

```bash
cd /opt/aether/src && git status
```

Reinstall from the backup rather than trying to reconcile it by hand:

```bash
sudo aether rollback /opt/aether/backups/aether-backup-<timestamp>.tar.gz
```

### Update succeeded but the UI looks unchanged

The browser cached the old bundle. `index.html` is served `no-cache` specifically to prevent this,
but a hard reload rules it out: **Ctrl+Shift+R**.

If it persists, the frontend build did not run:

```bash
sudo aether logs backend | grep 'serving frontend build'
```

### Update left the stack unhealthy

The update prints the archive it took before starting. Restore it:

```bash
sudo aether rollback /opt/aether/backups/aether-backup-<timestamp>.tar.gz
```

Then run `sudo aether repair` and check `aether logs backend` for the actual startup failure.

---

## The stack itself

### "docker compose needs sudo"

Your user is not in the `docker` group. Aether's own scripts handle this with a `docker_cmd` wrapper
that falls back to `sudo`; this only affects commands you type yourself.

```bash
sudo usermod -aG docker "$USER"   # then log out and back in
```

### Ports 80/443 are already in use

Something else is serving HTTP — commonly a preinstalled nginx or apache.

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Stop it, or install with `--no-https` and a different port mapping.

### Certificate issuance fails

ACME HTTP-01 needs the domain to resolve to this host **and** port 80 reachable from the internet.

```bash
dig +short your-domain          # must be this server's public IP
curl -sI http://your-domain     # must reach Caddy
```

Fix DNS, wait for propagation, then retry:

```bash
sudo aether repair
```

### `aether status` shows a container restarting repeatedly

```bash
sudo aether logs <service>
```

A crash loop is nearly always configuration or a full disk. Postgres, in particular, will refuse to
start if the volume permissions were changed by a restore run as the wrong user.

### Disk is full

```bash
docker system df
sudo du -sh /opt/aether/backups
```

Old backups are the usual culprit. Retention defaults to 30 days; prune manually if needed. Clean up
unused layers with `docker system prune`, but **not** `--volumes` — that deletes your data.

---

## Getting a useful bug report

Include:

1. `sudo aether status` output
2. The `requestId` from the failing response (`x-request-id` header, or `error.requestId` in the
   body)
3. The matching backend log line
4. `sudo aether logs backend | grep 'aether backend starting' | head -1 | jq .config`

That last one prints the **shape** of the running configuration — which features are on, which
limits apply — with secrets redacted. It is usually enough to identify a misconfiguration without
anyone having to read your `.env`.

**Never include** a bootstrap token, a pairing token, or `.env` contents in a report. Redact IP
addresses and hostnames if the instance is not public.
