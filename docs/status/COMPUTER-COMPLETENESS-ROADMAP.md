# Computer completeness roadmap

**Date:** 2026-09-21 · **Branch:** main @ `c8d4dba` · **Scope:** the whole repository

This is the audit the project's own rule requires before large work: what is genuinely
implemented, what stops at the UI, and what is missing for Aether to be a *computer* rather than a
management panel over one. Every claim below is cited to a file and line, and was read rather than
inferred.

It supersedes nothing. [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) is still the per-feature honest
list; this document is the layer above it — the completeness question.

---

## Part 1 — What is real

The foundation is not a mock, and that is the single most important finding. Verified end to end:

| Area | Evidence |
| --- | --- |
| Host agent RPC | 22 methods, all real syscalls — `packages/host-agent/src/protocol.ts:25`, dispatched in `router.ts:164`. Validated at the agent, not trusted from the backend. |
| Terminal | Real `node-pty`, shell allowlist (`capabilities/terminal.ts:239`), per-user caps, scrollback, idle timeout, signals. |
| Filesystem | Real `fs`, canonicalised and symlink-checked **twice** — backend (`backend/src/security/workspace.ts`) and agent (`host-agent/src/security/workspace.ts:59,93`). Defence in depth, deliberately. |
| Processes | Real `/proc` walk (`capabilities/processes.ts:143`). `cpuPercent` reports `0` rather than a fabricated value (`processes.ts:97`). |
| Ports listing | Real `/proc/net/tcp{,6}` with an inode→pid join across the fd table (`capabilities/ports.ts:169`). Genuinely deep work. |
| Port preview | Real TCP tunnel through the agent and a hand-written HTTP relay that passes a WebSocket upgrade through (`backend/src/routes/ports.routes.ts:200-441`). Not an iframe. |
| System metrics | Real `/proc/stat`, `/proc/meminfo`, `statfs`, `/etc/os-release` (`capabilities/system.ts`). |
| Auth | JWT + per-request session revocation, bcrypt cost 12, refresh rotation with reuse detection (`services/auth.service.ts`). |
| Agent pairing | SHA-256-hashed token, timing-safe compare, soft revoke (`services/agent-pairing.service.ts:27,171`). |
| WebSocket tickets | 256-bit, 30 s, single-use, session-bound (`security/ws-ticket.ts`). |
| Installer / update / rollback | Real stage checkpoints, real migration gate, health check that confirms the agent reconnected **on both sides**, rollback to a recorded revision plus a pre-update archive (`deploy/scripts/update.sh:364,399,462`). |
| Honesty | One `TODO`-shaped string in the entire source tree, and it is a `mktemp` template (`scripts/deploy/setup.sh:112`). No mock data, no fake progress, no fabricated health. |

That is a real product. The roadmap below is about the layer above it.

---

## Part 2 — The gap

### 2.1 The capability ceiling (`P1`)

The agent exposes 22 verbs. A computer needs verbs that do not exist:

**Absent from the agent protocol entirely:** container management (docker/compose), service
management (systemd), package installation, user and group management, log reading (journald),
firewall, network configuration, domain/DNS, archive and extract (tar/zip), content search (grep),
file copy (`files.rename` moves, it does not copy), `chmod`/`chown`, git, cron/scheduling,
reboot/shutdown, detached process spawn, environment-variable management.

One partial exception: `terminal.create` accepts a `command`
(`host-agent/src/protocol.ts:162`), which is how Code Studio's Run panel executes a file
(`apps/code-studio/RunPanel.tsx`). But it is a PTY, it is session-scoped, and it consumes a terminal
session slot — it is not a general "run this and give me the exit code" primitive.

**The consequence is not that Aether is blocked.** A root shell on the host means every one of
those operations is already reachable by typing it. The consequence is that none of them is
*abstracted*: no app can offer "restart nginx", no permission model can distinguish "reads files"
from "restarts the database", and a user who does not know `systemctl` cannot manage a service.

### 2.2 Desktop parity (`P2`)

Measured against §3 of the brief. Verified absent:

- **Resize is one corner.** `Window.tsx:152` — bottom-right only. No edges, no other corners.
- **No snapping of any kind.** No snap zones, no keyboard snap, no drag-to-edge.
- **No fullscreen**, only maximize (`desktop.store.ts:274`).
- **No workspaces / virtual desktops.**
- **No drag and drop anywhere.** Zero hits for `onDragStart`/`draggable`/`dataTransfer` in the
  frontend.
- **No OS clipboard.** `navigator.clipboard` appears once, to copy a value in Settings
  (`settings/SettingsApp.tsx:1083`). There is no shared clipboard, and Files has no
  copy/cut/paste.
- **Effectively no keyboard shortcuts.** Ctrl+S in Code Studio (`code-studio/CodeStudioApp.tsx:268`)
  and Escape handlers. No Alt+Tab, no window shortcuts, no shortcut registry.
- **Context menus only in Files** (`files/FilesApp.tsx:592,633`). None on the desktop, taskbar,
  icons, or window chrome.
- **System tray is decorative.** The Wi-Fi, volume and battery glyphs in all three shells
  (`desktop/Shell.tsx:119,171,303`) have no handler.
- **No notification system at all.** Zero hits for `notification`/`toast` in the frontend.
- **No window persistence across reload.** `desktop.store.ts` has no persistence; only auth
  (`lib/api-client.ts:68`) and theme (`stores/theme.store.ts:29`) survive. Window layout is lost.
- **No file associations, no Open With, no recent files.** The launcher searches app names only
  (`desktop/Launcher.tsx:32`).

What *is* real, and non-trivial: the three-way theme split is structural, not recolouring — shell
kind, control side, control style, title alignment, radii and titlebar height differ per theme as
data (`lib/themes.ts:53`), and three distinct shells are rendered from it (`desktop/Shell.tsx`).
Window drag, focus/z-order, cascade, minimise, maximise and clamping are properly built
(`desktop.store.ts`).

### 2.3 Application platform (`P3`)

The registry is a static array of React components (`apps/registry.ts:66`). `AppDefinition` carries
`id`, `name`, `description`, `icon`, `defaultSize`, `singleton`, `requiredPermission`, `hidden`,
`component` — no version, runtime, entrypoint, manifest, storage, ports, environment, healthcheck,
or lifecycle.

**The App Catalog is a pin/unpin preference screen** (`apps/app-catalog/AppCatalogApp.tsx`). It
writes `desktop.pinnedApps.<username>` into the `settings` table and toggles desktop visibility.
Nothing is installed, launched, stopped or updated. There is no app store.

There is no dynamic loading, no third-party sandbox, no manifest format, and no way to run a web
app, a container, or an AI agent as an app.

### 2.4 Networking, ports and ingress (`P4`) — the largest architectural limit

- Caddy serves **exactly one site**: `{$AETHER_DOMAIN}` (`deploy/Caddyfile:19`). The admin API is
  off (`Caddyfile:15`), so there is no dynamic reconfiguration path.
- **No per-application domain or subdomain routing exists.** No path routing either.
- Public surface is `80`, `443`, and a **fixed contiguous range `8443-8452`**
  (`docker-compose.prod.yml:135-145`) — ten preview slots. A preview is served on one of those
  addresses, which is why a previewed app is at `/` of its own origin
  (`backend/src/security/preview.ts`). The design reasoning is sound; the ceiling is ten, and the
  address is a slot rather than the app's own identity.
- The published range is a **literal** in the compose file, rewritten by the installer
  (`deploy/lib/deploy.sh:295`). Changing `AETHER_PREVIEW_PORT_START/COUNT` without reinstalling
  desynchronises `.env` from the published range — acknowledged in the compose comment.
- **No port allocator.** No allocation table, no persistence, no reconciliation of recorded state
  against real listening sockets, and no classification into SYSTEM / AETHER / USER / DOCKER /
  EXTERNAL / UNKNOWN. The Ports app *observes* listeners with pid, process and a loopback flag —
  real, and good — but observation is not management.
- **What is already correct:** PostgreSQL and Redis are on an `internal: true` network with no
  published ports (`docker-compose.prod.yml:170-175`), and the installer verifies 5432/6379/3000 are
  not publicly listening. The internal-network-first requirement is met.

### 2.5 Security (`P6`)

Strong, with named gaps. Self-documented: refresh token in `localStorage` (the largest single
weakness), no 2FA, per-process rate limiting without Redis, `ENCRYPTION_KEY` required but read by no
code, unencrypted backups containing `.env`.

Not self-documented:

- **Permissions are per-user-role, not per-app or per-agent.** Fourteen static strings
  (`shared/src/constants.ts:13`) mapped to four roles. There is no way to grant a *specific app or
  agent* `filesystem.read` but not `terminal.execute`, and no approval workflow for dangerous
  operations. §33 of the brief has no implementation.
- **The default install is a root agent over the whole filesystem.**
  `deploy/lib/local-agent.sh:344` sets `agent_service_user="root"` and `agent_workspace="/"` as the
  default. Combined with a root PTY, the GUI user is root on the VPS by default. That is a
  deliberate, advertised choice — but it means "host scope" in Files and an unconfined shell are the
  default posture, and the confined variant is the opt-in one. The brief's §22 wants elevation and
  approval for dangerous operations; today there is no elevation concept because nothing is
  un-elevated.
- **No CSRF token.** Mitigated by origin-allowlisted CORS plus bearer tokens rather than cookies,
  but there is no explicit CSRF story for the day the refresh token moves to a cookie.
- **Audit log is not tamper-evident** and has no retention policy.

### 2.6 Reliability and recovery (`P7`)

Correct where it exists: `restart: unless-stopped` on all four services, `Restart=always` on the
agent unit, agent reconnect with backoff, unit enabled at boot.

Browser-refresh reattach is **done**: the desktop now discovers live sessions via
`GET /api/terminal/sessions` on load (`desktop/useTerminalRecovery.ts`) and rebinds terminal windows
to them, and the terminal environment is a real login shell built from one shared model — see
[EXECUTION-MODEL.md](../architecture/EXECUTION-MODEL.md) and the note in Part 4's P0/P7. Remaining
gap: a PTY still lives in its owner's memory, so an agent restart or host reboot ends the shell. That
is reported honestly (a dead session is never shown as alive) but not survived; making a shell
outlive its owner needs a session broker, folded into the P7 item below. Single backend replica;
sticky sessions required beyond one.

### 2.7 Observability (`P8`)

Present: `/health`, `/api/health`, `/api/version`, structured pino logs with rotation, the audit
trail and Security Center, and a real System Monitor.

Absent: metrics export, any in-desktop log viewer (container logs and `journalctl` are not reachable
from the GUI), an event stream, and — necessarily — any application-level observability, because
there are no applications.

### 2.8 Testing (`P9`)

23 test files, all in `backend`, `host-agent` and `shared`. **Zero frontend tests** —
`packages/frontend` has no `*.test.tsx` and its `test` script is `vitest run --passWithNoTests`. The
`vps-harness.sh` end-to-end suite exists but is documented as never having been run end to end
(`KNOWN-LIMITATIONS.md:275`).

### 2.9 Performance (`P9`)

Backend is capped at 0.5 vCPU / 1 GB. Monaco is correctly split into its own lazy chunk
(`code-studio/MonacoPane.tsx`). One real risk: `ports.list` walks every `/proc/<pid>/fd` on every
call (`capabilities/ports.ts:182-225`) with no cache, so a Ports window polling on a host with many
processes is the most expensive thing the agent does.

---

## Part 3 — Documentation that contradicts the code

The project's own rule is that nothing may be faked. Five claims currently are:

| Document | Claim | Reality |
| --- | --- | --- |
| `README.md:21` | "notification centre" | No notification system exists (zero hits). |
| `README.md:22` | "session persistence across reloads" | Only auth and theme persist; window layout is lost. |
| `README.md:50` | Code Studio is "plain-text editor with line numbers and save" | It is Monaco with tabs, a file tree and syntax highlighting. |
| `README.md:54` | App Catalog is "the registry of installed apps" | It is a pin/unpin preference screen. |
| `KNOWN-LIMITATIONS.md:8` | Code Studio "has no syntax highlighting" | Monaco is a frontend dependency and in use. |
| `KNOWN-LIMITATIONS.md:153` | Process signalling "defaults to `false`" | Default is `true` (`backend/src/config.ts:131`, `host-agent/src/config.ts:50`). |

Fixing these is a prerequisite, not housekeeping: a roadmap that leaves a false capability claim in
the README is already violating §40.

---

## Part 4 — Roadmap

Priority order is the brief's. **P0 first, and each slice finished to the definition of done in §38
before the next is started.**

### P0 — Core correctness

1. Correct the six documentation claims above.
2. Reattach UI for terminal sessions: surface `GET /api/terminal/sessions` so a reload does not
   orphan live shells. Small, high-value, closes a real hole.
3. Persist window layout (per user, server-side in the existing `settings` table, matching how
   `pinnedApps` is stored) and restore it on load.
4. Reconcile the preview port range: derive the published range and the firewall rule from one
   source so `.env` and the compose literal cannot drift.

### P1 — Real host integration

5. Extend the agent protocol with the missing verbs, in this order: **one-shot command execution
   with exit code** (the primitive everything else is built on), then service status/control,
   then container status/control, then logs, then installed-package query.
6. Each new verb gets a Zod schema in `shared`, a capability module in the agent, a service and
   route in the backend, a permission string, and an audit event — the existing pattern, followed
   exactly rather than shortcut.
7. Bounded scope for new verbs, matching the existing reasoning: read operations open by default,
   mutating operations behind a permission and off by default where a mistake is unrecoverable.

### P2 — Desktop computer parity

8. Resize from all eight edges and corners.
9. Window snapping: drag-to-edge zones plus keyboard equivalents; produce snap layouts per theme.
10. A shortcut registry, then bindings: window management, app switching, launcher, close.
11. Drag and drop: desktop icons, taskbar reordering, file drag onto app windows.
12. A shared clipboard across apps, and copy/cut/paste in Files.
13. A notification service with a real notification centre, wired to real events (agent
    disconnect, deployment finished, long command exited) — never to invented ones.
14. Context menus on desktop, icon, window and taskbar.
15. File associations and Open With, backed by a real MIME map.
16. Multiple workspaces.
17. Make the tray glyphs real or remove them.
18. Frontend test infrastructure — required *before* the above, not after. Parity work with no
    tests on a window manager is how a desktop becomes subtly broken.

### P3 — Application runtime

19. An app manifest format: name, version, runtime, entrypoint, permissions, storage, network,
    ports, environment, dependencies, healthcheck, resources, domains, lifecycle.
20. An app supervisor in the backend: install produces a real runtime, start/stop/restart act on a
    real process, and logs come from that process.
21. Runtimes in order of value: **web app** (a URL served through the ingress — cheap, immediate),
    then **container** (Compose or Docker API through the agent), then native Aether apps.
22. App Store UI on top of (19)–(21) — and only then. A store before a supervisor is a database
    row pretending to be an install.

### P4 — Networking, ports, domains

23. A port and network manager that records allocation, classifies owners, reconciles recorded
    state against real listening sockets, and survives restart — the brief's §17 and §18.
24. Dynamic Caddy configuration for per-app routing. The admin API is currently off; this is the
    decision that unlocks subdomains and, with them, real application identity.
25. Subdomain-per-app routing, replacing the fixed ten-slot preview pool as the primary path, while
    keeping `IP:port` and the existing preview range as the escape hatch.

### P5 — Storage

26. Separate Aether-internal storage, user filesystem, application storage and cache, with an
    ownership model rather than one directory.
27. Quotas, and safe deletion.

### P6 — Security

28. Move the refresh token to an httpOnly cookie with a CSRF token. Documented as the correct fix
    and the largest weakness; it should not stay unscheduled.
29. A real permission model for apps and agents — the brief's §33 — replacing role-only grants.
30. An elevation and approval path for dangerous operations, which requires (29) and is what makes
    the default root agent defensible.
31. TOTP.
32. Encrypt backups, or make it a first-class documented step rather than a warning.

### P7 — Reliability

33. **Session broker for PTY survival across agent restart and host reboot.** Browser-refresh
    reattach and honest lifecycle are **done** (`useTerminalRecovery`, the reconcile-before-list
    path, and [EXECUTION-MODEL.md](../architecture/EXECUTION-MODEL.md)); what remains is a shell
    outliving its owner. A PTY dies when the process that opened it restarts, so survival needs a
    broker — tmux/screen as an opt-in owner, or a dedicated PTY-owning daemon — plus per-session
    ownership carried across the agent protocol (which is also what makes a backend-only restart
    re-adopt sessions safely instead of leaking them between users). The trade-offs are assessed in
    EXECUTION-MODEL.md; this belongs on top of the P1 execution primitive so it is not built twice.
34. Health and readiness that report the *running* revision, and make `aether update` prove git
    revision == deployment revision == running revision, as the brief's §30 requires. Today it
    proves source revision and health, not the running build.
35. Reboot and recovery tests in the harness, actually executed.

### P8 — Observability

36. Metrics export.
37. A log viewer in the desktop, reading real container and journald output through the agent.

### P9 — Testing

38. Run `deploy/tests/vps-harness.sh` end to end on a real host and publish the result. Until that
    happens, "the installer, the CLI, and the update path are exercised by it" remains a claim
    about a test that has never run.

### P10 — Ecosystem

39. A general agent-integration capability: an agent runs as an app, is granted permissions
    through (29), and reaches the filesystem, terminal, containers and deployment through the same
    tool layer as everything else — with no agent hardcoded, per the brief's §32.

### P11 — Visual polish

40. Wallpapers as real assets rather than gradients, per-theme icon sets, motion, and the
    remaining craft. Last, and only after the layers beneath are honest.

---

## Part 5 — The one architectural decision to take first

Almost everything in P1–P4 depends on one thing: **a general execution and supervision primitive in
the agent** — run this, own it, report its exit code and its logs, and let it be governed by a
permission. Container and service management, the app supervisor, deployment, and the AI-agent tool
layer all reduce to it.

It does not exist today. `terminal.create` is a PTY for a human, not a supervised unit for a
system. Building the app platform or the port manager before it would mean writing each of them
against a different, improvised mechanism — which is exactly the "temporary patch on top of an old
problem" the brief forbids.

So: **P0 first, then the execution primitive, then P1 outward from it.**
