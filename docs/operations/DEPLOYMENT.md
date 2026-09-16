# Deployment

The installer takes a fresh Ubuntu host to a running, HTTPS-terminated Aether instance with a
management CLI and a systemd unit.

---

## Requirements

**Blocking** — the installer refuses to run without these:

| Requirement | Minimum      |
| ----------- | ------------ |
| OS          | **Ubuntu 22.04 / 24.04 LTS.** Non-Ubuntu is a hard failure. 20.04 and other Ubuntu versions warn and continue. |
| Architecture | **x86_64 / amd64.** Anything else is a hard failure. |
| CPU         | 1 core       |
| RAM         | 2 GB         |
| Disk        | 20 GB        |
| systemd     | **required** — SysVinit, Upstart and OpenRC are not supported |

Between the blocking floor and the recommended figures (2 cores, 4 GB, 20 GB) the installer warns and
asks for confirmation. Preflight also verifies that ports 80 and 443 are free, that the host has
network access, and — when a domain is given — that DNS resolves.

> The installer is Ubuntu-and-x86_64-only, and says so rather than half-working. If you are on
> another distribution the stack is plain Docker Compose and will run; you are simply off the tested
> path, and `install.sh` will not be the thing that sets it up.

`root` (or `sudo`) is required: the installer installs packages, writes `/etc/systemd/system`, and
configures the firewall.

---

## Running it

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh | sudo bash
```

Or from a checkout:

```bash
sudo bash install.sh
```

Piping works because the root `install.sh` is self-contained: outside a repository checkout it
clones the source tree to a temporary directory and re-executes `deploy/lib/install.sh` from there.
A pipe cannot supply the rest of the repository on stdin, so it fetches it over HTTPS instead.

### With a domain (recommended)

```bash
sudo bash install.sh --domain aether.example.com --email you@example.com
```

Caddy obtains and renews a Let's Encrypt certificate automatically. **Point the domain's DNS at
this host before you run it**, or the ACME challenge fails.

### Non-interactive

```bash
sudo bash install.sh --domain aether.example.com --email you@example.com --yes
```

### Check first, change nothing

```bash
sudo bash install.sh --dry-run
```

Runs preflight and reports what it would do, touching nothing.

### Options

| Flag                 | Effect                                                       |
| -------------------- | ------------------------------------------------------------ |
| `--domain DOMAIN`    | Public domain for TLS and routing                             |
| `--email EMAIL`      | Admin email for certificate notices                           |
| `--dir PATH`         | Install directory (default `/opt/aether`)                     |
| `--yes`              | Non-interactive; accept defaults                              |
| `--resume`           | Skip stages already completed in this directory               |
| `--dry-run`          | Validate everything, change nothing                           |
| `--no-https`         | Serve HTTP only (domain still optional)                       |
| `--version`          | Print the installer version                                   |
| `--help`             | Usage                                                         |

Environment overrides: `AETHER_INSTALL_DIR`, `AETHER_DOMAIN`, `AETHER_ADMIN_EMAIL`, `AETHER_YES`,
`AETHER_RESUME`, `AETHER_FORCE_BUILD`.

---

## What it does

Five stages, each checkpointed to `<install>/install.state` so an interrupted run can resume rather
than redo finished work:

| Stage          | Does                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| **preflight**  | Validates OS, architecture, memory, disk, systemd, and that ports 80/443 are free. Blocking, not advisory. |
| **dependencies** | Installs Docker if missing, plus `curl`, `openssl`, and `ufw` if absent.  |
| **configure**  | Generates every secret, writes `.env` (mode 600) and the Caddyfile.          |
| **deploy**     | Copies the source to `<install>/src`, builds the frontend bundle and the backend image, starts the stack. |
| **finalize**   | Hardens permissions, configures the firewall, installs the `aether` CLI and the systemd unit, then runs a post-install security check. |

### Secrets

Generated with `openssl rand` — never `$RANDOM`. Each lives in its own file under
`<install>/secrets` (directory `700`, files `600`). They are never echoed, never written to the
install log, and **never regenerated on an upgrade**: rotating `ENCRYPTION_KEY` would make existing
ciphertext permanently unreadable.

### The firewall

If `ufw` is present, the installer backs up the current rules first, then allows **SSH before**
anything else, then 80 and 443. It never disables the firewall. SSH-first is not a formality — a
rule set that drops an established SSH session locks you out of the host you are installing on.

### The post-install check

The last thing `finalize` does is verify that 5432, 6379, and 3000 are **not** listening on the
host's public interfaces. Only Caddy publishes ports. If any internal port is exposed, the installer
says so.

---

## TLS modes

`write_caddyfile` picks one of three, depending on the flags:

| Situation                  | Caddy site address      | Result                                    |
| -------------------------- | ----------------------- | ----------------------------------------- |
| `--domain`, HTTPS          | `aether.example.com`    | Automatic Let's Encrypt certificate        |
| `--domain --no-https`      | `http://aether.example.com` | Plain HTTP, no certificate             |
| No domain                  | `:80`                   | IP-only access, plain HTTP                 |

The two non-HTTPS modes exist because an empty Caddy site address is invalid and would stop the proxy
starting — so the file is rewritten to `:80` for IP-only rather than left with an unsubstituted
placeholder.

> **HTTP-only means the login credentials and every terminal keystroke travel in the clear.** If the
> instance is reachable from the internet, use a domain.

---

## After it finishes

The installer prints the URL, the install directory, the installation ID, and where the bootstrap
token is. Then:

1. Open the URL and create the owner account — see [FIRST-RUN.md](../getting-started/FIRST-RUN.md).
2. `sudo aether status` to confirm everything is up.

---

## Layout

```
/opt/aether/
  .env                     mode 600 — every secret
  docker-compose.yml       the production stack
  caddy/Caddyfile          reverse proxy config for this instance
  deploy/Caddyfile         symlink → ../caddy/Caddyfile
  packages/frontend/dist   symlink → ../../static
  static/                  the built frontend the backend serves
  src/                     application source
  scripts/                 aether CLI + backup/restore/update/uninstall/setup-host
  lib/                     core.sh, utils.sh — sourced by those scripts
  secrets/                 mode 700
  backups/
  state/
  install.state            stage checkpoints
  instance.json            installation id, version, mode
```

The two symlinks exist because `docker-compose.prod.yml` mounts `./deploy/Caddyfile` and
`./packages/frontend/dist` relative to itself, while the installer keeps those files in `caddy/` and
`static/`.

---

## The `aether` CLI

Installed to `/usr/local/bin/aether`.

| Command                     | Does                                                          |
| --------------------------- | ------------------------------------------------------------- |
| `aether status`             | Container status                                               |
| `aether logs [service]`     | Follow logs (all services, or one)                             |
| `aether start` / `stop` / `restart` | Control the stack                                     |
| `aether update [--check]`   | Update to the latest source — **backs up first**               |
| `aether backup`             | Full backup: database, volumes, configuration                  |
| `aether restore <archive>`  | Restore from a backup archive                                  |
| `aether rollback <archive>` | Same as `restore`; the name `update` points you at             |
| `aether repair`             | Validate the compose file and recreate containers              |
| `aether uninstall [--purge]` | Remove Aether. `--purge` also deletes volumes and backups      |

`update` and `repair` are the two that matter day to day. `update` takes a full backup before it
touches anything, which is what makes `rollback` meaningful — see
[BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md).

---

## Updating

```bash
sudo aether update              # check out the latest source, rebuild, restart
sudo aether update --check      # report whether an update is available, change nothing
sudo aether update --no-pull    # rebuild the current source without fetching
```

It backs up, fast-forwards the source, rebuilds the frontend bundle and the backend image, restarts,
and waits for the backend to report healthy. If the health check fails it tells you the archive to
roll back to.

The update uses `git merge --ff-only`. A deployed instance must never end up in a conflicted merge
state with nobody around to resolve it.

---

## systemd

```
aether.service    Type=oneshot, RemainAfterExit=yes
```

The unit does not supervise the application — it asks Docker to bring the stack up at boot. Each
container's `restart: unless-stopped` handles resilience, so a crashed backend restarts in seconds
without waiting on systemd.

```bash
systemctl status aether
journalctl -u aether -n 50
```

---

## Uninstalling

```bash
sudo aether uninstall           # stop and remove, keep data, backups, and .env
sudo aether uninstall --purge   # remove everything, including volumes and backups
```

The non-purge path preserves `.env`, `secrets/`, `backups/`, and the Docker volumes, and additionally
snapshots them into `backups/uninstall-<timestamp>/`. Reinstalling into the same directory reuses the
existing volumes.

**`--purge` deletes the backups too**, since they live under the install directory. If you want the
data gone but the backups kept, copy `backups/` somewhere else first.

---

## Troubleshooting

**`Ports 80/443 are already in use`**
Something else is serving HTTP — often a preinstalled nginx or apache. Stop it, or install with
`--no-https` and a different port mapping.

**Certificate issuance fails**
DNS for the domain does not yet point at this host, or 80 is not reachable from the internet (ACME
HTTP-01 needs it). Check with `dig +short your-domain`, then retry `sudo aether repair`.

**`docker compose` needs sudo**
The invoking user is not in the `docker` group. The installer's helper scripts handle this via a
`docker_cmd` wrapper that falls back to `sudo`, so this only affects commands you type yourself.

**Install failed partway**
Re-run with `--resume` to skip the stages already marked done. The installer logs to
`/tmp/aether-install.log` and writes an installation ID you can quote in a bug report.

**`aether update` left the stack unhealthy**
It prints the archive it took before starting. Restore it:
`sudo aether rollback /opt/aether/backups/aether-backup-<timestamp>.tar.gz`
