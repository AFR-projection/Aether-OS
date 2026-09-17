# Backup and restore

An Aether instance keeps its state in two places: the **PostgreSQL database** and the **data
directory** (`data/workspace` + `data/uploads`, bind-mounted into the backend). The database lives in
a Docker named volume; the data directory lives on the host, because the local host agent runs as a
systemd service on the same machine and must see exactly the tree the backend serves.

`aether backup` produces one archive containing everything needed to rebuild the instance.

---

## What is in a backup

| Component     | Source                                        | Why                                                       |
| ------------- | --------------------------------------------- | --------------------------------------------------------- |
| Database      | `pg_dump` of the `postgres` service            | Users, sessions, audit log, settings, agent registry        |
| Data          | `<install>/data/`                              | Workspace files and uploads                                |
| Configuration | `.env`, `docker-compose.yml`, `caddy/Caddyfile` | Secrets and deployment shape                              |
| Metadata      | `instance.json`, `install.state`, `local-agent.json`, `local-agent/agent.env` | Instance identity, and the local agent's identity so the restored host reconnects |

In the archive those are `database.sql.gz`, `data.tar.gz`, `config/`, and `metadata/`, under one
top-level directory named after the archive.

Two things are deliberately absent. **Redis** holds only WebSocket tickets and rate-limit counters —
all reconstructible, so losing it loses nothing durable. The **frontend bundle** (`static/`) is
rebuilt on restore rather than archived: it is an artifact of one commit, and shipping an old bundle
to a newer backend is the version skew the docs warn about.

Each step fails hard rather than skipping. An earlier version looked for `pg_dump` on the *host*, and
on a Docker deployment it could never find it — so it logged a warning, produced an archive with no
database in it, and still printed "Backup created successfully". A backup that silently omits the
data is worse than no backup, because it is trusted.

### The archive is a secret

The archive contains `.env` (`JWT_SECRET`, `ENCRYPTION_KEY`) and the host agent's pairing token in
`metadata/agent.env`. Anyone with the archive can mint valid tokens for your instance, decrypt data
written by it, and connect an agent it controls. Treat a backup like the private keys it contains:
encrypt it before it leaves the host, and never commit one.

---

## Taking a backup

```bash
aether backup
```

Writes:

```
/opt/aether/backups/aether-backup-20260917-101500.tar.gz
/opt/aether/backups/aether-backup-20260917-101500.tar.gz.sha256
```

```bash
aether backup list        # ARCHIVE  SIZE  CREATED
```

The checksum is what lets a restore tell a truncated archive from a complete one — `tar -tzf` only
proves the gzip stream is intact, not that the archive finished being written.

Every step is mandatory. If `pg_dump` fails, or the dump comes out empty, or the data archive is
empty, the script **fails and says so** rather than writing a partial archive. An earlier version
checked for `pg_dump` on the *host* and, not finding it, logged a warning and continued — producing
a backup with no database in it while printing "Backup created successfully". A backup that
silently omits the data is worse than no backup, because you trust it.

### Scheduling

Nothing schedules backups for you. Add a cron entry as root:

```bash
sudo crontab -e
```

```cron
# Nightly at 02:17 — off the hour, to avoid the thundering herd of every other cron job.
17 2 * * * /opt/aether/scripts/backup.sh >> /var/log/aether-backup.log 2>&1
```

Retention defaults to 30 days (`AETHER_BACKUP_RETENTION_DAYS`). An off-hour minute is deliberate:
thousands of Aether instances starting a `pg_dump` at exactly 02:00:00 is a self-inflicted load
spike on your own disk.

### Copying a backup off the host

A backup on the same disk is not a backup. Push it somewhere else:

```bash
# Encrypt before it leaves the host.
gpg --symmetric --cipher-algo AES256 /opt/aether/backups/aether-backup-*.tar.gz
scp /opt/aether/backups/aether-backup-*.tar.gz.gpg backup-host:/srv/aether/
```

---

## Restoring

```bash
aether restore /opt/aether/backups/aether-backup-20260917-101500.tar.gz
```

To undo the last `aether update`, you do not need the filename — the update records it:

```bash
aether rollback                  # uses backups/last-update.json
aether rollback <archive>        # or an archive you name
```

### What it does, in order

1. **Verifies the checksum.** A missing `.sha256` is a failure, not a warning: `tar -tzf` cannot
   detect a truncated archive. To force it anyway, `AETHER_ALLOW_UNVERIFIED=true aether restore …`.
2. **Asks for confirmation** — this replaces the database, the data directory, and the Caddyfile.
   (`AETHER_YES=true` skips the prompt.)
3. **Stops the backend and the local host agent**, so nothing is writing while its data is replaced
   and the journal does not fill with reconnection noise.
4. **Drops and recreates the database**, then reloads the dump.
5. **Clears and repopulates the data directory.** Clearing first matters: without it, files deleted
   since the backup was taken would survive as stale leftovers, making the restore a merge rather
   than a rollback. Files are then `chown`ed back to the app uid (`1001`), because a root container
   wrote them.
6. **Preserves your current `.env`** and leaves it in place — see below.
7. **Restores the local agent's identity** (`local-agent/agent.env`, `local-agent.json`) so the agent
   matches the `host_agents` rows the restored database contains.
8. **Rebuilds the frontend bundle if it is missing.** The bundle is not in the archive — it is a
   build artifact of a particular commit, and restoring an old one next to a possibly-newer backend
   is version skew. It is rebuilt at the current commit instead. A restore onto a host that lost
   `/opt/aether/static` otherwise comes back with a working API and no UI, which the `/health` probe
   cannot see.
9. **Starts the stack, waits for the backend to report healthy *with a reachable database*, then
   waits for the host agent to reconnect.** If either fails, the restore **exits non-zero** and says
   so. A restore that leaves the instance unhealthy has not restored the instance.

`instance.json` and `install.state` are deliberately *not* restored: they describe the installation
that is running now, and the archive's copies are older.

### Your `.env` is not overwritten

The archived `.env` is **not** applied. It carries the secrets that were current when the backup was
taken, and applying it would either change `JWT_SECRET` (invalidating every live session) or change
`ENCRYPTION_KEY` (making stored ciphertext permanently unreadable). Restoring data is the goal;
restoring old secrets is a separate, more dangerous operation.

The current `.env` is copied aside as `.env.pre-restore-<timestamp>` so you can compare them. The
Caddyfile *is* restored, since it carries no secrets and may legitimately need rolling back.

### Restoring onto a fresh host

```bash
# 1. Install Aether normally — this creates the layout, the volumes, and the agent.
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash

# 2. Copy the archive over and restore it.
aether restore /root/aether-backup-20260917-101500.tar.gz
```

You do **not** need to recreate the `.env` by hand. Restoring onto a new host keeps the new host's
secrets, which is correct: existing users will need to sign in again, but their data comes back
intact.

---

## Verifying a backup without restoring it

```bash
# Is the archive complete?
sha256sum -c /opt/aether/backups/aether-backup-20260917-101500.tar.gz.sha256

# What is in it?
tar -tzf /opt/aether/backups/aether-backup-20260917-101500.tar.gz

# Does the dump look sane? (Count the tables; it should not be near zero.)
tar -xzOf /opt/aether/backups/aether-backup-20260917-101500.tar.gz \
    aether-backup-20260917-101500/database.sql.gz | gunzip | grep -c 'CREATE TABLE'
```

Test a restore on a throwaway host before you need one. An untested backup is a hope, not a plan.

---

## Upgrade safety

`aether update` takes a full backup **before** it touches anything, into the same `backups/`
directory, and records it in `backups/last-update.json` along with the commit it started from. If the
new version fails its health check the update rolls back by itself — `git reset --hard` plus
`aether restore` of that archive — and only reports failure if the rollback failed too:

```bash
aether rollback        # the archive the last update recorded
```

---

## Troubleshooting

**`No checksum file at …sha256, so the archive cannot be verified`**
Either the `.sha256` was deleted, or the archive predates checksum support. Re-create the backup if
the source is still up; otherwise restore with `AETHER_ALLOW_UNVERIFIED=true` and accept that a
truncated archive will not be detected.

**`pg_dump failed`**
The `postgres` container is not running or not healthy. Check `aether status` and `aether logs
postgres`. This is a hard failure by design — the alternative is an archive with no database in it.

**`Checksum mismatch`**
The archive is corrupt or was modified in transit. Do not override this. Restore an older archive.

**`Restore failed: the host agent did not reconnect`**
The restored database contains a different `host_agents` row than the agent on this host presents.
Either the archive came from a different installation, or `metadata/agent.env` was not in it. Pair
the host again from Settings → Host agents, or restore an archive that contains the matching agent.

**Restore succeeds but the backend never becomes healthy**
Usually a schema-version mismatch: an old dump against a newer backend. The backend's migration
runner is forward-only, so it will not downgrade. Restore the archive that matches the version you
are running, or re-run `aether update` afterwards to bring the schema forward.
