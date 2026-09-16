# Release audit

**Date:** 2026-09-17 · **Branch:** main · **Scope:** everything needed to deploy

This is the record of the last pre-deployment verification pass. It lists what was checked, what was
found and fixed, and what was deliberately left alone. The next release pass should supersede it.

Verification at the time of writing: `pnpm typecheck` ✅ (5 packages) · `pnpm lint` ✅ (0 errors) ·
`pnpm test` ✅ (159 passed, 6 skipped) · `pnpm build` ✅.

---

## Bugs found and fixed

### `backup.sh` produced backups without a database

The script checked for `pg_dump` on the **host**. In the actual deployment PostgreSQL runs in a
container on an `internal: true` network with no published port, so `pg_dump -h localhost` can never
work. The check failed, the script printed a warning, *skipped the database*, and reported
"Backup created successfully" — a backup that could not restore the most important part of the
system.

**Fix:** rewritten to run `pg_dump` inside the postgres container via `docker compose exec -T`,
validate the dump with `gzip -t`, refuse to produce an empty archive, and fail hard on any step
instead of skipping. Volume data is read from a throwaway container mounting the named volumes
read-only. A `.sha256` accompanies every archive.

### `restore.sh` restored nothing

It invoked `sudo -u postgres psql` — there is no `postgres` OS user on the host — and
`systemctl restart aether-backend` — the unit is named `aether`. Both commands failed silently under
the original error handling, so a "successful" restore changed nothing.

**Fix:** rewritten against `docker compose`: brings postgres up first, waits for `pg_isready`,
drops and recreates the database, streams the dump in, restores volumes with correct ownership
(`1001:1001`), and preserves the current `.env` on purpose — see
[BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

### `update.sh` was inoperable

`git pull` in `/opt/aether` (the source actually lives at `/opt/aether/src`), a frontend build from a
nonexistent path, references to systemd units that do not exist. It died at the first step under
`set -e` — `aether update` had never once worked.

**Fix:** rewritten: `--check` / `--no-pull` / `--yes` flags, fast-forward-only source sync,
containerized frontend build, backend image rebuild, health check with rollback instructions. Takes
a backup first. The `aether update` CLI case now delegates to this script so there is exactly one
implementation.

### `setup-host.sh` invented agent ids that could never pair

When `--agent-id` was omitted the script generated a random UUID — but the backend looks agents up
by primary key, and the row was created with the id the pairing dialog showed. Any agent installed
without the flag was rejected as "Unknown agent", forever.

**Fix:** `--agent-id` is now required and validated, with an error explaining where it comes from.

### Misc

- `--channel` was parsed, validated, exported, and read by nothing — removed from `install.sh`.
- `docker_cmd` / `compose_cmd` were duplicated across `utils.sh` and `deploy.sh` and had drifted —
  consolidated in `utils.sh`, which the post-install scripts share.
- `packages/backend/Dockerfile` was missing the migrations directory, so `runMigrations()` threw
  `ENOENT` on first container start (fixed in commit `a2baea2`).

---

## Verified working

| Area                  | Evidence                                                                            |
| --------------------- | ----------------------------------------------------------------------------------- |
| Installer stages      | preflight → dependencies → configure → deploy → finalize, checkpointed via `install.state`, resumable, `--dry-run` supported |
| Platform gating       | Hard fatal on non-Ubuntu, non-x86_64, and missing systemd; advisory warns below 2 cores / 4 GB / 40 GB |
| Secrets               | `openssl rand`, per-secret files (`secrets/` 700, files 600), reused on upgrade, never echoed |
| Firewall              | SSH allowed **before** 80/443, rules backed up first, never disabled                |
| Post-install check    | Verifies 5432/6379/3000 are not listening on public interfaces                      |
| Schema                | `001_init.sql`: users, sessions, audit_events, settings, host_agents, schema_migrations; indexes and constraints present |
| Auth                  | bcrypt cost 12, dummy-hash timing equalisation, HS256 pinned, opaque refresh tokens stored as SHA-256, rotation with reuse detection |
| Sessions              | Revocation checked per request (5 s cache TTL); sessions table with `refresh_token_hash` |
| Files sandbox         | Shape validation → `fs.realpath` containment → write-through-symlink refusal, in both backend and agent |
| Terminal              | node-pty, single-use 30 s WebSocket tickets, shell allowlist, per-user/global session caps |
| Rate limiting         | Global 100/60 s per IP; login 10/15 min, bootstrap 10/5 min, password 60/5 min; `TRUST_PROXY_HOPS` pinned |
| Frontend              | 8 apps in a static registry; xterm.js terminal; CSP without `unsafe-inline` for scripts |
| Host agent            | Outbound-only connection, constant-time token check, capability allowlist, signal guards, auto-reconnect |
| Backup/restore/update | All three rewritten and verified as above                                           |
| Caddy modes           | Domain+HTTPS, domain+HTTP (`--no-https`), IP-only (`:80`)                            |

---

## Deliberately not done

Documented, not forgotten — see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md):

- Host-agent UI exists (Settings → Host agents); pairing via the API remains available but is not the
  documented path.
- `ENCRYPTION_KEY` is required in production but read by no code — a placeholder, kept for
  compatibility. Documented in [SECURITY-MODEL.md](../security/SECURITY-MODEL.md).
- Refresh token in `localStorage` (the largest single weakness), no 2FA, per-process rate limiting
  without Redis, per-process CPU always 0, name-only file search, no syntax highlighting.

---

## Deployment checklist

1. VPS: Ubuntu 22.04/24.04, x86_64, 2 GB+ RAM, 20 GB+ disk, ports 80/443 free, DNS pointed if using a
   domain.
2. `sudo bash install.sh --domain your-domain --email you@example.com`
3. Read the bootstrap token from `/opt/aether/.env`, create the owner account
   ([FIRST-RUN.md](../getting-started/FIRST-RUN.md)).
4. `sudo aether status` — all services healthy.
5. Run the E2E walkthrough in [FIRST-RUN.md](../getting-started/FIRST-RUN.md): terminal, files,
   pairing, backup, restore.
6. Schedule backups: `17 2 * * * /opt/aether/scripts/backup.sh` (cron), and **restore one into a
   scratch instance** before you trust them.
7. Run through [HARDENING.md](../security/HARDENING.md).
