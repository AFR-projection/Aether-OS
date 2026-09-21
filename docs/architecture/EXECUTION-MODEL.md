# Execution model

How Aether starts a process on a host, what environment that process gets, and what happens to a
shell when the browser, the backend, or the machine goes away. This is the single definition; the
code points back to it, and a test enforces the one rule it turns on.

## The one rule

**Every shell Aether spawns constructs its argument vector and its environment through
`packages/shared/src/execution-environment.ts` — `buildShellArgv` and `buildShellEnvironment` — and
nowhere else builds a child environment by hand.** A test in the host agent's suite checks every
`pty.spawn` call site against this, so a future spawn path that improvises its own environment fails
CI rather than quietly diverging. That is what makes "one model" a fact about the code and not a note
in a document.

The two current consumers:

- **The interactive Terminal.** `packages/host-agent/src/capabilities/terminal.ts` spawns a real PTY
  on the managed host; `packages/backend/src/services/terminal.service.ts` spawns one inside the
  backend container for a workspace-scope terminal. They are two spawn sites, one model.
- **Code Studio's Run panel** goes through the same agent `terminal.create` with a `command`, so it
  inherits the model for free — a "run" sees exactly what the user's shell sees.

Three consumers do not exist yet — an application runtime, background processes, and an AI-agent
runtime (roadmap P3/P10). The deliverable for them today is this rule plus the enforcement test:
when they are built, they use these builders or they do not merge.

## Why a login shell

A shell started without `-l` is an *interactive, non-login* shell. It reads `~/.bashrc` and nothing
else — not `/etc/profile`, not `~/.profile`. On Ubuntu and Debian the line that puts `~/.local/bin`
on `PATH` lives in `~/.profile`, which **only a login shell reads**.

The user-visible consequence was precise: `curl -fsSL https://claude.ai/install.sh | bash` reports
`Location: ~/.local/bin/claude`, and a subsequent `claude` does not resolve — not because of
anything Claude-specific, but because no login shell ever ran. The same was true of `pipx`,
`cargo install`, `nvm`, `pyenv`, `rustup`, `go install`, and any custom installer targeting
`~/.local/bin`.

`buildShellArgv` adds `-l` unconditionally — for an interactive terminal and for a one-command run
alike — so the host's own `/etc/profile` → `~/.profile` → `~/.bashrc` chain runs. A tool becomes
available for exactly the reason it becomes available over SSH.

**Why `PATH` is not extended by hand.** `buildShellEnvironment` sets `PATH` to the stock system path
(`SYSTEM_PATH`) and stops there. A login shell then re-derives and extends `PATH` from the profile
chain. We deliberately do **not** append `$HOME/.local/bin` (or nvm, cargo, pyenv…) ourselves:
hardcoding a directory would paper over a host whose profile chain is broken, diverge from what the
same user sees over SSH, and need editing again for every tool that picks a different directory. No
tool is named anywhere in the environment module.

This is not hypothetical. On Ubuntu **as root**, the profile chain does not add `~/.local/bin` at all:
the Debian `~/.profile` skeleton adds it only for a regular user whose `~/.profile` exists, and
`/root` typically has no such line — so a tool installed by `curl … | bash` into `/root/.local/bin`
resolves in **neither** an Aether terminal **nor** a plain SSH login. The remedy is a host-
configuration one, applied where the profile chain lives rather than in the spawn code: the installer
(`deploy/scripts/setup-host.sh`, `write_login_profile`) drops `/etc/profile.d/aether-local-bin.sh`, a
tool-agnostic, existence-guarded rule that prepends `$HOME/.local/bin` to `PATH` for every login
shell — the same mechanism by which the host already gets `/snap/bin` from `apps-bin-path.sh`. The
spawn code still names no tool and adds nothing to `PATH` by hand; the login shell picks the rule up
because it sources `/etc/profile.d/*.sh`, so a tool becomes reachable for exactly the reason it is
reachable over SSH.

The cost of `-l` on the command path is real and accepted: profile scripts run before each run, so a
run is marginally slower and profile output can appear in the run's terminal. That is the honest
price of the run seeing the user's environment.

## The environment is an allowlist, never `process.env`

`buildShellEnvironment` never inherits the spawning process's environment wholesale. It builds:

- the **identity** (`USER`, `LOGNAME`, `HOME`, `SHELL`) from the host, see below;
- `PWD` set to the directory the process actually starts in, so `pwd` agrees with the prompt from
  the first line;
- `TERM`/`COLORTERM` for the emulator;
- `PATH` = `SYSTEM_PATH`;
- and **only** the names in `INHERITED_ENV_NAMES` (`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`) copied from
  the ambient environment, each only when it has a value.

This is a security boundary, not a tidiness preference. The agent process holds
`AETHER_PAIRING_TOKEN`; the backend holds `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`. A shell
runs as the same user and could read any inherited variable with a single `env`. Because the
environment is built by name, none of those cross into the shell — and the right fix for missing
tools was never "inherit more", it was "let the host's login files, which know nothing about
`AETHER_*`, build the environment". Adding a name to `INHERITED_ENV_NAMES` is a security decision;
anything matching `AETHER_*`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, or `*_KEY` must never be added.

The unit test plants a secret-shaped value in the ambient environment and asserts it is absent from
the result; the integration test spawns a real shell with `AETHER_PAIRING_TOKEN` in the ambient
environment and asserts `env` inside it does not print the value.

## Whose environment: passwd, not `$HOME`

`resolveHostIdentity` in `@aether/shared/node` is the authoritative source for `USER`, `HOME`, and
the login-shell preference. It reads `os.userInfo()`, which calls `getpwuid_r` — the **passwd
database** for the process's effective uid — and falls back to the ambient `USER`/`HOME`/`SHELL` (and
finally to `aether` / `/` / `/bin/sh`) only for a uid with no passwd entry, as can happen for a bare
container uid.

It is deliberately node-only and exposed **only** through the `@aether/shared/node` subpath export,
never re-exported from the package root, so `node:os` can never enter the frontend bundle. The pure
policy (`execution-environment.ts`) and the node-only identity resolver (`host-identity.ts`) are
split for exactly this reason.

Why passwd beats `$HOME`: under systemd the unit sets no `HOME`, so the daemon's `HOME` may be
absent. The old fallback then landed on the working directory, which in the default full-host install
(workspace root `/`) put a shell in `/` instead of `/root`. Resolving from passwd makes the code
independent of the unit's environment and repairs existing installs without a reinstall — systemd's
`SetLoginEnvironment=` only exists in ≥ 255, and Ubuntu 22.04 ships 249.

The reported `SHELL` is the shell actually spawned, not the passwd preference. The two can differ:
`resolveShell` only spawns a shell on `TERMINAL_ALLOWED_SHELLS`, so a service account's
`/usr/sbin/nologin` preference is refused and the allowlist default is used instead.

## Reattach and session lifecycle

### Discovery after a browser refresh (scenario 2, solved)

The window manager holds no persistence, so a refresh empties it. But a refresh does **not** restart
the backend: its `hostSessions` map and the agent's PTYs both survive. The honest recovery is
discovery, not a saved layout. On desktop load, `useTerminalRecovery` calls
`GET /api/terminal/sessions`, and for each session the server reports as `running` or `starting` it
reopens a terminal window bound to that session's `{ sessionId, scope, agentId }`. `TerminalApp`
already reattaches when opened with a `sessionId` prop — it attaches to the existing PTY and replays
its scrollback — so nothing new is invented on the attach path.

What it does not do: it does not resurrect an `exited`/`killed` session (that would put a window on
screen for a process that is gone), it does not restore window geometry (the desktop never persisted
geometry for any app), and it runs once onto an empty desktop so it can never double-open a shell.

Reattach preserves the **process** and up to 256 KB of scrollback. It does not reproduce exact screen
state for a full-screen program; xterm.js rebuilds the screen from scrollback.

### Honest lifecycle

The backend reconciles every host session against the agent that owns it before it answers a list or
a get. The agent is the authority on a PTY it owns: a session it still reports is mirrored (status
and exit code included), a session it no longer knows is dropped. An exited session is retained for
30 seconds with `status: 'exited'`, `pid: null`, and its final scrollback, so a client can still read
how it ended — but it is rendered as **ended**, never as running. **Aether never reports a session as
alive when the underlying PTY is dead.**

### Why backend-restart adoption is not faked

A host session's owner is a **backend** user id. The agent, though, tracks a single `ownerUserId` per
connection, and multiple backend users can hold sessions on one agent. So after a backend restart,
blindly adopting everything the agent's `terminal.list` returns would attribute every session to
whoever asked first — a cross-user leak. Rather than fake ownership, a backend-only restart is left
as an honest gap: the sessions are gone from the backend's view even though the shells live on the
agent. Closing this cleanly needs per-session ownership carried across the agent protocol, which is
scheduled with the session-broker work below, not improvised here.

## PTY survival across agent restart and reboot (scenarios 5 and 6): assessment

A PTY is owned by the process that opened its master fd — the agent. When the agent restarts, the
master closes, the kernel sends `SIGHUP` to the foreground process group, and the shell dies. No
bookkeeping on the backend changes that. On a host reboot everything dies, as on any machine.

Survival requires the PTY to be owned by something that outlives the agent. Two designs:

- **tmux/screen as the PTY owner.** Works, but adds a host dependency, changes `TERM` and terminal
  semantics for every session, and brings tmux's own attach behaviour into what the user sees.
  Defensible as an **opt-in** backend; wrong as a silent default.
- **A dedicated session-broker daemon** owning PTYs over a unix socket, with the agent as a client.
  Architecturally the cleanest, and the eventual choice — but it is a new long-lived privileged
  component: a socket that hands out shells needs its own authentication, authorization, unit,
  lifecycle, and review, on a host sized at 1 vCPU.

**Neither is built now.** Building the broker before the roadmap's P1 execution/supervision primitive
would mean building it twice; it is scheduled as its own item. Until then Aether ships the honest
behaviour — a session that is gone is reported gone, never alive — and this assessment. Scenarios 5
and 6 are **not** claimed as solved.

## The six-scenario matrix

| # | Scenario | Verdict |
| --- | --- | --- |
| 1 | Terminal reconnect | **Solved** — same PTY, reattached; environment unchanged |
| 2 | Browser refresh | **Solved** — sessions discovered and rebound; the shell survives (backend not restarted) |
| 3 | New terminal session | **Solved** — a fresh login shell; profile chain runs, `~/.local/bin` on `PATH` |
| 4 | Logout / login | **Solved** — sessions end on logout by design; the next session is correct |
| 5 | Aether restart | **Partial, reported as such** — agent restart kills the PTYs (reported gone); backend-only restart is an honest gap, not faked adoption |
| 6 | Host reboot | **Not solved, documented** — a PTY dies on reboot as on any machine; reported gone, never alive. A new session afterwards is correct |

## Tests

- **Unit** (`packages/shared/src/execution-environment.test.ts`,
  `packages/shared/src/host-identity.test.ts`): the argv login flag, `PWD` = the requested `cwd`,
  `PATH` = `SYSTEM_PATH` with no tool-specific entry, the allowlist proof (a secret-shaped key is
  absent, `LANG`/`TZ` carried), and passwd resolution with its fallbacks.
- **Integration, real PTY** (`packages/host-agent/src/capabilities/terminal.test.ts`, runs on CI
  `ubuntu-latest`, skips on a host with no `node-pty` or POSIX shell): the profile-chain case (a tool
  in a `.profile`-added directory resolves — the user's case in miniature; **fails on the pre-change
  code**), the negative case (no `-l` → not found), the secret non-leak, the command path, and
  session-lifecycle honesty (an exited session reports `exited`/`null` pid, never `running`).
- **VPS E2E** (`deploy/tests/host-environment.sh`): portion A drives a real login shell on the host
  and asserts the profile chain, the regression, and the secret non-leak; portion B drives the real
  API for the session lifecycle and the refresh-discovery listing, skipping (counted) without
  credentials. It carries this matrix and exits `77` only when nothing could run.
