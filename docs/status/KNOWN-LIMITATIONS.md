# Known limitations

**Read this before deploying to the public internet.**

This is the honest list of what Aether does _not_ do. Several entries are deliberate design choices
with a stated trade-off; others are work not yet done. Each says which it is, so you can tell
"unfinished" from "won't fix".

The codebase references this file from six places; the corresponding entries are marked with **→
referenced by code**.

---

## Security-relevant

### 1. The refresh token lives in `localStorage`

**→ referenced by `packages/frontend/src/lib/api-client.ts`**

The access token is held in memory only and never touches storage. The **refresh token is persisted
in `localStorage`**, because otherwise every page reload would sign the user out.

_Impact:_ any XSS on the app's origin can read the refresh token and mint access tokens indefinitely
— until the session is revoked server-side.

_Mitigations in place:_ a strict Content-Security-Policy with no `unsafe-inline` for scripts, no
`dangerouslySetInnerHTML` anywhere in the frontend package, and server-side session revocation that
makes a stolen token revocable.

_The correct fix_ is an httpOnly cookie plus a CSRF token. That is a backend change (token issuance
and refresh would move to a cookie) and is not scheduled. **This is the largest single weakness in
the project.**

### 2. Session revocation takes up to five seconds to take effect

**→ referenced by `packages/backend/src/middleware/auth.ts`**

Every authenticated request performs a session lookup so a revoked session stops working
immediately, rather than only when its JWT expires. That lookup is cached for a few seconds.

_Impact:_ after "revoke this session" or "revoke all sessions", the revoked token keeps working for
up to ~5 seconds. Not a meaningful window for an attacker who just lost access, but it is not
instant, and "log out everywhere" should not be described as instantaneous.

_Why:_ without the cache, every API call becomes a database round-trip.

### 3. Rate limiting is per-process unless Redis is configured

**→ see [CONFIGURATION.md](../reference/CONFIGURATION.md#redis_url)**

WebSocket tickets and rate-limit counters live in the cache. With the default in-process cache, they
are per-backend-process.

_Impact:_ running more than one backend replica without `REDIS_URL` means each replica enforces its
own rate limits and cannot redeem another replica's WebSocket ticket. The backend detects this and
logs loudly, but it does **not** refuse to start.

_Rule:_ more than one replica requires `REDIS_URL`. One replica is fine without it.

### 4. No two-factor authentication

There is no TOTP, no WebAuthn, no recovery codes. A password is the only factor.

### 5. No external security audit

This project has not been penetration-tested or audited. The threat model in
[SECURITY-MODEL.md](../security/SECURITY-MODEL.md) is the authors' own reasoning, not a third-party
assessment.

---

## Functional gaps

### 6. Per-process CPU usage is always reported as `0`

**→ referenced by `packages/backend/src/services/system.service.ts` and
`packages/host-agent/src/capabilities/processes.ts`**

Reading `/proc/<pid>/stat` gives a process's _cumulative_ CPU time. A percentage requires two
samples separated in time. Aether currently takes one sample and reports `0` rather than inventing a
number.

_Impact:_ the Task Manager's CPU column is permanently empty. Memory, state, PID, parent, and
command are all real. System-wide CPU (from `/proc/stat` deltas) _is_ implemented; only the
per-process column is affected.

_Fix:_ keep the previous sample per PID and compute the delta. Not scheduled.

### 7. File search matches names, not contents

**→ referenced by `packages/backend/src/services/files.service.ts`**

`GET /api/files/search` does a case-insensitive substring match over entry _names_. There is no
content indexing and no full-text search.

_Impact:_ searching for a phrase inside a file finds nothing. There is no grep-like capability in
the UI.

### 8. Code Studio cannot save a file that was truncated for display

**→ referenced by `packages/frontend/src/apps/code-studio/CodeStudioApp.tsx`**

Code Studio is a Monaco editor with tabs, a file tree, and syntax highlighting (Monaco is lazy-loaded
as its own chunk, `apps/code-studio/MonacoPane.tsx`). It is not a plain editor. Debugging, a language
server, and multi-cursor/refactor tooling are not wired up — it is an editor, not a full IDE.

_Related safety rule:_ a file the backend truncated for display can never be written back — saving
would silently discard everything past the truncation point. Saving is disabled in that case.

### 9. Applications are compiled in — there is no third-party app installation

The app registry (`packages/frontend/src/apps/registry.ts`) is a static array of React components
built into the bundle. The "App Catalog" app lists that registry; it does not download anything.

_Impact:_ there is no app store, no plugin system, and no sandbox for untrusted third-party code.
Adding an app means adding a component and a registry entry. Any future runtime for third-party code
would need its own sandbox design, which does not exist yet.

### 10. No cloud storage, file sync, or multi-device sync

There is no S3/MinIO client, no object storage, and no sync engine. Uploads are written to the
backend's local `UPLOAD_DIR`.

_Impact:_ files are not shared between instances, and there is no conflict resolution because there
is no replication. Multiple _users_ of one instance share the workspace; multiple _instances_ do not
share anything.

### 11. No AI assistant

No agent, no tool-calling layer, no model integration.

### 12. No offline mode / PWA

There is no service worker and no web app manifest. The frontend requires a live connection.

### 13. Host agent is Linux-only

`packages/host-agent` uses `/proc`, `systemd`, and POSIX PTYs. There is no Windows or macOS agent.

---

## Operational

### 14. Windows and macOS agents, and ARM host images

Only relevant to the _agent_ (the backend and frontend are platform-independent). Deploying the
agent on a non-`x86_64` host requires building `node-pty` from source; the installer installs a
compiler toolchain, so this works, but the build is slow.

### 15. Process signalling is on by default, with hard guards

`AETHER_PROCESS_SIGNAL_ENABLED` (backend) and `PROCESS_SIGNAL_ENABLED` (agent) both default to `true`
(`packages/backend/src/config.ts:131`, `packages/host-agent/src/config.ts:50`), and the installer
writes `PROCESS_SIGNAL_ENABLED=true` into `agent.env` so the Task Manager can end processes. Ending a
process is the one API action that can take a host down — a careless kill of `sshd` locks the
operator out — so it stays behind the `process:manage` permission, and both sides refuse to signal
PID 1, the agent itself, or any of its own ancestors. Set the variable to `false` to make the process
table read-only on a host.

### 16. Backups are operator-driven, and unencrypted

The `aether backup` command produces a complete archive (database, persistent data, configuration,
and the host agent's identity) with a SHA-256 checksum, and the script applies a 30-day retention
policy. Restore **requires** that checksum — an archive without one is refused unless you set
`AETHER_ALLOW_UNVERIFIED=true`, because restoring a truncated dump over a healthy database is worse
than not restoring. What `aether backup` does **not** do is run itself: there is no scheduler built
in, so a nightly backup means one cron line the operator adds — and no built-in scheduling means
there is no monitoring of whether backups are actually succeeding. A failed backup only surfaces
when someone looks.

The archive is also **plaintext**, not encrypted: it contains `.env`, so it holds every secret.
Storing it off-host means encrypting it yourself. See
[BACKUP-AND-RESTORE.md](../operations/BACKUP-AND-RESTORE.md).

### 17. Restore verifies health, and fails the command if the instance is not healthy

`aether restore` stops the stack, restores, starts it again, waits for the database check inside the
container, and then requires the local host agent to reconnect to the backend. If any of that fails
it exits non-zero and says so — a restore that "succeeded" but left a broken instance is worse than
a loud failure. There is no automatic rollback _within_ restore: the previous state is gone once the
data directory is replaced, so the safety net is the archive you still have, not the running
instance. Take a fresh `aether backup` before restoring an old archive.

### 18. "Host Agent: connected" is a per-replica claim

The local agent connects to one backend process. With `REDIS_URL` set and multiple backend replicas,
`aether status` asks whichever replica answers its health probe, and the "agent connected" line is
proved from _that_ replica's logs. An agent that is connected to a different replica can therefore
read as not connected. The install is one replica by default; this only matters if you scale the
backend, in which case verify with `aether logs backend | grep "agent connected"` on the replica you
care about. (Related: #19.)

### 18b. A terminal PTY does not survive its owner restarting, and reattach is process-level

**→ see [EXECUTION-MODEL.md](../architecture/EXECUTION-MODEL.md)**

A shell's PTY is owned by the process that opened it — the host agent (or the backend, for a
workspace terminal). A **browser refresh** now recovers cleanly: the backend was not restarted, the
shells are still there, and the desktop rediscovers them via `GET /api/terminal/sessions` and rebinds
(scenario 2). But:

- **Agent restart or host reboot ends the shells.** The kernel sends `SIGHUP` when the master fd
  closes; the shell dies, as it would on any machine. Aether reports such a session as **gone, never
  as alive** — it does not fake survival. Making a shell outlive its owner needs a session broker
  (tmux, or a dedicated PTY-owning daemon); the trade-offs are assessed in EXECUTION-MODEL.md and the
  broker is scheduled as its own roadmap item, not built yet (scenarios 5 and 6).
- **A backend-only restart is an honest gap.** The agent tracks one owner per connection while
  multiple backend users can hold sessions on one agent, so adopting the agent's session list blindly
  would leak one user's shell to another. Rather than fake ownership, those sessions are reported
  gone after a backend restart even though the shells live on the agent. Closing this needs per-session
  ownership across the agent protocol, scheduled with the broker.
- **Reattach is process-level, not screen-level.** It preserves the process and up to 256 KB of
  scrollback; xterm.js rebuilds the screen from that. Exact screen state for a full-screen program
  (an editor, `top`) is not reproduced.

### 19. No horizontal scaling of the WebSocket layer beyond Redis

Redis makes WebSocket _tickets_ portable between replicas, so a client can connect to any replica.
There is no cross-replica fan-out of terminal output or agent events: a terminal session is owned by
the replica that created it. Sticky sessions at the proxy are therefore still required for terminals
in a multi-replica deployment.

### 20. The local agent is unprivileged; a remote agent is not

The host agent the installer puts on the same machine as the backend runs as `aether-agent` (uid/gid
1001 — the same numeric ids the backend container uses, so both own the workspace), under a hardened
unit: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`,
`RestrictAddressFamilies`, and `ReadWritePaths` limited to the workspace.

Reproduce the remote flow ([HOST-AGENTS.md](../operations/HOST-AGENTS.md)) and you get a **root**
service instead, because managing an arbitrary remote host — installing packages, restarting system
services — needs root. That is the deliberate difference: privilege is granted only where the
operator explicitly opted into running an agent on a host they own, using a token they copied
themselves. Do not read the local agent's hardening as a property of the product as a whole.

### 21. The installer's progress bar is indeterminate more often than it is a percentage

The installer draws a live panel on a terminal. Its bar shows a percentage only where a real
denominator exists: the Nth package of a known list, the Nth probe of a bounded loop, the Nth
container of a fixed set. An image build, an npm install, and a certificate issuance have no such
denominator, and inventing one is the thing the interface was built to avoid — so those show an
indeterminate sweep with the real elapsed time and the command's own last line of output instead. An
operator expecting a smooth 0-100 across a whole install will not get one. That is the design, not a
gap to be closed later.

The rest of the panel's honest limits:

- **Durations are whole seconds**, truncated. A stage that took 900 ms shows `0s`.
- **The layout is clamped to 80 columns**, between 64 and 100. A terminal narrower than 64 columns
  gets a panel wider than the window; nothing reflows below that.
- **The panel repaints at most every 0.4 s while a command runs**, and only when the rendered frame
  actually changed. That is a `tail` of the run log per poll — deliberate, but non-zero, on the 1
  vCPU host this is sized for.
- **An interrupted run leaves not-yet-reached stages as `WAITING`** in `state/ui.state`. Only a
  completed run settles them. `WAITING` is the truth: those stages really were not reached.
- **`state/ui.state` is a report, not a resume mechanism.** Resume still reads `install.state` and
  its six stage keys, exactly as before. Deleting `ui.state` costs nothing but the panel's memory of
  the run.
- **The panel is drawn from a fixed vocabulary of thirteen stages** that does not change with the
  install's actual shape. On a host that already has Docker the dependency work is smaller; the row
  is still there, and it says `SKIPPED` with the reason rather than disappearing.
- **The analysis rows are traded against the terminal's height, not added to it.** The Docker and
  Compose versions need a row, and a 24-row SSH window has none to spare, so they are paid for by
  one of the activity feed's three lines — the feed runs three lines from 30 rows up, two from 22,
  one below that, and the runtime versions are dropped entirely under 22 rows. The deployment
  profile wraps onto a second row only from 26 rows up; in a narrow window below that the last item
  is cut, marked with an ellipsis, and on the values this is written against all four items fit one
  row of an 80-column terminal exactly — with no column to spare, a 64-79 column window will not fit
  them.
- **The profile says nothing about resources when the host meets the recommended minimums.** The
  measured numbers are on the facts row; a standing "meets recommended" would spend the width saying
  nothing. Only the shortfall is named.
- **The activity feed is not a log.** It keeps the last few lines in memory and drops the rest; the
  log file is the record. A line you saw scroll past is in `logs/install.log`, not in the panel.
- **The Unicode decision is made from the locale, not from the terminal.** A UTF-8 locale is taken
  to mean a terminal that renders box-drawing characters and `·`; a serial console or a font-less
  terminal behind a UTF-8 locale still gets them, and the panel would draw mojibake. Nothing in a
  shell script can ask a terminal what its font supports. Where the locale says otherwise, every
  character it draws — borders, status glyphs, separators, the truncation mark — falls back to
  ASCII, and the plain non-TTY path emits none of them at all.

---

## Versioning

`AETHER_VERSION` in `packages/shared/src/constants.ts` is `0.1.0`. There is no schema-version
negotiation between backend and frontend, and no support for a frontend older than the backend it
talks to. Deploy them together.

---

## What has and has not been verified

The installer, the CLI, and the update path are exercised by `deploy/tests/vps-harness.sh`: a full
install, `status`/`doctor`/`version`, a backup and restore round-trip (including a deliberately
corrupted archive that must be refused), an update that must report `Already up to date` on the
second run, a repair, a preview firewall rule that an update restores, an uninstall that preserves
data, and a reinstall-then-purge that must leave no Aether image or network behind.

That harness needs a real host — root, systemd, Docker, Ubuntu — and it exits `77` with
`BLOCKED_BY_ENVIRONMENT` anywhere else rather than reporting a pass. **The harness itself has not
been run end to end.** Individual paths in it have been driven by hand on a real VPS: the one-liner
install onto a host purged to the last image, a purge confirmed down to Docker images and networks,
an authenticated login through the public HTTPS URL, and a host-scope directory listing and file
read that reached `/etc`. Everything that could be checked without Docker was: shell syntax on every
script, and `pnpm typecheck`, `lint`, `test`, and `build` across the workspace. Treat a first
production install as something to watch, and run the harness on a throwaway host before trusting
the update path on one that matters.

The terminal's host-environment behaviour is covered by `deploy/tests/host-environment.sh` and the
`@aether/shared` and host-agent suites. The shared unit tests (argv, environment allowlist, passwd
identity) and the host-agent real-PTY integration tests (the profile-chain / `~/.local/bin` case, its
negative without `-l`, the secret non-leak, and session-lifecycle honesty) run in CI on
`ubuntu-latest`; the integration tests skip on a host with no `node-pty` or POSIX shell, so they have
**not** been executed on Windows. `deploy/tests/host-environment.sh` runs its host-shell portion
anywhere bash and a POSIX shell exist and was run here (six checks pass, proving the login-shell fix
and reproducing the no-`-l` defect); its API portion needs `AETHER_BASE_URL`/`AETHER_USERNAME`/
`AETHER_PASSWORD` and was **skipped**, not run, so the live-instance lifecycle and refresh-discovery
checks are delivered runnable but unexecuted against a real instance. See
[EXECUTION-MODEL.md](../architecture/EXECUTION-MODEL.md).

The installer interface (limitation #21) is covered separately by `deploy/tests/installer-ui.sh`,
which drives the real renderer and the real stage registry against eighteen guarantees — the
plain-path fallbacks, the percentage rules, failure reporting, redaction, the interrupt path, and
the height of the frame on a 24-row terminal. It needs only bash and runs in the `deploy` job of CI.
Four of its cases need a pseudo-terminal and are reported as **skipped** where there is no `script`
command (Git Bash, for one); a skip is never counted as a pass, and the summary prints passed,
failed, and skipped as three separate numbers. What none of that covers is a real terminal on a real
host: the pseudo-terminal cases exercise the detection, not the drawing, so the panel's appearance
on an actual SSH session has not been verified here.
