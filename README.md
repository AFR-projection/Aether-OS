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

**Host agents** — a separate agent process manages each host. The installer pairs one on the machine
it installs on, running as an unprivileged `aether-agent` user in a hardened systemd unit; further
hosts are paired from the Settings → Host agents screen. One backend can manage several hosts.

**Accounts** — first-run bootstrap, JWT access/refresh tokens, revocable sessions, password change,
and four roles (`owner`, `admin`, `operator`, `viewer`) enforced server-side on every request.

**Audit trail** — sensitive operations are recorded and readable from the Security Center app.

### Applications

| App             | What it does                                 |
| --------------- | -------------------------------------------- |
| Files           | File manager over the workspace              |
| Terminal        | Multi-tab real shell                         |
| Code Studio     | Plain-text editor with line numbers and save |
| Task Manager    | Process list, memory use, search filter      |
| System Monitor  | Live CPU / memory / disk graphs              |
| Settings        | Account, sessions, users, host agents, about |
| Security Center | Audit log and session review                 |
| App Catalog     | The registry of installed apps               |

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
and the agent performs the work. That split is what lets one backend manage several machines, and it
is why the backend can run in a container while the agent runs on the host it manages.

| Component        | Stack                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `backend`        | Node 20, Fastify 4, `pg`, `node-pty`, `ws`, JWT, bcryptjs, Zod, Pino      |
| `frontend`       | React 18, Vite 5, TypeScript, TanStack Query, Zustand, xterm.js, Tailwind |
| `host-agent`     | Node 20, `ws`, `node-pty`, Zod, Pino                                      |
| `shared`         | Types, Zod schemas, permissions, constants — imported by all of the above |
| `desktop-client` | Electron wrapper around the same frontend                                 |
| Deployment       | Docker Compose + Caddy, driven by a bash installer in `deploy/`           |

Detail: [Architecture overview](docs/architecture/OVERVIEW.md).

---

## Quick Start

### 🚀 One-Command VPS Installation

Deploy Aether Cloud OS on a fresh Ubuntu 22.04/24.04 VPS in minutes:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash
```

**What happens:**

1. **Pre-flight checks** — OS detection, resource validation
2. **Domain setup** — Interactive prompt with DNS validation (or skip for IP-only HTTP mode)
3. **Master account** — Create administrator credentials during installation
4. **Dependencies** — Installs Docker, Docker Compose, and required packages
5. **Deployment** — Generates secrets, configures services, builds images
6. **Auto-configuration** — Pairs local Host Agent, sets up systemd, runs health checks

**After installation completes, you'll see:**

```
═══════════════════════════════════════════════════════════════
  ✓ AETHER CLOUD OS INSTALLED SUCCESSFULLY
═══════════════════════════════════════════════════════════════

  Domain:           aether.example.com (or http://<vps-ip>)

  MASTER ACCOUNT
  ─────────────────────────────────────────────────────────────
  Username:         admin
  Password:         <your-secure-password>

  ⚠  IMPORTANT: Save these credentials securely!

  NEXT STEPS
  ─────────────────────────────────────────────────────────────
  1. Open your browser: https://aether.example.com
  2. Login with the master account credentials above
  3. Start managing your cloud infrastructure
```

#### With Custom Domain (HTTPS)

If you have a domain, **configure DNS first**:

1. Create an **A record** pointing to your VPS IP
2. Wait for DNS propagation (5-30 minutes)
3. Verify: `dig yourdomain.com +short`

Then run the installer — it will validate DNS automatically:

```bash
curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/scripts/deploy/setup.sh | bash
```

The installer prompts you interactively for:

- Domain (validates DNS points to VPS)
- Admin email (for Let's Encrypt certificate notices)
- Master username (alphanumeric, 3-32 chars)
- Master password (min 8 chars, must have letter + number)

#### Non-Interactive Mode

For automation or CI/CD:

```bash
bash scripts/deploy/setup.sh --yes --domain aether.example.com --email admin@example.com
```

**Note:** Non-interactive mode skips master account creation. You'll use the bootstrap token flow in
the UI instead.

---

### 💻 Local Development

```bash
git clone https://github.com/AFR-projection/Aether-OS.git
cd Aether-cloud-os
pnpm install
docker compose up -d          # PostgreSQL + Redis
cp .env.example .env          # Set JWT_SECRET and other secrets
pnpm dev
```

Open <http://localhost:5173> and create the owner account (no bootstrap token needed in dev mode).

Full guide: [Development](docs/getting-started/DEVELOPMENT.md)

---

### 🛠️ Management Commands

After installation, use the `aether` CLI:

```bash
aether status          # System health, services, agent status
aether logs            # View service logs (backend, postgres, redis, caddy)
aether update          # Update to latest version from GitHub
aether backup          # Create full backup (database + data)
aether restore         # Restore from backup
aether restart         # Restart all services
aether doctor          # Diagnose problems with fix commands
```

Full reference: [Deployment Guide](docs/operations/DEPLOYMENT.md) aether doctor # every problem with
a cause and the command that fixes it aether logs backend # follow one service: redis | postgres |
backend | caddy aether backup # database + data + config + metadata, checksummed aether restore
<archive> # verified, then it must come back healthy or it fails aether rollback # undo the last
update, using the archive it recorded aether update # git-based: backup → rebuild → migrate →
restart → health, auto-rollback aether repair # recreate only what is unhealthy, and re-pair the
host agent aether version # app version, branch, exact commit aether uninstall # keeps your data;
--purge removes it after confirming

```

`aether update` compares the installed checkout with `origin/main`, prints `Already up to date` when
there is nothing to apply, and rolls back to the previous commit and pre-update archive if the
health check fails. It never pushes.

### Add another host

Settings → **Host agents** → **Pair agent**. The dialog shows a one-time token and the exact command
to run on the target machine. Guide: [Host agents](docs/operations/HOST-AGENTS.md).

---

## Documentation

Everything lives under [`docs/`](docs/README.md). Quick index:

| Section                                  | For                                                  |
| ---------------------------------------- | ---------------------------------------------------- |
| [Getting started](docs/getting-started/) | Local development, first run, contributing           |
| [Architecture](docs/architecture/)       | How the pieces fit and why                           |
| [Operations](docs/operations/)           | Install, host agents, backup, upgrade, troubleshoot  |
| [Security](docs/security/)               | Threat model, auth, sandboxing, what is not covered  |
| [Reference](docs/reference/)             | HTTP API, WebSocket protocol, config, code standards |
| [Status](docs/status/)                   | Known limitations, decision log, release audit       |

---

## Requirements

| Target       | Needs                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend host | **Ubuntu 22.04 / 24.04 LTS, x86_64**, with systemd. The installer blocks on anything else. 2 vCPU, 4 GB RAM, 40 GB disk recommended. Hard floor: 1 core and 20 GB disk. RAM below ~2 GB only warns and suggests adding swap — it does not block. |
| Managed host | Linux with systemd, Node 20 (the installer provides it), Python 3 + a C++ toolchain for `node-pty`                                                                             |
| Browser      | Chrome/Edge 90+, Firefox 88+, Safari 14+                                                                                                                                       |
| Development  | Node 20+, pnpm 8+, Docker                                                                                                                                                      |

Not Ubuntu, or not x86_64? The installer will refuse. You can still deploy by hand — the stack is
plain Docker Compose and the host agent builds anywhere Node 20 does — but you are off the tested
path and the installer's checks will not help you.

---

## License

Not yet chosen — see [`package.json`](package.json) (`"license": "PENDING"`).
```
