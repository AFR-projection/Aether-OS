# P1 — General Execution + Supervision Primitive

**Status:** design proposal, awaiting approval. No code has been written for P1.
**Scope:** one reusable primitive that Terminal, Code Studio, AI agents, App Runtime,
Deployments and background workers all consume, instead of each growing its own spawn path.

```
UI  →  Backend  →  Host Agent  →  Real Linux Process
        (authz)    (supervisor)     (fork/exec, PTY, cgroup)
```

The rule this document exists to enforce: **a feature that stops at the UI is not done, and a
feature that spawns a process without going through this primitive is a defect.**

---

## 1. What already exists, and what is actually missing

The primitive is not a green field. Reading the tree at `8d5659a`:

| Piece | Where | State |
|---|---|---|
| Real PTYs | `packages/host-agent/src/capabilities/terminal.ts` | works, session table is an in-memory `Map` (line 46) |
| Login shell + env allowlist | `packages/shared/src/execution-environment.ts` | works, enforced by a spawn-site test |
| Host identity from passwd | `packages/shared/src/node` → `host-identity.ts` | works |
| Workspace containment | `packages/host-agent/src/security/workspace.ts` | works |
| Backend ↔ agent RPC | `packages/host-agent/src/protocol.ts` — 22 verbs | works |
| Backend session bookkeeping | `packages/backend/src/services/host-terminal.service.ts` | per-process `Map` (line 38) |
| Process listing / signalling | `capabilities/processes.ts` via `processes.*` verbs | works, discovery only |
| Port tunnels | `capabilities/port-tunnel.ts` | works |
| **Unit lifecycle beyond a tty** | — | **absent** |
| **Supervision: restart, limits, backoff** | — | **absent** |
| **Persistent logs** | — | **absent** (256 KB ring, memory only, line 48) |
| **Adoption after backend restart** | — | **absent** — this is the bug the user hit |
| **Per-unit ownership** | — | **absent** — see §4, this is the blocker |
| App Runtime / Deployments / App Store | — | do not exist (`packages/backend/src/services/` has no such file) |

Today the only execution primitive is *"an interactive PTY that dies with the agent"*. Everything
in this document is about making that one case a special case of something general.

---

## 2. The unification: one Execution Unit, many faces

The primitive's noun is the **Execution Unit** — a durable, addressable, owned, supervised record
of one process (or process group) with a lifecycle, a log, and an exit status.

A terminal is a unit whose stdio is a PTY and whose stdin is a person. A Code Studio run is a unit
with piped stdio and a finite command. An AI agent tool call is a unit with a hard timeout and no
tty. A future deployment is a unit with `restart: always`, a memory cap and a declared port. They
are the **same record** with different fields.

```
ExecutionUnit {
  id             uuid            stable, backend-addressable, survives agent restart (P2)
  ownerUserId    string          IMMUTABLE after create — the authorization key
  kind           'tty' | 'command' | 'service' | 'worker'
  agentId        uuid            which host runs it
  spec           { shell? | argv?, cwd, env, tty: boolean, cols?, rows? }
  state          'starting' | 'running' | 'exited' | 'failed' | 'killed' | 'stale'
  pid            number | null
  pgid           number | null   the process group — kills must target this, not pid
  startTicks     number | null   /proc/<pid>/stat field 22, to defeat pid reuse
  exit           { code: number|null, signal: number|null, at: iso } | null
  restart        { policy: 'never'|'on-failure'|'always', maxAttempts, backoffMs }
  limits         { wallClockMs?, memoryMaxBytes?, cpuMaxPercent?, nofile?, pidsMax? }
  log            { mode: 'pty'|'pipe', ringBytes, persisted: boolean }
  createdAt      startedAt      lastActivityAt
}
```

`kind: 'tty'` is a **1:1 map onto today's `TerminalSession`**. That is deliberate: it is what makes
the migration an adapter rather than a rewrite.

### Why one record and not three

Because the three hard problems — *who owns it*, *is it still alive*, *what did it print* — have one
answer each, and every additional spawn path answers them differently. The codebase already
demonstrates the cost: there are **two** terminal implementations (an in-process one in
`agent-gateway.service.ts:198` and the WS-agent one in `capabilities/terminal.ts`) and **two**
`buildChildEnvironment` copies were only just deleted. A third spawn path will diverge again.

---

## 3. Process lifecycle

```
create ──▶ starting ──▶ running ──┬──▶ exited   (voluntary, code 0)
   │                              ├──▶ failed   (nonzero, or signalled)
   │                              └──▶ killed   (we did it, with a reason)
   └──▶ failed (spawn error: ENOENT, EACCES, cwd missing)
                                    stale        (agent unreachable — state unknown)
```

Two properties the current code does not have and must:

- **`stale` is a first-class state.** When the backend cannot reach the owning agent, the honest
  answer is "unknown". Today `reconcileHostSessionsForUser` already refuses to invent an answer
  (`host-terminal.service.ts:159-163` comments say exactly this) — but it leaves the last known
  state *displayed as if current*. Making `stale` explicit is the difference between a documented
  policy and a UI that lies.
- **Liveness is derived from the OS, not from bookkeeping.** `state === 'running'` must be a claim
  about a real process: `kill(pid, 0)` succeeds **and** `/proc/<pid>/stat` field 22 (start time in
  clock ticks) equals the recorded `startTicks`. Pid alone is unsafe — after a reboot a stored pid
  can belong to an unrelated process, and a supervisor that reports it as "your shell" is worse than
  one that reports nothing.

---

## 4. Ownership — the blocker, and the one incompatible change

### The defect, proven from the code

Ownership is currently asserted **once per connection** and never again:

- `packages/host-agent/src/connection.ts:291` — `this.ownerUserId = result.data.ownerUserId` at
  `hello_ack`, bound for the life of the socket.
- `packages/backend/src/ws/agent.ws.ts:63` — the backend computes
  `record.ownerUserId ?? record.agentId` and sends it.
- `packages/backend/src/services/host-terminal.service.ts:74` — the backend records the session
  under `principal.user.id` (`routes/terminal.routes.ts:117`).

For a **personal agent** (`host_agents.owner_user_id` = a user UUID) these agree, and everything
works. For an **instance-scoped local agent** (`owner_user_id IS NULL` — which is the default
full-host install, `deploy/lib/local-agent.sh`) they do **not**:

| | agent's key | backend's record |
|---|---|---|
| personal agent | the user's UUID | the user's UUID — **match** |
| local agent | the agent's UUID (`agent.ws.ts:63`) | the user's UUID — **mismatch** |

Consequence: on a local agent with more than one Aether user, `terminal.list` (whose owner key is
the agent UUID) returns **every session on the host**, to whoever asks. Today that is masked because
nothing adopts — the backend only ever mirrors sessions it created itself
(`host-terminal.service.ts:167-169`) — but **the moment adoption is enabled without fixing this,
it becomes a cross-user session leak.** Adoption and ownership must ship together, or adoption must
be restricted to personal agents. This is the single most important migration note in this document.

### The change

Move the principal **from the handshake to the request**, and record it **per unit, immutably**:

```
units.create { ownerUserId, spec, ... }   → unit.ownerUserId := ownerUserId  (frozen)
units.*      { id, ... }                  → reject unless unit.ownerUserId === asserted owner
units.list   { ownerUserId }              → only that owner's units
```

The handshake `ownerUserId` is retained as the **legacy fallback** for the `terminal.*` verbs during
migration, then retired.

### Trust model — stated plainly

The agent has no user database and never will; it cannot verify who a user is. So the agent
**trusts the backend's assertion** of `ownerUserId`, and the security boundary is:

- **The pairing token** authenticates the *backend to the agent*. It is what stops a random host
  process from speaking the RPC.
- **Backend RBAC** authenticates the *user to the backend*, and is what stops user A acting as
  user B.
- The agent's job is *containment*, not identity: it enforces that a request naming a unit carries
  the unit's recorded owner, and that no request can change a unit's owner.

This is **not a weakening**. The backend can already assert any `ownerUserId` at hello and the agent
already believes it; the change moves the assertion from once-per-connection to once-per-request and
once-per-unit, which is strictly better granularity and fixes the local-agent conflation. It must be
written down, because "the agent trusts the backend" is the kind of sentence that turns into a
vulnerability when it is assumed instead of documented.

---

## 5. Supervisor architecture

**The Host Agent is the supervisor.** It gains a unit registry beside its capability map. It gains
no new privileges. Three things it must have that it does not today:

1. **Crash-loop protection.** A unit with `restart: on-failure` that exits immediately must stop
   after `maxAttempts` within a window, then go `failed` permanently with a reason. Without this, one
   bad spec busy-loops the host. This must be enforced **before** any restart policy is offered —
   offering `always` without it is a loaded gun.
2. **Atomic state.** (P2) A state file written `tmp + fsync + rename`, never partial. A corrupt file
   means start with **no** units and log loudly — never resurrect from a half-written record.
3. **Policy-aware shutdown.** Today `killAllSessions()` runs on graceful shutdown
   (`capabilities/terminal.ts:455`) — correct for terminals, **wrong for services**. Shutdown must
   consult each unit's restart policy: kill `tty`/`command`, preserve `service`/`worker`.

### In-process vs systemd — the biggest judgement call

systemd is better at supervision than anything written here: cgroups, journal, restart-on-failure,
boot-time start, all free and battle-tested. But it cannot host an interactive PTY the way a user
expects, and talking to it needs root plus a D-Bus/systemd-run surface in the agent.

**Recommendation — hybrid, split by kind:**

| Kind | Supervisor | Why |
|---|---|---|
| `tty` | in-process (P1) | needs a PTY and low-latency attach; systemd has no good story |
| `command` | in-process (P1) | short-lived; systemd overhead exceeds benefit |
| `service`, `worker`, persisted units | transient systemd units (P2) | cgroups, boot survival, journal, restart — reused instead of reimplemented |

The alternative (everything in-process, forever) means reimplementing cgroups, a journal, restart
accounting and boot ordering. The alternative (everything in systemd) means losing the terminal.
**Reuse the host's init rather than compete with it** — but only where it is actually better.

---

## 6. PTY model

Unchanged in mechanism, corrected in two places.

- **Spawn stays exactly as it is**: `pty.spawn(shell, buildShellArgv(command), { env: buildShellEnvironment(...) })`
  (`capabilities/terminal.ts:177-183`). The primitive **reuses** `buildShellArgv`,
  `buildShellEnvironment` and `resolveHostIdentity` verbatim. It must not grow a second environment
  or argv model — the spawn-site enforcement test written in the previous change exists precisely to
  fail a future path that improvises one, and it must be extended to cover the unit spawn path.
- **`TERM` semantics get documented.** `DEFAULT_TERM` today; a unit may request a different term
  name, but full-screen fidelity on reattach is still limited to scrollback replay (already in
  `KNOWN-LIMITATIONS.md`, restated here so P1 does not silently claim otherwise).
- **A tty unit is `restart: never` by default.** Restarting a shell a person exited is wrong.

---

## 7. stdout / stderr / log model

Today: one merged stream in a 256 KB in-memory ring, replayed on attach, never persisted
(`terminal.ts:48, 83-95`). That is correct for a terminal — a PTY genuinely merges the streams — and
wrong for everything else: a build log with stderr interleaved is not a log.

**Design:**

- **`tty` units:** ring buffer for attach replay (as today, `MAX_SCROLLBACK_BYTES = 256 KB`), plus an
  optional append-only file under the unit's directory (P2) for durability.
- **`command`/`service`/`worker` units:** stdout and stderr are **separate streams** with independent
  monotonic byte offsets.
- **Read contract reuses `files.readChunk`'s shape** — `{ offset, length }` in, `{ contentBase64,
  size, offset }` out, capped at `LIMITS.HOST_STREAM_CHUNK_BYTES`. This is a **reuse**, and it buys
  the property that matters most: *following the log of a finished run is a plain read*, no live
  subscription required. Code Studio and deployments need exactly that.
- **Every stream is bounded, always.** Disk logs rotate at `LOG_MAX_BYTES` and mark `truncated: true`.
  A log writer that fails (disk full) must **fail closed** — stop writing and mark truncation —
  never crash the agent. An unbounded log is a host-filling bug, not a feature.
- **Backpressure:** a subscriber that cannot keep up is dropped with an explicit
  `{ type: 'overflow', droppedBytes }` frame, not silently truncated. Silent loss in a log stream is
  the kind of lie §40 forbids.

---

## 8. Exit-code model

Today: `TerminalSession.exitCode: number | null`, set from node-pty's `onExit({ exitCode, signal })`
(`terminal.ts:219-222`) — and on Unix a signal-killed process reports **exit code 0**, which reads as
success. The exit *frame* carries the signal but nothing stores it.

**Design:**

```
exit { code: number | null, signal: number | null, normalized: number, at: iso }
```

- `normalized = signal !== null ? 128 + signal : code` — the shell convention, so `kill -TERM`
  reports 143, `kill -KILL` reports 137.
- **A signalled unit is never `exited`-as-success.** It is `failed` (or `killed`, if Aether sent the
  signal) with the signal recorded. `state` is *derived* from `{code, signal, killer}`, never guessed.
- **`killed` carries a reason** — `idle_timeout`, `backend_request`, `signal_SIGTERM`, `user`,
  `policy_exhausted`. Today `killSession(sessionId, reason)` takes one and logs it
  (`terminal.ts:385-409`) but never returns it; the unit record keeps it.

---

## 9. Restart policy, crash recovery, and the survival matrix

| Policy | Default for | Behaviour |
|---|---|---|
| `never` | `tty`, Code Studio runs | no restart, ever |
| `on-failure` | future `worker`, AI tool calls | restart on nonzero / signalled exit, up to `maxAttempts` |
| `always` | future `service` | restart on any exit |

Backoff: `min(backoffMs * 2^attempt, backoffCeiling)`, `maxAttempts` within a window and then
`failed: policy_exhausted` — **and the unit is not restarted again**, even if the policy says
`always`. A crash loop must terminate.

### The three survival questions, answered separately

| Event | `tty` (P1) | `command` (P1) | persisted units (P2) |
|---|---|---|---|
| **Backend restart** | **survives** — re-adopted from the agent | **survives** | survives |
| **Agent restart** | **gone** (PTY master dies → SIGHUP) — reported gone | gone | **survives** — re-created at agent boot, id preserved |
| **Host reboot** | **gone** — reported gone | gone | **survives** — via systemd + state file |

Honest scope: **P1 fixes backend restart. It does not fix agent restart or reboot for terminals.**
A PTY is owned by the process that opened its master fd; when the agent restarts the kernel SIGHUPs
the foreground group and the shell dies. No bookkeeping on the backend can change that. Survival
requires the PTY to outlive the agent, which is the session broker in §18 — and building the broker
before this primitive would mean building it twice.

---

## 10. Resource limits

| Layer | When | What |
|---|---|---|
| rlimits at spawn | **P1** | `RLIMIT_NOFILE`, `RLIMIT_NPROC`, `RLIMIT_CORE=0` |
| cgroup v2 | **P2** | `cpu.max`, `memory.max`, `pids.max` — free with the systemd path |
| wall-clock timeout | **P1** | `limits.wallClockMs` — a hung unit is killed at the deadline |

**Never impose a silent limit that turns a legitimate command into a mystery failure.** A memory cap
on an interactive shell makes `npm install` die for reasons no one can see. Limits are therefore:
opt-in per unit kind with documented defaults, **reported in the unit record** so the UI can show
them, and `limits.enforced: false` whenever the host could not apply them (cgroup delegation absent
in confined mode) — a limit that is not enforced must not be presented as if it were.

The wall-clock timeout deserves emphasis because it is the one limit whose absence is currently a
correctness bug: an AI tool call or a Code Studio run that hangs today hangs **forever**, holding a
session slot. `TERMINAL_IDLE_TIMEOUT` is not a substitute — it is an idle timer, not a deadline.

---

## 11. Filesystem and workspace access

**Reuse, do not replace.** Every unit `cwd` resolves through `security/workspace.ts`
(`getWorkspaceRoot`, `joinToRoot`, `resolveExistingPath`) — the same containment check the terminal
already uses (`terminal.ts:158-165`). A unit may not start outside the workspace root.

**The one documented exception** is `defaultCwd` (`terminal.ts:293-305`): in full-host mode the
agent runs as root and an interactive shell starts in `/root`, because that is where a person
expects to land — and it is reached *through* the containment check, so a home escaped by symlink is
refused. That exception stays, stays singular, and stays written down.

**New:** a per-unit directory `/var/lib/aether/units/<id>/` holding logs and state, created for
`service`/`worker` units, with a documented retention policy (deleted with the unit unless marked
`keepArtifacts`). Without a retention rule this directory becomes an unbounded disk leak.

---

## 12. Environment handling

**Reuse `buildShellEnvironment` / `buildShellArgv` / `resolveHostIdentity` verbatim.** The
allowlist is one-way and this is the rule:

> A caller may **add leaf variables**. A caller may **never** set infrastructure variables.

Rejected keys, enforced in the agent before spawn, with a test each:

```
PATH  HOME  SHELL  USER  LOGNAME  PWD  IFS  TERM  TZ
LD_PRELOAD  LD_LIBRARY_PATH  LD_AUDIT
BASH_ENV  ENV  PROMPT_COMMAND
NODE_OPTIONS  PYTHONSTARTUP  PYTHONPATH  PERL5OPT  RUBYOPT  GEM_HOME
AETHER_*  JWT_SECRET  DATABASE_URL  ENCRYPTION_KEY
```

This is not hygiene — it is the difference between a unit spec and a privilege-escalation vector.
The agent runs as **root** in full-host mode; a caller-supplied `LD_PRELOAD` is instant arbitrary
code execution as root, and `BASH_ENV` makes even a non-interactive `bash -c` source an attacker's
file. `process.env` continues to never be inherited wholesale, and the existing
`AETHER_PAIRING_TOKEN` non-leak test must be extended to the unit spawn path.

---

## 13. Permissions and elevation

Two distinct questions that must not be conflated.

**1. Who may act?** Backend RBAC, reusing `ROLE_PERMISSIONS` in `packages/shared/src/constants.ts`.
New permissions, **additive** so no existing role breaks:

```
execution:create   execution:read   execution:signal   execution:delete
execution:manage-others   (admin/owner only)
execution:limits:raise    (owner only — raising a limit others set is privileged)
```

The existing `terminal:*` permissions remain as aliases over the unit permissions during migration.

**2. What privilege does the unit run with?** The agent runs as **root** in the default full-host
install (`deploy/lib/local-agent.sh:344`, `agent_service_user="root"`). So **every unit is root
unless something changes that.** This must be stated, not implied.

Options, and the recommendation:

| Option | Verdict |
|---|---|
| (a) run units as the agent's uid (root) | today's reality — honest, simple, dangerous |
| (b) per-unit `runAs`, agent drops privileges before exec | **recommended as an explicit, allowlisted field** — not P1, but the spec must have the slot |
| (c) user namespaces / `systemd-run --uid=` | P2, via the systemd path |

**No UI elevation toggle.** A button that grants root is a backdoor, and per-request elevation is
exactly the boundary §33 exists to prevent. If the agent is root, the shell is root; the answer is to
make the agent's **privilege level a deliberate install-time choice**, not a runtime toggle. Deferring
`runAs` is acceptable; *pretending* the question is settled is not.

---

## 14. Security boundaries

| Boundary | Today | After P1 |
|---|---|---|
| Browser → Backend | JWT + RBAC | unchanged; new permissions additive |
| Backend → Agent | pairing token; one-shot `ownerUserId` | same token; owner asserted **per request, per unit** |
| Agent → Process | root, allowlisted shell, allowlisted env | **+ env-key rejection, rlimits, wall-clock timeout, process group** |
| Process → Host | unrestricted (root) | bounded by rlimits/workspace in P1; cgroups in P2 |
| Unit → other users' units | **conflated on local agents** (§4) | **fixed** by per-unit ownership |
| Browser → Agent | never | never — a direct path would be a second ingress, forbidden by §14–18 |

The §14–18 constraint (single ingress) is why log streaming stays routed through the backend even
though browser→agent would be cheaper (§20).

---

## 15. Process discovery

`processes.list` (limit 500, sort, search) and `processes.signal`
(`SIGTERM|SIGINT|SIGHUP|SIGKILL`, `protocol.ts:64-69`) are **kept separate and unchanged**.
`units.list` lists *managed* units; `processes.list` lists the *host's* processes. They answer
different questions, and collapsing them would force the supervisor to claim ownership of processes
it never started — a category error, and a lie.

The relationship is by pid: a unit exposes its pid and pgid, so Task Manager can cross-reference.

**Process groups are mandatory.** Units spawn with `setsid`/`setpgid`, and a kill signals the
**negative pgid**, not the pid. Otherwise `npm run dev` leaves the actual dev server orphaned,
holding the port, invisible to the unit's state — one of the most common and most confusing failures
on a real machine, designed out here rather than debugged later.

---

## 16. Adoption and reconciliation

**The agent is the authority. The backend never invents.**

- **Reconcile:** ask the agent `units.list { ownerUserId }`; mirror what it reports; drop what it no
  longer knows.
- **Adopt:** a unit the agent reports that the backend has no record of is **registered**, not
  ignored. This is backend-restart recovery — the bug the user actually hit
  (`host-terminal.service.ts:165-169` only sweeps agents already in its map, so a backend restart
  leaves live shells invisible and the UI answers *"This terminal session no longer exists"*).
- **Ownership is read from the agent's record** — which the backend itself set at create — and never
  from the client. Combined with §4, a client can never cause a unit to change owner.
- **Agent unreachable → `stale`**, records untouched. Never fabricate.
- **Ordering constraint (blocking):** adoption must not ship before per-unit ownership, or it leaks
  sessions across users on an instance-scoped agent (§4). Either both, or adoption restricted to
  personal agents.

---

## 17. Relationships

**Host Agent** — is the supervisor. Becomes the owner of long-lived things, so §5's three
requirements (crash-loop protection, atomic state, policy-aware shutdown) are prerequisites, not
polish.

**Terminal** — becomes a **client**: `kind: 'tty'`, `restart: never`, interactive attach, ring
replay. Its browser contract is unchanged. It gains real process-group signalling, an honest `stale`
state, and adoption after a backend restart. **No frontend rewrite in P1** — adapters only.

**Code Studio** — its Run panel is a `kind: 'command'` unit: finite, separate stdout/stderr, honest
exit status, `restart: never`, and (P2) **persisted run history**, so "what did my last run print"
survives a reload. It already routes through `terminal.create` with `command`, so the adapter keeps
it working during migration with no change to Code Studio.

**AI agents** — a tool call is a `kind: 'command'` unit with a hard `wallClockMs`, no tty, strict
limits and the env allowlist. **An AI agent must never default to a raw interactive PTY** — that is
an unbounded, unattended root shell. This is the single most important constraint on the AI-agent
integration.

**App Runtime / App Store / Deployments** — **do not exist** and are not built here. What the
primitive owes them is a `kind: 'service'` shape that already fits: `restart: always`, cgroup limits,
a declared port set, a stable id across restarts, persisted state — i.e. a systemd-shaped thing owned
by Aether, so the App Store installs a **spec** rather than shipping a bespoke daemon. The honest
test of this design: **if adding Deployments later requires changing the primitive, the primitive was
too narrow.**

---

## 18. Ports, domains, and the session broker

**Ports.** The integration point is deliberately **not** the unit — a unit *listens*, ports are
discovered by `ports.list` (real socket scan) and published by tunnels/previews. Two things the
primitive owes the port layer:

1. **Attribution** — "which unit owns :3000?" resolved by walking pgid → pids → sockets. This is
   what lets the Ports app offer *"stop the thing holding this port"*, which is what users want.
2. **Deterministic preview ports** — a unit spec may declare `ports: [{port, name}]`, allocated from
   `AETHER_PREVIEW_PORT_RANGE`. This is a **direct reuse of the P0 #4 work**: that change made the
   preview range a single source of truth (`deploy/lib/utils.sh:222`, `docker-compose.prod.yml`),
   and stable per-unit preview URLs are the payoff that makes it worth having.

**Domains.** Unchanged — Caddy ingress, the existing preview path. The primitive must not grow a
second ingress (§14–18).

**Session broker (P3, not P1).** For a PTY to survive an agent restart, something else must own the
master fd. Two designs: `tmux`/`screen` as the PTY owner (works; adds a host dependency and changes
`TERM` semantics — defensible as **opt-in**, wrong as a silent default), or a **dedicated
session-broker daemon** over a unix socket with the agent as a client (cleanest; a new long-lived
privileged component needing its own authz, unit and lifecycle, on a host sized at 1 vCPU). The
recommendation stands from the previous assessment: **build neither now** — the broker is a client of
this primitive, and building it first means building it twice.

---

## 19. Persistence and state

| State | Store | Survives backend restart | agent restart | reboot |
|---|---|---|---|---|
| Unit record (spec, owner, policy) | agent memory → state file (P2) | yes (via agent) | P2 only | P2 only |
| Unit id ↔ backend mapping | backend memory → DB (P2) | P1: re-adopt | — | — |
| Log ring | agent memory | yes | no | no |
| Log file | agent disk (P2) | yes | yes | yes |
| Exit status of finished units | agent memory, 30 s today (`terminal.ts:234`) → DB (P2) | until reaped | no | no |
| Restart counters | agent state file (P2) | P2 | P2 | P2 |

**New table `aether.execution_units` (P2):** `id, owner_user_id, agent_id, kind, spec jsonb, state,
exit_code, exit_signal, kill_reason, started_at, finished_at, created_at, updated_at`, indexed on
`(owner_user_id, created_at desc)` — plus a **retention policy**, without which it grows forever.

**Reuse the migration mechanism; do not reuse the settings table.** `desktop.layout.<userId>` and
`desktop.pinnedApps.<username>` (from P0 #3) are exactly right for small per-user *preferences*.
Unit history is append-heavy and queryable — a key-value row per unit would be an abuse of a pattern
that works.

---

## 20. API contract

**Backend REST** — `/api/execution/units`, JWT + `requirePrincipal`, zod-validated
(`packages/shared/src/schemas/execution.schema.ts`):

```
POST   /api/execution/units                    create
GET    /api/execution/units                    list (own; ?all=true needs execution:manage-others)
GET    /api/execution/units/:id                one
GET    /api/execution/units/:id/log            ?stream=stdout|stderr|pty&offset&length
POST   /api/execution/units/:id/input          tty only
POST   /api/execution/units/:id/resize         tty only
POST   /api/execution/units/:id/signal         { signal }
POST   /api/execution/units/:id/restart        policy-gated
DELETE /api/execution/units/:id                kill + forget
WS     /api/execution/units/:id/stream         live output + state transitions
```

**Agent RPC verbs** (additive; `agentCapabilities` in `protocol.ts:25` grows, existing verbs stay):
`units.create`, `units.list`, `units.get`, `units.signal`, `units.kill`, `units.restart`,
`units.log`, `units.subscribe`, `units.unsubscribe`.

**Compatibility:** `terminal.create|input|resize|signal|kill|list` become thin adapters over the
unit verbs, so nothing in the browser breaks mid-migration. Deprecate only after the frontend moves.

**Why every byte round-trips the backend:** because browser→agent direct would be a second ingress
(§14–18) and would bypass backend authz. The cost is accepted and mitigated with offsets + bounded
chunks.

---

## 21. Failure and recovery behaviour

| Failure | Behaviour |
|---|---|
| Agent socket drops | units → `stale`; UI says "host unreachable"; **never "running"** |
| Agent restarts | tty units gone, reported gone; P2 persisted units re-created, **ids preserved** |
| Backend restarts | **re-adopt from the agent** — the reported bug, fixed |
| Spawn fails (`ENOENT` shell, bad cwd) | `failed` with the real errno message, not a generic 500 |
| Unit crashes | policy applies; attempt budget enforced; then `failed: policy_exhausted` |
| Host OOM-kills the group | supervisor observes signal 9, reports it, applies policy — **with backoff**, so memory pressure does not become a restart storm |
| Disk full | log writer fails closed: stop, mark `truncated`, **never crash the agent** |
| State file corrupt (P2) | start with **no** units, log loudly; never resurrect from a partial file |

---

## 22. Testing strategy

**Pure unit tests (`shared`)** — spec validation; env-key rejection (`LD_PRELOAD`, `BASH_ENV`);
backoff/attempt math; exit normalization (`signal 15 → 143`, never success); state derivation; the
`stale` transition.

**Agent integration, real processes** — these are the tests that earn the design:

- `sh -c 'exit 3'` → `failed`, code 3 — never `exited`.
- `sh -c 'kill -TERM $$'` → `signal: 15`, normalized 143 — **not code 0**.
- **Process-group kill:** a unit backgrounds a long `sleep`; kill the unit; assert the *child* is
  gone. (The orphaned-dev-server bug.)
- **Crash-loop:** an immediately-exiting unit with `on-failure` stops after `maxAttempts`.
- **Pid reuse:** a unit is killed; a different process with the same pid and a different
  `/proc/<pid>/stat` start time is **not** reported as that unit.
- **Env non-leak:** `AETHER_PAIRING_TOKEN` invisible inside a unit (extending the existing test).
- **Ownership:** user A's unit is invisible to user B on the **same instance-scoped agent** —
  the §4 defect, proven fixed.
- **Adoption:** create a unit, drop the backend's in-memory map, reconcile, assert it is re-adopted
  with the agent's state.
- **Spawn-site enforcement:** the existing static test extended to the unit spawn path.

**VPS E2E (`deploy/tests/execution.sh`, house style — `PASS`/`FAIL` counters, `BLOCKED_BY_ENVIRONMENT`
+ exit 77, skips counted separately):** the real API, and the six-scenario matrix extended to units.
Scenarios 5 and 6 (agent restart, reboot) are **reported as not solved in P1**, never as passing.

**Deliberate-failure discipline:** every new test is shown to **fail against the pre-change code**
before it is trusted.

---

## 23. Migration and backward compatibility

- **Additive protocol.** New verbs; `terminal.*` kept as adapters for at least one release.
- **Version negotiation reuses an existing mechanism:** the hello already carries a `capabilities`
  array (`protocol.ts:20`). The backend feature-detects `units.create` and falls back to
  `terminal.create` — so a new backend with an old agent, and an old backend with a new agent, both
  work. No new handshake field needed.
- **The ownership change is the one incompatible piece**, and it ships in three independently
  deployable steps: (1) the agent learns per-unit ownership and still honours the handshake owner for
  legacy verbs; (2) the backend sends a per-request owner; (3) adoption is enabled — **gated on 1+2
  being live everywhere**, for the §4 reason.
- **No reinstall for P1** — agent and backend code only. Phase 2 (systemd units for persistence) does
  need an installer/`aether update` step to ship a unit and grant systemd access, and it must be
  idempotent.
- **DB migration (P2)** is additive: a new table, no backfill.

---

## 24. Reuse vs replace

| Component | Decision |
|---|---|
| `execution-environment.ts`, `host-identity.ts`, `security/workspace.ts` | **reuse verbatim** — the primitive is a client |
| `capabilities/terminal.ts` session map | **replace** with the unit registry; the file survives as the tty adapter |
| `host-terminal.service.ts` reconcile | **extend** to adopt; keep the "never invent" rule |
| `agent-gateway.service.ts` in-process path | **fold into** the registry — two terminal paths is a divergence source |
| `processes.*` | **keep separate** — different question (§15) |
| port tunnels / preview | **integrate at the port layer**, not the unit layer (§18) |
| `backend/src/services/terminal.service.ts` (in-container PTY) | **decide**: a second PTY owner of the same idea. Recommend keeping only for a dev mode with no agent, or deleting — its `PWD` divergence was already fixed once |
| settings key-value table | **preferences only** — not unit history (§19) |
| migration mechanism | **reuse** |
| hello `capabilities` array | **reuse** for negotiation (§23) |
| `files.readChunk` offset contract | **reuse** as the log-read contract (§7) |
| `preview_port_range` single source of truth (P0 #4) | **reuse** for deterministic preview ports (§18) |

---

## 25. Trade-offs, stated

1. **Every log byte round-trips the backend.** Cheaper to go browser→agent; rejected, because it is
   a second ingress and bypasses authz. Accepted cost, mitigated by offsets.
2. **Agent-as-supervisor vs systemd-as-supervisor.** Hybrid by kind (§5). The judgement: reuse the
   host's init for services, don't reimplement cgroups/journal; keep PTYs in-process, because systemd
   has no good answer for an interactive terminal.
3. **Per-request principal weakens the "one connection = one user" invariant** that makes today's
   code simple. Accepted — the invariant is already false for instance-scoped agents, it is just
   currently masked by the absence of adoption.
4. **P1 does not fix agent-restart or reboot survival for terminals.** This will disappoint. It is
   stated, not hidden; the broker (§18) is the answer and it is scheduled, deliberately, after this
   primitive.
5. **`runAs` is deferred.** Units run as root in the default install. Deferring is acceptable;
   claiming otherwise would not be.
6. **Unit history costs a table and a write per transition.** Bounded by retention policy, which is
   therefore part of the design rather than an afterthought.

---

## 26. Definition of Done (P1)

1. Unit registry on the agent, per-unit immutable ownership, every verb owner-checked.
2. `units.*` RPC + REST + WS, zod-validated on both sides.
3. Terminal and Code Studio run on the primitive through adapters; **their browser contracts do not
   change**.
4. **Backend-restart adoption works and is tested** — the reported bug fixed.
5. Process-group signalling; killing a unit kills its children (tested).
6. Honest exit model; a signalled unit is never reported as success (tested).
7. Crash-loop protection enforced and tested — **before** any `always` policy exists.
8. Env-key rejection (`LD_PRELOAD` and friends) enforced and tested.
9. rlimits + wall-clock timeout applied; `stale` visible in the UI.
10. Spawn-site enforcement test extended to the unit path.
11. Docs updated: `docs/architecture/EXECUTION-MODEL.md`, `KNOWN-LIMITATIONS.md`, the roadmap; the
    six-scenario matrix re-run and **reported honestly** (5 and 6 still partial in P1).
12. No `git push`.

---

## 27. Phasing

| Phase | Content | Delivers |
|---|---|---|
| **P1** | Unit registry, per-unit ownership, `units.*`, adapters, adoption, process groups, exit model, crash-loop protection, env-key rejection, rlimits, wall-clock timeout, `stale` | **Fixes the reported bug.** One primitive, every path on it. |
| **P2** | Persisted units via transient systemd units, cgroups, log files, `aether.execution_units`, restart policies for `service`/`worker`, `runAs` | Units survive agent restart and reboot; a real App Runtime substrate |
| **P3** | Session broker for interactive PTY survival (opt-in tmux backend explored first) | Terminals survive agent restart and reboot |

**P1 is the deliverable this proposal asks approval for.** P2 and P3 are recorded so the P1 design is
judged against where it is going — the test in §17: if P2 and P3 require changing the primitive, the
primitive was too narrow.
