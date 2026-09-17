# Aether Cloud OS

**Your cloud. Your desktop. Anywhere.**

A browser-based desktop environment for a VPS or any Linux host you own. Open a URL and you get a
window manager, a file manager, a real terminal, a task manager, and system monitoring — talking to
the actual machine, not a simulation.

> **Status: pre-1.0.** The core works end to end and is deployed by the installer in this repo. It
> has not been through an external security audit. Read
> [Known limitations](docs/status/KNOWN-LIMITATIONS.md) before exposing an instance to the public
> internet.

---

## What actually works

Everything below is implemented and covered by the test suite. If it is not listed here, assume it
is not built — see [Known limitations](docs/status/KNOWN-LIMITATIONS.md).

**Desktop shell** — window manager (drag, resize, minimize, maximise, snap), taskbar and launcher,
notification centre, light/dark themes, session persistence across reloads.

**Terminal** — a real PTY (`node-pty`) running `bash`/`sh` on the host, streamed over a WebSocket
with a short-lived ticket rather than the access token in the URL. Multiple tabs.

**Files** — browse, read, write, rename, delete, upload, download, and search the workspace tree.
Every path is confined to `AETHER_WORKSPACE_ROOT`; nothing outside it is reachable.

**System** — CPU, memory, disk, and load from the host's own `/proc`, plus a process list and an
opt-in signal capability.

**Host agents** — a separate agent process manages each host. The installer pairs one on the
machine it installs on, running as an unprivileged `aether-agent` user in a hardened systemd unit;
further hosts are paired from the Settings → Host agents screen. One backend can manage several
hosts.

**Accounts** — first-run bootstrap, JWT access/refresh tokens, revocable sessions, password change,
and four roles (`owner`, `admin`, `operator`, `viewer`) enforced server-side on every request.

**Audit trail** — sensitive operations are recorded and readable from the Security Center app.

### Applications

| App               | What it does                                                |
| ----------------- | ----------------------------------------------------------- |
| Files             | File manager over the workspace                             |
| Terminal          | Multi-tab real shell                                        |
| Code Studio       | Plain-text editor with line numbers and save                |
| Task Manager      | Process list, memory use, search filter                     |
| System Monitor    | Live CPU / memory / disk graphs                             |
| Settings          | Account, sessions, users, host agents, about                |
| Security Center   | Audit log and session review                                |
| App Catalog       | The registry of installed apps                              |

---

## Architecture

```
        Browser  ──────────────┐
                               │  HTTPS + WSS
   Electron desktop client ────┤
                               ▼
                    ┌─────────────────────┐
                    │   Backend (Fastify) │──── PostgreSQL (state)
                    │   API + WebSocket   │──── Redis (optional cache)
                    └──────────┬──────────┘
                               │  WSS /ws/agent
                               ▼
                    ┌─────────────────────┐
                    │   Host Agent        │
                    │  PTY · files · proc │
                    └──────────┬──────────┘
                               ▼
                         Managed Linux host
```

The backend never touches the managed host directly. It talks to a **host agent** over a WebSocket,
and the agent performs the work. That split is what lets one backend manage several machines, and
it is why the backend can run in a container while the agent runs on the host it manages.

| Component         | Stack                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `backend`         | Node 20, Fastify 4, `pg`, `node-pty`, `ws`, JWT, bcryptjs, Zod, Pino      |
| `frontend`        | React 18, Vite 5, TypeScript, TanStack Query, Zustand, xterm.js, Tailwind |
| `host-agent`      | Node 20, `ws`, `node-pty`, Zod, Pino                                      |
| `shared`          | Types, Zod schemas, permissions, constants — imported by all of the above |
| `desktop-client`  | Electron wrapper around the same frontend                                |
| Deployment        | Docker Compose + Caddy, driven by a bash installer in `deploy/`           |

Detail: [Architecture overview](docs/architecture/OVERVIEW.md).

---

## Quick start

### Run it locally

```bash
git clone <your-fork> && cd Aether-cloud-os
pnpm install
docker compose up -d          # PostgreSQL + Redis
cp .env.example .env          # then set JWT_SECRET
pnpm dev
```

The UI is at <http://localhost:5173>. On first load it asks you to create the owner account — in
development `AETHER_BOOTSTRAP_TOKEN` is unset, so no token is needed.

Full instructions: [Development](docs/getting-started/DEVELOPMENT.md).

### Install on a VPS

On a fresh Ubuntu 22.04/24.04 host, one command — no Docker, clone, `.env`, or migration step first:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash
```

It re-runs itself under `sudo` if you are not root, so the command above is the whole thing. With a
domain pointing at the host:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash -s -- --domain aether.example.com --email you@example.com
```

The installer checks the platform, installs Docker, generates every secret, writes a hardened
`.env`, brings up the stack behind Caddy (with automatic HTTPS when you supply a domain), installs
an `aether` management CLI and a systemd unit, and runs a post-install check that no internal port
is exposed. It also installs a **local host agent** — paired to its own backend automatically — so
the machine it installs on is manageable out of the box, with no extra pairing step.

Then create the owner account at the URL it prints. Guide:
[Deployment](docs/operations/DEPLOYMENT.md).

### Manage it

```bash
aether status          # docker, containers, HTTP, database, cache, agent, disk, memory, TLS, commit
aether doctor          # every problem with a cause and the command that fixes it
aether logs backend    # follow one service: redis | postgres | backend | caddy
aether backup          # database + data + config + metadata, checksummed
aether restore <archive>   # verified, then it must come back healthy or it fails
aether rollback        # undo the last update, using the archive it recorded
aether update          # git-based: backup → rebuild → migrate → restart → health, auto-rollback
aether repair          # recreate only what is unhealthy, and re-pair the host agent
aether version         # app version, branch, exact commit
aether uninstall       # keeps your data; --purge removes it after confirming
```

`aether update` compares the installed checkout with `origin/main`, prints `Already up to date` when
there is nothing to apply, and rolls back to the previous commit and pre-update archive if the health
check fails. It never pushes.

### Add another host

Settings → **Host agents** → **Pair agent**. The dialog shows a one-time token and the exact command
to run on the target machine. Guide: [Host agents](docs/operations/HOST-AGENTS.md).

---

## Documentation

Everything lives under [`docs/`](docs/README.md). Quick index:

| Section                                     | For                                                   |
| ------------------------------------------- | ----------------------------------------------------- |
| [Getting started](docs/getting-started/)    | Local development, first run, contributing            |
| [Architecture](docs/architecture/)          | How the pieces fit and why                            |
| [Operations](docs/operations/)              | Install, host agents, backup, upgrade, troubleshoot   |
| [Security](docs/security/)                  | Threat model, auth, sandboxing, what is not covered   |
| [Reference](docs/reference/)                | HTTP API, WebSocket protocol, config, code standards  |
| [Status](docs/status/)                      | Known limitations, decision log, release audit        |

---

## Requirements

| Target        | Needs                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| Backend host  | **Ubuntu 22.04 / 24.04 LTS, x86_64**, with systemd. The installer blocks on anything else. 2 vCPU, 4 GB RAM, 20 GB disk recommended (1 core / 2 GB / 20 GB is the hard floor). |
| Managed host  | Linux with systemd, Node 20 (the installer provides it), Python 3 + a C++ toolchain for `node-pty` |
| Browser       | Chrome/Edge 90+, Firefox 88+, Safari 14+                                  |
| Development   | Node 20+, pnpm 8+, Docker                                                   |

Not Ubuntu, or not x86_64? The installer will refuse. You can still deploy by hand — the stack is
plain Docker Compose and the host agent builds anywhere Node 20 does — but you are off the tested
path and the installer's checks will not help you.

---

## License

Not yet chosen — see [`package.json`](package.json) (`"license": "PENDING"`).
