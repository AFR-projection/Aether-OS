# Deployment

The installer takes a fresh Ubuntu host to a running, HTTPS-terminated Aether instance: containers,
a management CLI, a systemd unit, and a host agent paired to its own backend.

---

## Requirements

**Blocking** — the installer refuses to run without these:

| Requirement  | Minimum                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| OS           | **Ubuntu 22.04 / 24.04 LTS.** Non-Ubuntu is a hard failure. 20.04 and other Ubuntu versions warn and continue. |
| Architecture | **x86_64 / amd64.** Anything else is a hard failure.                                                           |
| CPU          | 1 core                                                                                                         |
| RAM          | 2 GB                                                                                                           |
| Disk         | 20 GB                                                                                                          |
| systemd      | **required** — SysVinit, Upstart and OpenRC are not supported                                                  |

Between the blocking floor and the recommended figures (2 cores, 4 GB, 20 GB) the installer warns
and asks for confirmation. Preflight also verifies that ports 80 and 443 are free, that the host has
network access, and — when a domain is given — that DNS resolves.

> The installer is Ubuntu-and-x86_64-only, and says so rather than half-working. If you are on
> another distribution the stack is plain Docker Compose and will run; you are simply off the tested
> path, and this installer will not be the thing that sets it up.

`root` (or `sudo`) is required: the installer installs packages, writes `/etc/systemd/system`,
creates a service user, and configures the firewall. Run the plain one-liner — it elevates itself.

---

## Running it

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash
```

That is the whole installation. Run as a non-root user with `sudo`, the script downloads a copy of
itself and re-launches under `sudo`; a piped script has no path to hand to `sudo`, so it fetches
one. You will be prompted for a sudo password if sudo is configured to ask.

From a checkout, the same entry point works and uses the local source:

```bash
sudo bash scripts/deploy/setup.sh
```

### With a domain (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh \
  | bash -s -- --domain aether.example.com --email you@example.com
```

Caddy obtains and renews a Let's Encrypt certificate automatically. **Point the domain's DNS at this
host before you run it**, or the ACME challenge fails. The install still completes: the health check
reports that HTTP answers but HTTPS does not, and tells you to look at the Caddy log. Fix DNS and
run `sudo aether repair`.

### Non-interactive

```bash
... | bash -s -- --domain aether.example.com --email you@example.com --yes
```

### Check first, change nothing

```bash
... | bash -s -- --dry-run
```

Runs preflight and reports what it would do, touching nothing.

### Options

| Flag              | Effect                                          |
| ----------------- | ----------------------------------------------- |
| `--domain DOMAIN` | Public domain for TLS and routing               |
| `--email EMAIL`   | Admin email for certificate notices             |
| `--dir PATH`      | Install directory (default `/opt/aether`)       |
| `--yes`           | Non-interactive; accept defaults                |
| `--resume`        | Skip stages already completed in this directory |
| `--dry-run`       | Validate everything, change nothing             |
| `--no-https`      | Serve HTTP only (domain still optional)         |
| `--version`       | Print the installer version                     |
| `--help`          | Usage                                           |

Environment overrides: `AETHER_INSTALL_DIR`, `AETHER_DOMAIN`, `AETHER_ADMIN_EMAIL`, `AETHER_YES`,
`AETHER_RESUME`, `AETHER_FORCE_BUILD`, `AETHER_REPO_URL`, `AETHER_SETUP_URL`.

---

## What it does

Seven checkpoints, each recorded in `<install>/install.state`, so an interrupted run resumes rather
than redoing finished work (`--resume`, or the prompt when it finds an existing installation):

| Stage            | Does                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **preflight**    | Validates OS, architecture, memory, disk, systemd, and that ports 80/443 are free. Blocking, not advisory.                                         |
| **dependencies** | Installs Docker if missing, plus `curl`, `openssl`, `git`, and `ufw` if absent.                                                                    |
| **configure**    | Generates every secret, writes `.env` (mode 600), `instance.json`, and the Caddyfile.                                                              |
| **deploy**       | Copies the source (git metadata included) to `<install>/src`, creates `data/`, builds the frontend bundle and the backend image, starts the stack. |
| **finalize**     | Hardens permissions, configures the firewall, installs the `aether` CLI and the `aether.service` unit, and runs a post-install security check.     |
| **local agent**  | Creates the `aether-agent` user, installs the host agent, pairs it with this backend, and verifies the connection **on both sides**.               |
| **summary**      | Prints the URL, the install directory, and the first steps.                                                                                        |

The local-agent stage is mandatory: if the agent does not come up and confirm its handshake, the
install fails rather than reporting success for a host that cannot be managed.

### Secrets

Generated with `openssl rand` — never `$RANDOM`. Each lives in its own file under
`<install>/secrets` (directory `700`, files `600`). They are never echoed, never written to the
install log, and **never regenerated on an upgrade**: rotating `ENCRYPTION_KEY` would make existing
ciphertext permanently unreadable.

### The host agent

The installer generates a UUID and a 256-bit pairing token for the local agent, stores **only the
SHA-256 hash** in `aether.host_agents` (scope `local`, no owner), and hands the plaintext to the
agent through `local-agent/agent.env` (mode 600, owned by the service user). The token is never
printed.

The agent runs as `aether-agent`, with the same numeric uid/gid as the backend container (1001), so
both can write the workspace bind mount. Its unit is hardened:

```
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=<install>/data/workspace
```

"Connected" is only claimed when the agent's journal shows `paired with backend` **and** the backend
log shows `agent connected` for that agent id. One side alone is a half-open socket.

### The firewall

If `ufw` is present, the installer backs up the current rules first, then allows **SSH before**
anything else, then 80 and 443. It never disables the firewall. SSH-first is not a formality — a
rule set that drops an established SSH session locks you out of the host you are installing on.

It then opens the [preview port range](../reference/CONFIGURATION.md#port-previews) as a whole
(`8443:8452` by default). One rule rather than one per preview: `ufw` rules are not something to
write and delete as ports are opened and closed, and it is the backend that decides whether a given
preview address answers, not the firewall.

> **If this instance was installed before previews existed, the range is not open on it.**
> `aether update` republishes the ports in Docker and reconciles this rule in the same run — the
> reconciliation sits before the `Already up to date` check precisely so that an instance with
> nothing to pull still has it applied. If a preview window loads nothing at all, check the rule
> before assuming the project is broken:
>
> ```bash
> sudo ufw status | grep 8443
> ```
>
> Only ever added, never removed: the update does not delete rules and does not enable or disable
> the firewall, so a host that deliberately runs without one stays that way. Set
> `AETHER_PREVIEW_ENABLED=false` to disable previews, and no rule is written for them.

### The post-install check

`finalize` verifies that 5432, 6379, and 3000 are **not** listening on the host's public interfaces.
Only Caddy publishes ports. If any internal port is exposed, the installer says so.

---

## TLS modes

`write_caddyfile` picks one of three, depending on the flags:

| Situation             | Caddy site address          | Result                              |
| --------------------- | --------------------------- | ----------------------------------- |
| `--domain`, HTTPS     | `aether.example.com`        | Automatic Let's Encrypt certificate |
| `--domain --no-https` | `http://aether.example.com` | Plain HTTP, no certificate          |
| No domain             | `:80`                       | IP-only access, plain HTTP          |

The two non-HTTPS modes exist because an empty Caddy site address is invalid and would stop the
proxy starting — so the file is rewritten to `:80` for IP-only rather than left with an
unsubstituted placeholder.

> **HTTP-only means the login credentials and every terminal keystroke travel in the clear.** If the
> instance is reachable from the internet, use a domain.

---

## After it finishes

The installer prints the URL, the install directory, the installation ID, and where the bootstrap
token is. Then:

1. Open the URL and create the owner account — see [FIRST-RUN.md](../getting-started/FIRST-RUN.md).
2. `aether status` to confirm every component is up (including `Host Agent: connected`).
3. `aether doctor` exits non-zero and names a fix for anything that is wrong.

---

## Layout

```
/opt/aether/
  .env                     mode 600 — every secret
  docker-compose.yml       the production stack
  caddy/Caddyfile          reverse proxy config for this instance
  static/                  the built frontend the backend serves
  src/                     application source, a git checkout (updates fast-forward it)
  scripts/                 aether CLI + backup/restore/update/uninstall
  lib/                     core.sh, utils.sh — sourced by those scripts
  data/workspace/          bind-mounted into the backend as /opt/aether/workspace
  data/uploads/            bind-mounted into the backend as /opt/aether/uploads
  local-agent/             the host agent install + agent.env (mode 600)
  local-agent.json         which agent id this installation is paired with
  secrets/                 mode 700
  backups/                 archives + last-update.json
  state/                   update lock + the frontend builder compose file
  install.state            stage checkpoints
  instance.json            installation id, version, mode
```

`docker-compose.yml` is not a verbatim copy of `docker-compose.prod.yml`. That file is written for a
repo-root checkout — build context `.`, Caddyfile under `./deploy`, bundle in
`packages/frontend/dist` — and the installer rewrites those three paths to `./src`, `./caddy`, and
`./static` as it installs it (`deploy/lib/deploy.sh:install_compose_file` asserts all three
substitutions landed and that the result passes `docker compose config`). Editing the paths in the
installed copy will be undone by the next update; edit the source file.

`data/` is a bind mount rather than a named volume on purpose: the host agent runs as a systemd
service on this machine and must see exactly the tree the backend serves, which a named volume is
invisible to. Both the backend container and the agent run as uid/gid 1001.

`static.new` and `static.old` appear briefly during a frontend build. The bundle is built into
`static.new` and swapped in only once it is complete, so a failed build cannot leave a running
instance with no UI.

---

## The `aether` CLI

Installed to `<install>/scripts/aether` and symlinked to `/usr/local/bin/aether`.

| Command                                       | Does                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aether status`                               | Docker daemon, containers, HTTP, database, cache, terminal, host agent, disk, memory, TLS expiry, git commit, app version. Exits non-zero if something is wrong.                                              |
| `aether doctor`                               | One line per check: pass/fail, the cause, and the command that fixes it. Exits non-zero when unhealthy.                                                                                                       |
| `aether logs [service] [-f] [--tail N]`       | Container logs. Services: `redis`, `postgres`, `backend`, `caddy`.                                                                                                                                            |
| `aether start` / `stop` / `restart`           | Control the stack (never the data).                                                                                                                                                                           |
| `aether update [--check] [--no-pull] [--yes]` | Git-based update with automatic rollback. See below.                                                                                                                                                          |
| `aether backup` / `aether backup list`        | Create an archive, or list the ones on disk.                                                                                                                                                                  |
| `aether restore <archive>`                    | Restore database, data and configuration from an archive. Destructive; confirms first.                                                                                                                        |
| `aether rollback [archive]`                   | Restore the archive recorded by the last update, or a named one.                                                                                                                                              |
| `aether repair`                               | Validate the compose file, recreate only unhealthy services, restart the backend so pending migrations apply, and reinstall/re-register the local host agent if it is not connected. Safe to run at any time. |
| `aether version`                              | App version, git branch, full commit, install dir, installation ID.                                                                                                                                           |
| `aether install [--resume]`                   | Re-run the installer against this directory, skipping completed stages.                                                                                                                                       |
| `aether uninstall [--purge]`                  | Remove the runtime. Keeps data unless `--purge`, which asks first.                                                                                                                                            |
| `aether help`                                 | Usage.                                                                                                                                                                                                        |

---

## Updating

```bash
aether update              # fetch, compare, back up, apply, verify
aether update --check      # report whether an update is available; change nothing
aether update --no-pull    # rebuild the current source without fetching
```

`aether update`:

1. Takes the update lock (`<install>/state/update.lock`) and refuses to run a source tree with
   uncommitted changes to tracked files — untracked build leftovers do not count, but a hand-edited
   file does.
2. `git fetch --depth 1 origin main`, then compares `HEAD` with `FETCH_HEAD`. If they match it
   prints `Already up to date (<short>)` and exits 0 without touching anything.
3. Takes a full backup (database, data, configuration, metadata) and records the archive and the
   current commit in `backups/last-update.json`.
4. Fast-forwards with `git merge --ff-only` — a deployed instance must never end up in a conflicted
   merge state with nobody around to resolve it.
5. Rebuilds the frontend bundle and the backend image, runs the migrations explicitly, restarts, and
   waits for health.
6. If anything in step 5 fails: `git reset --hard` to the previous commit, restore the pre-update
   archive, restart, and re-verify. The update then exits non-zero saying which revision it is on.

The update is pull-only. It never pushes to any remote.

### Where the new source comes from

`<install>/src` is a Git checkout, and it is the only thing an update pulls from. Two variables
decide where it fetches:

| Variable               | Default                                           | Notes                                                                   |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `AETHER_REPO_URL`      | `https://github.com/AFR-projection/Aether-OS.git` | Read from the environment of the run. A fork must export it per update. |
| `AETHER_UPDATE_BRANCH` | `main`                                            | The branch the deployment tracks                                        |

An install made from a downloaded tarball — or one whose `.git` was removed by an older version of
this script, which excluded it when re-syncing — has the files but no history. There is nothing to
fetch, so the update would rebuild what is already there and report success. That state is repaired
rather than reported: the tree is cloned fresh from `AETHER_REPO_URL` and swapped in, the replaced
tree is kept beside it as `src.pre-git` until the new one has been built, migrated and
health-checked, and it is put back if the update fails. From then on the instance updates normally.

`aether update --check` reports it without changing anything:
`the next update will adopt main at <short> from <url>`.

### The update engine updates itself

`aether update` runs `<install>/scripts/update.sh`, which is a _copy_ made at install time — not the
file in the source tree. A deployment whose updater is broken therefore cannot be repaired by an
update, because reaching the fix would require the update that does not work. So every update
re-installs the CLI from the tree it just updated, which means a fix to these scripts takes effect
one update after the one that delivers it. The files are replaced by rename rather than by copying
over them, so re-installing `update.sh` cannot disturb the run that is doing it.

That has a consequence worth knowing before it bites. The CLI is re-installed from the tree the
update _fetched_, so a fix that exists only in someone's working tree — not in the branch the
instance fetches from — is replaced by the unfixed version during the very update that used it. The
instance stays healthy and the fix is gone, which looks like the fix never worked. The repair above
puts it back; landing it on the fetched branch is what makes it stay.

### Already-installed instances whose updater predates this

An instance installed before the source tree was kept updatable runs an old `update.sh`, and that
old copy is what `aether update` executes. Refresh the three files the current updater is built
from, once, by hand:

```bash
sudo git clone --depth 1 https://github.com/AFR-projection/Aether-OS.git /tmp/aether-fix
sudo install -m 755 /tmp/aether-fix/deploy/scripts/update.sh /opt/aether/scripts/update.sh
sudo install -m 644 /tmp/aether-fix/deploy/lib/core.sh       /opt/aether/lib/core.sh
sudo install -m 644 /tmp/aether-fix/deploy/lib/utils.sh      /opt/aether/lib/utils.sh
sudo rm -rf /tmp/aether-fix
sudo aether update
```

The update that follows adopts `src` into Git and re-installs the rest of the CLI itself, so this is
the only time it has to be done.

---

## systemd

```
aether.service             Type=oneshot, RemainAfterExit=yes — brings the docker compose stack up at boot
aether-host-agent.service  Type=simple — the local host agent
```

The first unit does not supervise the application — it asks Docker to bring the stack up at boot.
Each container's `restart: unless-stopped` handles resilience, so a crashed backend restarts in
seconds without waiting on systemd.

```bash
systemctl status aether aether-host-agent
journalctl -u aether-host-agent -n 50
```

---

## Uninstalling

```bash
aether uninstall           # remove the runtime; keep data, secrets, and backups
aether uninstall --purge   # remove everything, after confirming
```

Both stop `aether.service` and `aether-host-agent.service`, bring down the compose projects an
install creates, and remove the CLI symlink. Only the two units and those projects are touched —
nothing else on the host.

There are two projects, not one. The stack lives in `docker-compose.yml`; the frontend bundle is
built by `aether-frontend-build` in `state/docker-compose.frontend.yml`, whose project name does not
match the main file's — so it has to be brought down by name as well. Leaving it out stranded its
build image, about 1.1 GB and the largest thing an install creates, after every purge.

The default path additionally snapshots `.env` and `secrets/` into `backups/uninstall-<timestamp>/`
and leaves these in place: `data/`, `backups/`, `secrets/`, `.env`, `instance.json`, `local-agent/`,
`local-agent.json`. Reinstalling into the same directory picks them up again, including the agent's
existing identity.

`--purge` removes the install directory (which contains the backups, since they live there), the
compose volumes, and the images built by both projects. If you want the data gone but the backups
kept, copy `backups/` somewhere else first.

---

## Troubleshooting

**`Ports 80/443 are already in use`** Something else is serving HTTP — often a preinstalled nginx or
apache. Stop it, or install with `--no-https`.

**Certificate issuance fails** DNS for the domain does not yet point at this host, or port 80 is not
reachable from the internet (ACME HTTP-01 needs it). Check with `dig +short your-domain`, then retry
`aether repair`. The install itself distinguishes this case and tells you the stack is up on HTTP.

**`docker compose` needs sudo** The invoking user is not in the `docker` group. The CLI and helper
scripts go through a `docker_cmd` wrapper that falls back to `sudo`, so this only affects commands
you type yourself.

**Install failed partway** Re-run the same one-liner with `--resume` (or `aether install --resume`)
to skip the stages already marked done. The installer logs to `/tmp/aether-install.log` and writes
an installation ID you can quote in a bug report.

**`aether update` left the stack unhealthy** It rolls back by itself and says so. If the automatic
rollback failed too, it prints the archive:
`aether rollback /opt/aether/backups/aether-backup-<timestamp>.tar.gz`

**`aether update` rolled back over an instance that looks healthy** The rollback is decided by the
agent check at the end of the update, which reads the backend's log and the agent's journal. Both
were read with `... | grep -q`, and under `set -o pipefail` — which every deploy script sets —
`grep -q` exiting at the first match kills the process writing into the pipe, so the pipeline
reports failure even though the pattern was found. The bigger the log, the likelier that was, which
is why a long-running instance rolled back and a freshly installed one did not. Fixed by reading
each log into a variable and testing it without a pipeline (`matches` in `deploy/lib/core.sh`). An
instance whose updater predates the fix keeps the behaviour until the fix reaches it: see
[The update engine updates itself](#the-update-engine-updates-itself) for the one-time repair.

**`aether update` says `Already up to date` but nothing changed** The source tree is already at
`origin/main`; the running containers may still be older — a source tree at the right revision is
not proof that the image was rebuilt from it. `aether update --no-pull` rebuilds from the current
source. If it says the source is not a Git checkout instead, see
[Where the new source comes from](#where-the-new-source-comes-from).

**`Host Agent: service up, backend has not acknowledged it`** The agent process is running but the
handshake did not complete. Check both ends: `sudo journalctl -u aether-host-agent -n 50 --no-pager`
and `aether logs --tail 50 backend`.
