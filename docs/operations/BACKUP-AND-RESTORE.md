# Backup and restore

Aether keeps all of its state in two places: the **PostgreSQL database** and the **data volumes**
(workspace + uploads). Both live inside Docker named volumes, so they survive `docker compose down`
— but they do not survive a lost host, and `docker compose down -v` deletes them.

`aether backup` produces a single archive containing everything needed to rebuild an instance.

---

## What is in a backup

| Component       | Source                              | Why                                                   |
| --------------- | ----------------------------------- | ----------------------------------------------------- |
| Database        | `pg_dump` of the `postgres` service  | Users, sessions, audit log, settings, agent registry   |
| Workspace       | `workspace_data` volume              | Every file users created through the Files app         |
| Uploads         | `uploads_data` volume                | Uploaded files                                        |
| Configuration   | `.env`, `docker-compose.yml`, Caddyfile | Secrets and deployment shape                       |

**Redis is not backed up, deliberately.** It holds WebSocket tickets and rate-limit counters, all of
which are reconstructible. Losing Redis loses nothing durable.

### The archive is a secret

The archive contains `.env`, which holds `JWT_SECRET` and `ENCRYPTION_KEY`. Anyone with the archive
can mint valid tokens for your instance and decrypt data written by it. Treat a backup like the
private key it contains: encrypt it before it leaves the host, and never commit one.

---

## Taking a backup

```bash
sudo aether backup
```

Writes:

```
/opt/aether/backups/aether-backup-20260917-101500.tar.gz
/opt/aether/backups/aether-backup-20260917-101500.tar.gz.sha256
```

The checksum is what lets a restore tell a truncated archive from a complete one — `tar -tzf` only
proves the gzip stream is intact, not that the archive finished being written.

Every step is mandatory. If `pg_dump` fails, or the dump comes out empty, or the volume archive is
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
sudo aether restore /opt/aether/backups/aether-backup-20260917-101500.tar.gz
```

or, equivalently:

```bash
sudo aether rollback /opt/aether/backups/aether-backup-20260917-101500.tar.gz
```

`rollback` and `restore` are the same operation. The name differs because `aether update` tells you
to roll back when a health check fails.

### What it does, in order

1. **Verifies the checksum**, if a `.sha256` sits beside the archive. A mismatch aborts.
2. **Asks for confirmation** — this replaces the database, workspace, and uploads. (`AETHER_YES=true`
   skips the prompt.)
3. **Stops the backend**, so nothing is writing while its data is replaced.
4. **Drops and recreates the database**, then reloads the dump.
5. **Clears and repopulates the volumes.** Clearing first matters: without it, files deleted since
   the backup was taken would survive as stale leftovers, making the restore a merge rather than a
   rollback. Files are then `chown`ed back to the app uid (`1001`), because a root container wrote
   them.
6. **Preserves your current `.env`** and leaves it in place — see below.
7. **Starts the stack** and waits for the backend to report healthy.

### Your `.env` is not overwritten

The archived `.env` is **not** applied. It carries the secrets that were current when the backup was
taken, and applying it would either change `JWT_SECRET` (invalidating every live session) or change
`ENCRYPTION_KEY` (making stored ciphertext permanently unreadable). Restoring data is the goal;
restoring old secrets is a separate, more dangerous operation.

The current `.env` is copied aside as `.env.pre-restore-<timestamp>` so you can compare them. The
Caddyfile *is* restored, since it carries no secrets and may legitimately need rolling back.

### Restoring onto a fresh host

```bash
# 1. Install Aether normally — this creates the volumes and the layout.
sudo bash install.sh

# 2. Copy the archive over and restore it.
sudo aether restore /root/aether-backup-20260917-101500.tar.gz
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

`aether update` takes a full backup **before** it touches anything, into the same
`backups/` directory. If the new version fails its health check, the update says so and points at
that archive. That is the intended rollback path:

```bash
sudo aether rollback /opt/aether/backups/aether-backup-<the one update just made>.tar.gz
```

---

## Troubleshooting

**`Could not find the Docker volume ending in '_workspace_data'`**
The stack has never been started, or the volumes were removed with `down -v`. Bring it up with
`aether start` first.

**`pg_dump failed`**
The `postgres` container is not running or not healthy. Check `aether status` and `aether logs
postgres`. Note that this is a hard failure by design — the alternative is an archive with no
database in it.

**`Checksum mismatch`**
The archive is corrupt or was modified in transit. Do not override this. Restore an older archive.

**Restore succeeds but the backend never becomes healthy**
Usually a schema-version mismatch: an old dump against a newer backend. The backend's migration
runner is forward-only, so it will not downgrade. Restore the archive that matches the version you
are running, or re-run `aether update` afterwards to bring the schema forward.
