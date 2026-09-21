# P1 — General Execution + Supervision Primitive

**Status:** design proposal, **revision 2**, awaiting approval. No P1 code has been written.
**Scope:** one reusable primitive that Terminal, Code Studio, AI agents, App Runtime,
Deployments and background workers all consume, instead of each growing its own spawn path.

```
UI  →  Backend  →  Host Agent  →  Real Linux Process
        (authz)    (supervisor)     (fork/exec, PTY, cgroup)
```

The rule this document exists to enforce: **a feature that stops at the UI is not done, and a
feature that spawns a process without going through this primitive is a defect.**

> **Revision 2.** Revision 1 was put through adversarial review: six independent lenses read this
> document *and* the code, producing 66 findings. The verification pass was then cut short by an API
> quota failure (84 of 114 agents died), so the surviving verdicts were not trustworthy and every
> finding below was re-checked by hand against the source. What changed is listed in **§28**;
> the items that are *not* resolved and need a decision are marked **OPEN** and collected there.
> Revision 2 is the version to approve.

---

## 1. What already exists, and what is actually missing

| Piece | Where | State |
|---|---|---|
| Real PTYs | `packages/host-agent/src/capabilities/terminal.ts` | works, session table is an in-memory `Map` (line 46) |
| Login shell + env allowlist | `packages/shared/src/execution-environment.ts` | works, enforced by a spawn-site test |
| Host identity from passwd | `packages/shared/src/host-identity.ts` (`@aether/shared/node`) | works |
| Workspace containment | `packages/host-agent/src/security/workspace.ts` | works — and is **vacuous in full-host mode**, see §11 |
| Backend ↔ agent RPC | `packages/host-agent/src/protocol.ts` — 22 verbs | works |
| Backend session bookkeeping | `packages/backend/src/services/host-terminal.service.ts` | per-process `Map` (line 38) |
| Process listing / signalling | `capabilities/processes.ts` via `processes.*` | works, discovery only — **and unowned**, see §4 |
| Port tunnels | `capabilities/port-tunnel.ts` | works |
| WS auth for browsers | `packages/backend/src/security/ws-ticket.ts` — single-use ticket | works; §20 reuses it |
| Migrations | `packages/backend/migrations/001_init.sql`, `002_local_agent.sql` | numbered SQL files |
| Audit events | `packages/backend/src/services/audit.service.ts` (`recordAuditEvent`) | exists; §14 requires units to use it |
| **Unit lifecycle beyond a tty** | — | **absent** |
| **Supervision: restart, limits, backoff** | — | **absent** |
| **Persistent logs** | — | **absent** (256 KB ring, memory only, line 48) |
| **Adoption after backend restart** | — | **absent** — the bug the user hit |
| **Per-unit ownership** | — | **absent** — §4, the blocker |
| App Runtime / Deployments / App Store | — | do not exist (`packages/backend/src/services/` has no such file) |

Today the only execution primitive is *"an interactive PTY that dies with the agent"*. Everything
here makes that one case a special case of something general.

---

## 2. One Execution Unit, many faces

The primitive's noun is the **Execution Unit** — a durable, addressable, owned, supervised record of
one process group with a lifecycle, a log, and an exit status.

```
ExecutionUnit {
  id             uuid            stable, backend-addressable
  ownerUserId    string          IMMUTABLE after create — the authorization key
  kind           'tty' | 'command' | 'service' | 'worker'
  agentId        uuid            which host runs it
  spec           {
                   shell? | argv?, cwd, env: Record<string,string>,
                   tty: boolean, cols?, rows?, term?,
                   runAs?,                      // §13, P2
                   ports?: { port, name }[]     // §18
                 }
  state          'starting'|'running'|'exited'|'failed'|'killed'|'stale'
  pid            number | null
  pgid           number | null   the process group — kills target this, not pid
  startTicks     number | null   /proc/<pid>/stat field 22, against pid reuse
  bootId         string | null   /proc/sys/kernel/random/boot_id — see §3
  exit           { code: number|null, signal: number|null, normalized: number, at: iso } | null
  restart        { policy, maxAttempts, backoffMs }        // enforced from P2, see §9
  limits         { wallClockMs?, memoryMaxBytes?, cpuMaxPercent?, nofile? }
  log            { mode: 'pty'|'pipe', ringBytes, persisted: boolean }
  createdAt      startedAt      lastActivityAt
}
```

**This is the minimum shape, and later kinds add fields to it — that is expected, not a failure.**
`spec.runAs` and `spec.ports` exist precisely so §13 and §18 have somewhere to land; a reader
implementing only this section must include them, or those sections cannot be built.

### Why one record and not three

Because the three hard problems — *who owns it*, *is it still alive*, *what did it print* — need one
answer each, and every extra spawn path answers them differently. The codebase already shows the
cost: there are **two** PTY implementations — `packages/host-agent/src/capabilities/terminal.ts` and
`packages/backend/src/services/terminal.service.ts` (spawn at line 159). `agent-gateway.service.ts`
is not a third; it is the dispatcher that *calls* `terminal.service.ts` for the in-process path.

### `kind: 'tty'` is field-compatible with `TerminalSession`, not identical

`TerminalSession` (`packages/shared/src/types/terminal.ts:4`) carries `shell`, `cwd`, `cols`, `rows`,
`attachedClients` and a `status` from `TerminalStatus`. The unit record moves `shell`/`cwd`/`cols`/
`rows` into `spec`, has no `attachedClients` (that is a property of a *subscriber*, not a unit), and
uses a different state vocabulary. So the migration is an **adapter with an explicit mapping table**,
not a rename — which is still far cheaper than a rewrite, and the browser contract is preserved by
the adapter rather than by structural identity.

---

## 3. Process lifecycle

```
create ──▶ starting ──▶ running ──┬──▶ exited   (voluntary, code 0)
   │                              ├──▶ failed   (nonzero, or signalled)
   │                              └──▶ killed   (we did it, with a reason)
   └──▶ failed (spawn error: ENOENT, EACCES, cwd missing)
                                    stale        (agent unreachable — state unknown)
```

**`stale` is first-class.** When the backend cannot reach the owning agent, the honest answer is
"unknown". `reconcileHostSessionsForUser` already refuses to invent an answer
(`host-terminal.service.ts:159-163`) — but it leaves the last known state *displayed as current*.
`stale` makes the policy visible instead of implicit.

**Liveness is derived from the OS — with the caveats stated, because it is not a proof.**
`kill(pid, 0)` plus `/proc/<pid>/stat` field 22 (`starttime`, in clock ticks since boot) defeats pid
reuse, but it does **not** cover:

- a **zombie** — `kill(pid,0)` succeeds and `/proc` still exists while the process is dead; the
  agent must also read state `Z` (field 3) and treat it as exited;
- **`EPERM`** — a process owned by another uid where the agent lacks permission; the honest answer is
  `stale`, not `running`;
- a **pid namespace / `hidepid`** `procfs`, where `/proc/<pid>` is not readable — same answer;
- **a reboot**, which resets the tick counter that `starttime` is measured in. This is why `bootId`
  is in the record: `startTicks` is only comparable within one boot, so a mismatch on `bootId` means
  the unit is gone regardless of what the pid now points at.

---

## 4. Ownership — the blocker, and the one incompatible change

> **Status: shipped.** This is the first implementation slice; see §29 for the table of changes and
> the one-time cost. The section below is left as written, because the reasoning is what the code
> has to keep satisfying.

### The defect, proven from the code

Ownership is asserted **once per connection** and never again.

- `packages/host-agent/src/connection.ts:291` — `this.ownerUserId = result.data.ownerUserId`, bound
  for the life of the socket.
- `packages/backend/src/ws/agent.ws.ts:63` — the backend sends `record.ownerUserId ?? record.agentId`.
- `packages/backend/src/routes/terminal.routes.ts:109` — for a **host** session, `createHostSession(
  requireAgentId(scope), principal.user.id, {...})`. (Line 117 is the *workspace* branch, which
  spawns a PTY in the backend container — a different path, and revision 1 cited it for the host
  claim.)
- `packages/backend/src/services/host-terminal.service.ts:74` — recorded under that `ownerUserId`.

There are **three** principal forms in play, not two:

| Principal | Where produced | Used for |
|---|---|---|
| the user's UUID | `routes/terminal.routes.ts:109` | backend's record of a host session |
| the **bare agent UUID** | `ws/agent.ws.ts:63` (personal agent) | the agent's own session key |
| **`agent:<agentId>`** | `services/agent-gateway.service.ts:98` | the in-process gateway path |

For a personal agent the first two agree. For an **instance-scoped local agent**
(`host_agents.owner_user_id IS NULL` — the default full-host install, `deploy/lib/local-agent.sh`)
they do **not**: the agent keys sessions on its own UUID while the backend records the user's. So the
agent's `terminal.list` returns **every session on the host**, to whoever asks. Nothing leaks today
only because nothing adopts — `reconcileHostSessionsForUser` sweeps only agents already in its map
(`host-terminal.service.ts:167-169`). **Enable adoption without fixing this and it becomes a
cross-user session leak.** Adoption and ownership ship together, or adoption is restricted to
personal agents.

### Two more holes in the same class — and one is worse

Adversarial review found that the terminal session table is not the only unowned surface. In
`packages/host-agent/src/router.ts`, the capability handlers receive `cfg` and the request params and
**never the principal**:

| Verb | Dispatch | Owner checked? |
|---|---|---|
| `files.list` / `read` / `readChunk` / `write` / `writeChunk` / `delete` / `mkdir` / `rename` | `router.ts:192-243` | **no** |
| `processes.list` / `processes.signal` | `router.ts:174-190` | **no** |
| `terminal.kill` | `router.ts:312-316` — `killSession(params.id, 'backend_request')`, and `killSession` (`terminal.ts:385`) does `sessions.get(sessionId)` with no owner check | **no** |

So on a shared instance-scoped agent, any authenticated Aether user can read and write any file in
the workspace, signal any process, and kill any terminal session by id. The backend routes check
ownership *before* calling, which is why this is not currently exploitable end-to-end — but the agent
verbs are the security boundary of record, and they are open. Revision 1 called the terminal case
"the blocker" while this is strictly larger.

**This is a scope decision, marked OPEN-1.** Either P1's ownership work covers the **whole** agent RPC
surface (`files.*`, `processes.*`, `terminal.*`, `units.*`) — which is the correct fix and makes P1
bigger — or P1 fixes units plus `terminal.kill` and the rest is scheduled explicitly. Doing units
only, silently, is not an option.

### The change

Move the principal **from the handshake to the request**, and record it **per unit, immutably**:

```
units.create { ownerUserId, spec, ... }   → unit.ownerUserId := ownerUserId  (frozen)
units.*      { id, ... }                  → reject unless unit.ownerUserId === asserted owner
units.list   { ownerUserId }              → only that owner's units
```

The handshake `ownerUserId` becomes the **legacy fallback** for `terminal.*` during migration, then
retires. Note that "legacy verbs honour the handshake owner" is an *intent*, not today's behaviour:
`terminal.kill` ignores it entirely.

### Trust model — stated plainly, and correctly this time

Revision 1 had this backwards. The correct statement:

- The agent **connects out** to the backend and presents the pairing token in the `hello` frame
  (`connection.ts:100`, `:223`); the backend verifies it against `host_agents.token_hash`
  (`agent-pairing.service.ts:171`). **The token authenticates the agent to the backend.** It is what
  stops a random host process registering itself at `/ws/agent`.
- The agent has **no inbound listener** and **verifies nothing about the backend**. It parses
  `hello_ack` and accepts `ownerUserId` with no proof (`connection.ts:283-298`).
- Therefore the agent **trusts the backend's assertion unconditionally**, and that is a consequence
  of the architecture — the agent has no user database — not a property the token provides.

The security boundary is: **backend RBAC authenticates the user to the backend** (that is the real
control), and the agent's job is **containment**, not identity. It must enforce that a request naming
a unit carries that unit's recorded owner, and that nothing can change a unit's owner.

Two consequences to write down rather than assume:

- **Transport is not guaranteed.** `deploy/scripts/setup-host.sh` permits `ws://` without TLS, so the
  token and every `ownerUserId` assertion can cross the wire in clear. The install should require
  `wss://` outside localhost; until it does, the trust model has a network caveat.
- **Agent revocation does not disconnect a live socket.** `revokeAgent` marks the row revoked and
  `authenticateAgent` refuses new connections, but an already-registered socket keeps serving, so a
  revoked agent's units stay reachable. **P1 must close the socket on revoke**; otherwise the
  security table in §14 must say so.

This is **not a weakening** of what exists: the backend can already assert any `ownerUserId` at hello
and the agent already believes it. Moving the assertion per-request and freezing it per unit is
strictly better granularity, and it fixes the local-agent conflation.

---

## 5. Supervisor architecture

**The Host Agent is the supervisor.** It gains a unit registry beside its capability map and no new
privileges. **One supervision model per kind** — revision 1 implied two for the same kind:

| Kind | Supervisor | Enforcement point | Why |
|---|---|---|---|
| `tty` | in-process | agent | needs a PTY and low-latency attach |
| `command` | in-process | agent | short-lived; systemd overhead exceeds benefit |
| `service`, `worker` | systemd (P2) | systemd | cgroups, journal, boot start, restart accounting |

There is no "agent supervises services" path. When a kind moves to systemd, the agent becomes a
*controller* of systemd units, not their supervisor — restart, backoff and crash-loop accounting are
systemd's, and the agent only reports. That removes the ambiguity about who enforces what.

Three things the in-process supervisor must have, all **P2** because they only matter once restart
policies exist (§9):

1. **Crash-loop protection** — see §9 for why revision 1's math was defeatable.
2. **Atomic state** — `tmp + fsync + rename`; a corrupt file means start with **no** units and log
   loudly, never resurrect a partial record.
3. **Policy-aware shutdown** — `killAllSessions()` on graceful shutdown (`terminal.ts:455`) is right
   for terminals and wrong for services. Shutdown must consult each unit's policy.

### In-process vs systemd — the biggest judgement call

systemd supervises better than anything written here: cgroups, journal, restart accounting, boot
start, all free and battle-tested. It cannot host an interactive PTY, and reaching it needs root plus
systemd access.

**Recommendation, revised:** keep interactive `tty` and short `command` units in-process; delegate
**only** `service`/`worker` to systemd in P2. Reuse the host's init where it is genuinely better
rather than reimplement cgroups and a journal — but do not pretend systemd solves PTY survival, and
do not pretend it works in confined mode (§9).

---

## 6. Spawn paths — there are two, and revision 1 only specified one

Revision 1 demanded separate stdout/stderr for `command` units (§7) while saying the spawn path is
`pty.spawn`, which has **one merged stream**. That is not implementable. The correct design names
both paths explicitly:

| Path | Used by | Mechanism | Streams | Session |
|---|---|---|---|---|
| **PTY** | `tty` | `pty.spawn(shell, buildShellArgv(command), {...})` — unchanged from today (`terminal.ts:177`) | merged (correct for a terminal) | `node-pty` puts the child in a **new session with the pty as its controlling terminal** |
| **Pipe** | `command`, `service`, `worker` | `child_process.spawn(shell, buildShellArgv(command), { stdio: ['ignore','pipe','pipe'], detached: true })` | **separate** stdout/stderr | `detached: true` calls `setsid`, giving a new session and process group |

Both paths **reuse `buildShellArgv`, `buildShellEnvironment` and `resolveHostIdentity` verbatim**, and
both must be covered by the spawn-site enforcement test. That test currently scans `pty.spawn` only
(`packages/host-agent/src/capabilities/terminal.test.ts`) — **it must be extended to
`child_process.spawn`**, or the new path is exactly the unguarded door the test exists to prevent.

**`setsid` vs `setpgid` are not interchangeable**, and revision 1 used them as if they were:

- `setsid` creates a **new session** (no controlling terminal) and **fails if the caller is already a
  process group leader** — so it cannot be called naively from the agent process itself; it is a
  property of the *child* (`detached: true`, or `node-pty`'s own setup).
- `setpgid` creates a new **process group** within the current session.

For `tty` units, the correct behaviour is already what `node-pty` does; the agent does not call
either. For pipe units, `detached: true` is what gives a killable group.

---

## 7. stdout / stderr / log model

Today: one merged stream in a 256 KB in-memory ring, replayed on attach, never persisted
(`terminal.ts:48`, `:83-95`). Correct for a terminal, wrong for anything else.

- **`tty` units** — ring buffer for attach replay (as today), plus an optional append-only file (P2).
- **Pipe units** — stdout and stderr are **separate streams** with independent monotonic byte offsets,
  which is only possible on the pipe path (§6).
- **The read contract reuses `files.readChunk`'s shape** — `{ offset, length }` in,
  `{ contentBase64, size, offset }` out, capped at `LIMITS.HOST_STREAM_CHUNK_BYTES` (512 KB). This
  buys the property that matters: *following the log of a finished run is a plain read.*
- **Bounded, always.** Disk logs rotate at `LOG_MAX_BYTES` and mark `truncated: true`; a writer that
  cannot write (disk full) **stops and marks truncation** rather than crashing the agent. Note the
  caveat revision 1 glossed: stdout and stderr have **separate writers**, so the bound must be
  enforced per stream with a shared budget, and the rotation must be atomic under concurrency.
- **Backpressure is explicit.** A subscriber that cannot keep up gets `{ type:'overflow',
  droppedBytes }`, never a silent gap.

### Code Studio in P1

Code Studio's Run panel goes through `terminal.create` with a `command` today, i.e. a **merged PTY
stream**. Since §6 says separate streams need the pipe path, and P1 promises Code Studio's contract is
unchanged, the honest resolution is: **Code Studio's Run stays a `tty` unit with a command in P1** —
same behaviour, same merged stream, adapter only. It moves to `kind: 'command'` and separate streams
in P2, when there is a reason to change its UI. Revision 1 asserted both, which was a contradiction.

---

## 8. Exit-code model

The two spawn paths report exits differently, so one formula does not cover both:

| Path | Event | Shape |
|---|---|---|
| PTY | `pty.onExit(({ exitCode, signal }))` | `exitCode: number`, `signal: number` |
| Pipe | `child.on('exit', (code, signal))` | `code: number \| null`, `signal: NodeJS.Signals \| null` (**a name**, e.g. `'SIGTERM'`) |

```
exit { code: number|null, signal: number|null, normalized: number, at: iso }
normalized = signal !== null ? 128 + signal : (code ?? 0)
```

`signal` is normalized to its **number** on both paths, so `128 + signal` is meaningful — the shell
convention: `SIGTERM` → 143, `SIGKILL` → 137.

Caveats to state rather than hide:

- The rule applies to the **direct child**. A shell wrapper may exit with a code instead of a signal
  (e.g. `bash -c 'kill -TERM $$'` can surface as code 143 or as a signal, depending on the wrapper),
  so §22's test asserts the **normalized** value and the state, not the raw field.
- **A signalled unit is never `exited`-as-success.** It is `failed`, or `killed` if Aether sent the
  signal, with the signal recorded. `state` is *derived* from `{code, signal, killer}`, never guessed.
- **`killed` carries a reason** — `idle_timeout`, `backend_request`, `signal_SIGTERM`, `user`,
  `policy_exhausted`, `wall_clock_timeout`. `killSession` takes one today (`terminal.ts:385`) and only
  logs it; the unit record keeps it.

---

## 9. Restart policy, crash recovery, and the survival matrix

**Policies ship in P2, not P1.** Revision 1 put crash-loop protection in P1's Definition of Done
while P1's only policy was `never` — a guarantee nothing exercised. Interactive `tty` units and Code
Studio runs must be `never`; auto-restarting a failed *command* is surprising and wrong. `on-failure`
and `always` belong to `service`/`worker`, which are P2. The rule that matters, and the reason this
is safe to defer: **offering `always` before crash-loop protection exists is a loaded gun.**

Crash-loop protection, when it lands, must be stronger than revision 1's "`maxAttempts` within a
window", which a slow-failing unit can defeat by spacing its failures past the window, and which a
unit that exits **0** under `always` never counts at all:

- a **total attempt budget** (not per-window) that is never reset by success alone;
- an exit inside `minHealthyUptime` counts as a **failure regardless of exit code**, so an
  exit-0-then-die loop is caught;
- `backoff = min(backoffMs * 2^attempt, backoffCeiling)`;
- exhaustion sets `failed: policy_exhausted` and **stops**, including for `always`.

### The survival matrix, corrected

Revision 1 claimed P2's systemd units survive a reboot. **Transient units do not** — `systemd-run`
units are runtime-only and vanish on reboot. Corrected:

| Event | `tty` (P1) | `command` (P1) | `service`/`worker` (P2) |
|---|---|---|---|
| **Backend restart** | **survives** — re-adopted from the agent | **survives** | survives |
| **Agent restart** | **gone** (PTY master dies → SIGHUP) — reported gone | **gone only if the agent kills it**; see below | **survives** |
| **Host reboot** | **gone** — reported gone | gone | **survives** — via a unit recreated at boot, not a transient one |

Three corrections inside that table:

1. **Boot survival needs a durable unit or a boot-time recreator.** Two options: generate a real unit
   file under `/etc/systemd/system` and enable it (systemd does the work), or keep a state file and
   have the agent **recreate** units at boot (the agent already starts at boot via
   `aether-host-agent.service`). Recommendation: **state file + agent recreate** — one mechanism
   instead of two, and it keeps `service` units inside the primitive rather than half in systemd.
2. **A pipe unit in its own session does NOT die when the agent dies.** With `detached: true` there is
   no controlling terminal, so no SIGHUP is delivered — the unit becomes an **orphan**, which is why
   "`command` is gone on agent restart" is not automatic. P1 must either set `PR_SET_PDEATHSIG`
   (Linux-only, needs a small shim, and note it fires on *thread* death) or accept orphans and
   **detect** them at boot from the state file. The honest default: set PDEATHSIG where available,
   otherwise record enough (pgid + startTicks + bootId) to reap orphans at startup.
3. **Confined mode changes all of this.** `deploy/lib/local-agent.sh` installs either as **root with
   workspace `/`** (full host) or as `AETHER_AGENT_USER` (default `aether-agent`) with a restricted
   workspace (profile "confined"). In confined mode the agent has no root, so no systemd units, no
   cgroups, and no `/var/lib/aether`. **P2 is full-host only.** In confined mode the primitive
   degrades to in-process supervision with no boot persistence, and the unit record must report
   `persisted: false` and `limits.enforced: false` rather than implying otherwise.

Honest scope: **P1 fixes backend restart. It does not fix agent restart or reboot for terminals.**
A PTY is owned by the process that opened its master fd; when the agent restarts the kernel SIGHUPs
the foreground group and the shell dies. Survival needs the broker (§18), and building it before this
primitive would mean building it twice.

---

## 10. Resource limits

Revision 1 was wrong about the mechanism and about one of the limits.

| Limit | Phase | Reality |
|---|---|---|
| `RLIMIT_CORE=0` | P1 | works; genuinely per-process |
| `RLIMIT_NOFILE` | P1 | works; genuinely per-process |
| `RLIMIT_NPROC` | **removed** | **not a per-unit limit**: it is counted **per real UID**, and on Linux it is **not enforced at all** for a process with real uid 0 / `CAP_SYS_RESOURCE` / `CAP_SYS_ADMIN`. Since every unit runs as root by default (§13), it is both ineffective and, if it ever did apply, it would throttle the *whole* root uid including the agent rather than the unit |
| cgroup v2 `pids.max`, `memory.max`, `cpu.max` | P2 | the correct per-unit answer; needs the systemd path |
| `wallClockMs` | P1 | works, with escalation (below) |

**How rlimits are actually applied.** Node has no `setrlimit`, and the scheduler's
"spawn stays exactly as it is" rule forbids improvising one into `pty.spawn`'s options. Two workable
mechanisms, and P1 must pick one rather than assert the outcome:

- for **`tty` units**: the login shell is already running, so set them in the shell invocation
  (`ulimit -c 0; ulimit -n <n>; exec <command>`) — reuses the shell that is there;
- for **pipe units**: a tiny wrapper the agent execs before the real argv, which calls `setrlimit`
  and `exec`s — one small, auditable shim, not a change to the spawn path.

**The wall-clock timeout must escalate:** `SIGTERM` to the process group at the deadline, a grace
period, then `SIGKILL`. A bare SIGTERM leaves a unit that ignores it running forever, which is
exactly the failure the timeout exists to prevent. `TERMINAL_IDLE_TIMEOUT` is not a substitute — it
is an idle timer, not a deadline.

**Never impose a silent limit.** Limits are opt-in per kind with documented defaults, **reported in
the unit record**, and `limits.enforced: false` whenever the host could not apply them.

---

## 11. Filesystem and workspace access

**Reuse, do not replace.** Every unit `cwd` resolves through `security/workspace.ts`
(`getWorkspaceRoot`, `joinToRoot`, `resolveExistingPath`) — the same check the terminal uses
(`terminal.ts:158-165`). A unit may not start outside the workspace root.

**Stated honestly: in the default full-host install this boundary is vacuous.** `deploy/lib/local-agent.sh`
sets `agent_workspace="/"` and `agent_service_user="root"`, so the "workspace root" *is* `/` and
containment excludes nothing. It is a real boundary in confined mode only. Revision 1 listed it under
P1 security boundaries without that qualifier, which overstates the protection; it belongs in §14
with the caveat, and the actual containment for full-host is the **`runAs`** decision in §13.

The one documented exception stays: `defaultCwd` (`terminal.ts:293-305`) lands an interactive shell in
the passwd home when that home is inside the root, reached *through* the containment check.

**New:** a per-unit directory `/var/lib/aether/units/<id>/` for logs and state, with a retention
policy (deleted with the unit unless `keepArtifacts`) — full-host only (§9).

---

## 12. Environment handling

**Reuse `buildShellEnvironment` / `buildShellArgv` / `resolveHostIdentity` verbatim.** The allowlist
is one-way:

> A caller may **add leaf variables**. A caller may **never** set infrastructure variables.

Rejected keys, enforced in the agent before spawn, each with a test:

```
PATH  HOME  SHELL  USER  LOGNAME  PWD  IFS
LD_PRELOAD  LD_LIBRARY_PATH  LD_AUDIT
BASH_ENV  ENV  PROMPT_COMMAND
NODE_OPTIONS  PYTHONSTARTUP  PYTHONPATH  PERL5OPT  RUBYOPT  GEM_HOME
AETHER_*  JWT_SECRET  DATABASE_URL  ENCRYPTION_KEY
```

**`TERM` and `TZ` are deliberately NOT in that list**, correcting revision 1, which rejected them
while §6 and the allowlist both treat them as legitimate: `TZ` is a non-sensitive allowlisted variable
already carried through, and `TERM` is a **spec field** (`spec.term`, §2), not an environment key —
which is what resolves the apparent conflict with §6. A caller sets the terminal type through the
field, never through `env`.

This is not hygiene. The agent runs as **root** in full-host mode: a caller-supplied `LD_PRELOAD` is
immediate arbitrary code execution as root, and `BASH_ENV` makes even a non-interactive `bash -c`
source an attacker's file.

### Secrets — missing from revision 1, and needed

The allowlist correctly blocks `AETHER_*`, which means a `service` or deployment has **no way to
receive a credential** it legitimately needs. Blocking is right; having no alternative is a gap that
would be worked around with plaintext env literals. P2 therefore needs a **secret reference**
(`spec.env` values may be `{ secret: 'name' }`), resolved by the agent from a store it owns and never
returned over the API. Recorded now so it is designed rather than improvised.

---

## 13. Permissions and elevation

**1. Who may act?** Backend RBAC, reusing the `namespace:action` convention already in
`ROLE_PERMISSIONS` (`packages/shared/src/constants.ts`). New permissions, **additive** so no existing
role breaks:

```
execution:create   execution:read   execution:signal   execution:delete
execution:manage-others   (owner/admin)
execution:limits:raise    (owner — raising a limit someone else set is privileged)
```

`execution:manage-others` needs the model to express it: §4's ownership is a single immutable
`ownerUserId`, which cannot by itself describe "an admin acting on someone else's unit". The rule is
therefore: **ownership is the default scope, and `manage-others` widens the scope of the query, never
the unit's stored owner.** An admin acting on a unit does not become its owner, and the audit event
records both identities (§14).

**2. What privilege does the unit run with?** In the default full-host install the agent runs as
**root** (`deploy/lib/local-agent.sh:344`), so **every unit is root unless something changes that.**
This must be stated, not implied.

| Option | Verdict |
|---|---|
| (a) run as the agent's uid (root) | today's reality — honest, simple, dangerous |
| (b) per-unit `spec.runAs`, agent drops privileges before exec | **the correct answer**, and the slot exists in §2; implement in P2 |
| (c) user namespaces / `systemd-run --uid=` | P2, via the systemd path, full-host only |

**No UI elevation toggle.** A button that grants root is a backdoor, and per-request elevation is
exactly the boundary §33 of the master directive exists to prevent. If the agent is root, the shell is
root; the answer is to make the agent's **privilege level a deliberate install-time choice**, not a
runtime toggle.

---

## 14. Security boundaries

| Boundary | Today | After P1 |
|---|---|---|
| Browser → Backend | JWT + RBAC | unchanged; new permissions additive |
| Backend → Agent | pairing token authenticates the **agent** to the backend (§4) | unchanged |
| Agent's inbound trust | accepts the backend's `ownerUserId` with no proof | unchanged in kind; narrowed to per-request, per-unit |
| `units.*` | — | owner-checked per unit, immutable owner |
| `terminal.kill` | **no owner check at all** (`router.ts:312`) | fixed |
| `files.*`, `processes.*` | **no owner concept** (§4) | **OPEN-1** — fix in P1, or schedule explicitly |
| Agent → Process | root, allowlisted shell, allowlisted env | + env-key rejection, `RLIMIT_NOFILE/CORE`, wall-clock timeout with escalation, process group |
| Process → Host | unrestricted (root) | bounded in P1 by rlimits; **the real boundary is `runAs`, P2** |
| Unit → other users' units | conflated on local agents | fixed by per-unit ownership |
| Agent revocation | live socket keeps serving after revoke | **P1 closes the socket on revoke** |
| Transport | `ws://` permitted by the installer | **should require `wss://` off-localhost** |
| Browser → Agent | never | never — a direct path would be a second ingress (master directive §14–18) |
| Workspace containment | real in confined mode, **vacuous at `/` in full-host** (§11) | unchanged; stated honestly |

**Audit events — required, and absent from revision 1.** Every mutating unit action records through
`recordAuditEvent` (`packages/backend/src/services/audit.service.ts`), matching what terminal actions
already do: create, kill, signal, restart, and limit changes. Each event carries the **acting** user
and, when they differ, the **owning** user (§13). Without this, units would be the only execution path
in the system with no audit trail.

---

## 15. Process discovery and process groups

`processes.list` / `processes.signal` are **kept separate** from `units.list`. Units are *managed*;
processes are the *host's*. Collapsing them would force the supervisor to claim ownership of
processes it never started — a category error and a lie. They relate by pid/pgid so Task Manager can
cross-reference.

**Kills target the process group, not the pid.** `process.kill(-pgid, signal)`. Otherwise
`npm run dev` leaves the real dev server orphaned holding the port. For `tty` units the group is what
`node-pty` created; for pipe units it is what `detached: true` created (§6).

One caveat revision 1's pid-reuse defence does not cover: `startTicks` guards a **pid**, and a kill
targets a **pgid** — a recycled pgid is not caught by a pid check. The guard must be applied to the
group leader, and a group with no live leader is treated as gone.

---

## 16. Adoption and reconciliation

**The agent is the authority. The backend never invents.**

- **Reconcile:** ask the agent `units.list { ownerUserId }`; mirror what it reports; drop what it no
  longer knows.
- **Adopt:** a unit the agent reports that the backend has no record of is registered — backend-restart
  recovery, the bug the user hit.
- **Ownership is read from the agent's record**, which the backend itself set at create, and never
  from the client.
- **Agent unreachable → `stale`**, records untouched.

**Resolving an apparent contradiction with §4.** §4 warns that blind adoption leaks; §16 says
ownership comes from the agent's record. Both hold because they describe different things: §4 is about
adopting a list keyed on the **agent's principal** (which conflates users on a local agent — hence the
ordering constraint), while §16 is about which field of a returned unit the backend trusts once the
principal problem is fixed. The prerequisite is the same either way: **ownership first, adoption
second.**

**Adoption can race a kill or a create.** A `units.list` snapshot taken before a unit dies would
re-register it as running. Adoption must treat the list as a **hint**, re-checking each candidate's
liveness (§3) before registering, and it must be idempotent so two reconciles do not duplicate.

*Shipped for terminal sessions, where the race is already closed:* `reconcileHostSessionsForUser`
asks only agents the user is listed for, adopts what the agent reports for that user, and the agent
is the authority on liveness — a session it no longer reports is dropped from the backend rather
than resurrected. The unit version of this arrives with units.

**Multiple backend replicas duplicate records.** `hostSessions` is per-process
(`host-terminal.service.ts:38`) and the design keeps that for P1, so under more than one replica each
one adopts its own copy of every unit and they will disagree after a kill. Two honest options: state
that P1 is single-replica (matching the install, which is one replica by default) and make reconciliation
converge, or move the unit→agent mapping to the database in P1 (§19). **OPEN-2.**

---

## 17. Relationships

**Host Agent** — is the supervisor for `tty`/`command`, and a controller of systemd for
`service`/`worker` (§5). Becomes the owner of long-lived things, so §5's three requirements are
prerequisites for P2, not polish.

**Terminal** — a client: `kind: 'tty'`, `restart: never`, attach, ring replay. Browser contract
preserved by an adapter over an explicit mapping (§2), not by structural identity.

**Code Studio** — Run stays a `tty` unit with a command in P1 (merged stream, unchanged contract);
moves to `kind: 'command'` with separate streams in P2 (§7).

**AI agents** — a tool call is a `kind: 'command'` unit with a hard `wallClockMs`, no tty, and the env
allowlist. **An AI agent must never default to a raw interactive PTY** — that is an unbounded,
unattended root shell.

**App Runtime / App Store / Deployments** — **do not exist** and are not built here. The primitive
owes them a `kind: 'service'` shape that fits: `restart: always`, cgroup limits, declared ports, a
stable id across restarts, persisted state — a systemd-shaped thing owned by Aether, so the App Store
installs a **spec**, not a daemon. The design's own test: **if adding Deployments later requires
changing the primitive, the primitive was too narrow.**

---

## 18. Ports, domains, and the session broker

**Ports.** Integration is at the **port layer**, not the unit layer. Two things the primitive owes it:

1. **Attribution** — "which unit owns :3000?" by walking pgid → pids → sockets, enabling *"stop the
   thing holding this port"*.
2. **Declared ports** — `spec.ports` (§2) allocated from the preview range.

**Be precise about the port vocabulary**, correcting revision 1: the installer's single source of
truth (P0 #4) is `AETHER_PREVIEW_PORT_START` / `AETHER_PREVIEW_PORT_COUNT` with
`preview_port_range()` and `preview_port_end()` in `deploy/lib/utils.sh:195-224`, published to the
container by `docker-compose.prod.yml` as `AETHER_PREVIEW_PORT_RANGE`. That range is what Docker
**publishes**; there is **no reservation ledger**, so a "stable per-unit preview URL" is not supported
by any mechanism today — it is new work (P2), and should be stated as such rather than promised.
An application's own listening port and the host range it is published on are also distinct.

**Domains.** Unchanged — Caddy ingress, the existing preview path. No second ingress (master
directive §14–18).

**Session broker (P3, not P1).** For a PTY to survive an agent restart, something else must own the
master fd: `tmux`/`screen` as the PTY owner (works; adds a host dependency, changes `TERM` semantics —
defensible as **opt-in**, wrong as a silent default), or a **dedicated broker daemon** over a unix
socket with the agent as a client (cleanest; a new long-lived privileged component needing its own
authz, unit and lifecycle, on a host sized at 1 vCPU). **Build neither now** — the broker is a client
of this primitive.

---

## 19. Persistence and state

| State | Store | Survives backend restart | agent restart | reboot |
|---|---|---|---|---|
| Unit record (spec, owner, policy) | agent memory → state file (P2) | yes (via agent) | P2 only | P2 only |
| Unit id ↔ backend mapping | backend memory → DB (P2) | P1: re-adopt | — | — |
| Log ring | agent memory | yes | no | no |
| Log file | agent disk (P2) | yes | yes | yes |
| Exit status of finished units | agent memory, 30 s today (`terminal.ts:234`) → DB (P2) | until reaped | no | no |

**New table `aether.execution_units` (P2)** — `id, owner_user_id, agent_id, kind, spec jsonb, state,
exit_code, exit_signal, kill_reason, started_at, finished_at, created_at, updated_at`, indexed on
`(owner_user_id, created_at desc)`, plus a **retention policy** or it grows forever. Migrations follow
the existing mechanism: numbered SQL files under `packages/backend/migrations/` (next is `003_`).

**Reuse the migration mechanism; do not reuse the settings table.** `desktop.layout.<userId>`
(P0 #3) is right for small per-user *preferences*; unit history is append-heavy and queryable.

**Clock source — unstated in revision 1.** Timestamps must name their origin, because ordering across
a reboot or two agents is otherwise meaningless. Rule: the **agent's** monotonic clock orders events
within a boot, `bootId` (§3) separates boots, and the backend stamps its own received-time so clock
skew between host and backend is visible rather than silent.

---

## 20. API contract

**Backend REST** — `/api/execution/units`, JWT + `requirePrincipal`, zod-validated
(`packages/shared/src/schemas/execution.schema.ts`):

```
POST   /api/execution/units            create  { agentId, kind, spec }
GET    /api/execution/units            list    (own; ?all=true needs execution:manage-others)
GET    /api/execution/units/:id
GET    /api/execution/units/:id/log    ?stream=stdout|stderr|pty&offset&length
POST   /api/execution/units/:id/input  tty only
POST   /api/execution/units/:id/resize tty only
POST   /api/execution/units/:id/signal { signal }
POST   /api/execution/units/:id/ticket single-use WS ticket
POST   /api/execution/units/:id/restart
DELETE /api/execution/units/:id
WS     /api/execution/units/:id/stream ?ticket=…
```

**The WebSocket uses the existing ticket mechanism, not JWT** — correcting revision 1, which wrote
"JWT + `requirePrincipal`", impossible for a browser. A browser cannot set an `Authorization` header on
a WS upgrade, which is exactly why `packages/backend/src/security/ws-ticket.ts` exists: an
authenticated request mints a short-lived single-use ticket
(`POST /api/terminal/sessions/:id/ticket`, `terminal.routes.ts:231`), redeemed at handshake
(`ws/terminal.ws.ts:61-79`). The unit stream reuses it unchanged.

**Creating a unit names an agent, and that choice is an authorization decision.** `POST` takes
`agentId`; the backend must verify the principal **owns or may use** that agent (`listAgents` already
scopes by owner, with instance-scoped local agents visible to all) **before** sending the create. This
was a hole in revision 1: without it, a caller could name any agent id.

**Agent RPC verbs** (additive; `agentCapabilities` in `protocol.ts:25` grows): `units.create`,
`units.list`, `units.get`, `units.signal`, `units.kill`, `units.restart`, `units.log`,
`units.subscribe`, `units.unsubscribe`.

**Compatibility:** `terminal.*` becomes thin adapters over the unit verbs, so the browser contract
survives mid-migration.

---

## 21. Failure and recovery behaviour

| Failure | Behaviour |
|---|---|
| Agent socket drops | units → `stale`; UI says "host unreachable"; **never "running"** |
| Agent restarts | `tty` gone, reported gone; pipe units reaped via PDEATHSIG or orphan-detection (§9); P2 services recreated |
| Backend restarts | **re-adopt from the agent** — the reported bug, fixed |
| Spawn fails (`ENOENT`, bad cwd) | `failed` with the real errno message, not a generic 500 |
| Unit crashes | policy applies (P2); attempt budget enforced; then `failed: policy_exhausted` |
| Host OOM-kills the group | supervisor observes signal 9 and reports it — with backoff, so memory pressure does not become a restart storm |
| Disk full | log writers stop and mark `truncated`; never crash the agent |
| State file corrupt (P2) | start with **no** units, log loudly; never resurrect a partial file |
| Preview port held by a dead unit | §18's attribution resolves it; the port entry is reaped with the unit |

---

## 22. Testing strategy

**Pure unit tests (`shared`)** — spec validation; env-key rejection (`LD_PRELOAD`, `BASH_ENV`);
backoff/attempt math including the exit-0 slow-fail case; exit normalization for **both** exit shapes
(§8); state derivation; the `stale` transition.

**Agent integration, real processes:**

- `sh -c 'exit 3'` → `failed`, code 3 — never `exited`.
- a signalled process → normalized **143**, state `failed`/`killed` — assert the *normalized* value
  and the state, not the raw `signal` field, because a shell wrapper may report a code instead (§8).
- **Process-group kill:** a unit backgrounds a long `sleep`; kill the unit; assert the *child* is gone.
- **Pipe units:** stdout and stderr arrive on **separate** streams (§6).
- **Pid reuse:** a killed unit's pid, reused with a different `starttime`, is not reported as that unit.
- **Zombie:** a dead-but-unreaped process is reported exited, not running (§3).
- **Env non-leak:** `AETHER_PAIRING_TOKEN` invisible inside a unit.
- **Ownership:** user A's unit invisible to user B on the same instance-scoped agent.
- **`terminal.kill` ownership** — the live defect in §4: user B cannot kill user A's session by id.
- **Adoption:** create a unit, drop the backend's map, reconcile, assert re-adoption; then adopt while
  the unit is being killed and assert it is **not** resurrected (§16).
- **Spawn-site enforcement extended to `child_process.spawn`** — without this the pipe path is exactly
  the unguarded door the test exists to prevent (§6).

**VPS E2E (`deploy/tests/execution.sh`, house style — `PASS`/`FAIL` counters,
`BLOCKED_BY_ENVIRONMENT` + exit 77):** the real API; the six-scenario matrix extended to units, with
scenarios 5 and 6 **reported as not solved in P1**.

**Deliberate-failure discipline:** every new test is shown to **fail against the pre-change code**.

---

## 23. Migration and backward compatibility

- **Additive protocol.** New verbs; `terminal.*` kept as adapters.
- **The version-negotiation claim in revision 1 was wrong.** It said the backend could feature-detect
  `units.create` from the hello's `capabilities` array "with no new handshake field needed" — but the
  backend **never stores** those capabilities (`grep capabilities packages/backend/src` is empty; the
  `AgentRecord` in `agent-pairing.service.ts:9` has no such field). So feature-detection needs **new
  work**: either persist the capabilities reported at hello, or advertise the agent's protocol version
  in the handshake acknowledgement. Small, but it is work, not a reuse.
- **The ownership change is the one incompatible piece**, shipped in three independently deployable
  steps: (1) the agent learns per-unit ownership and still honours the handshake owner for legacy
  verbs; (2) the backend sends a per-request owner; (3) adoption is enabled — **gated on 1+2 being
  live everywhere** (§4).
- **Units created before the upgrade** are owned under the old handshake principal. On a personal
  agent that is the user, so they adopt cleanly; on a local agent it is the agent's UUID, so they have
  no owner any user can assert. They must be **reported as orphaned and not adopted**, rather than
  attributed to whoever asks first.
- **No reinstall for P1.** P2's systemd path does need an installer/`aether update` step, and it must
  be idempotent **and gated on full-host mode** (§9).

---

## 24. Reuse vs replace

| Component | Decision |
|---|---|
| `execution-environment.ts`, `host-identity.ts`, `security/workspace.ts`, `ws-ticket.ts` | **reuse verbatim** |
| `capabilities/terminal.ts` session map | **replace** with the unit registry; the file survives as the tty adapter |
| `host-terminal.service.ts` reconcile | **extend** to adopt; keep the "never invent" rule |
| `agent-gateway.service.ts` + `terminal.service.ts` | **one code path, not two** — the gateway is a *dispatcher* that calls the service; §2 counts it as one implementation. **Decided:** `terminal.service.ts` (the in-container PTY) is retired once units land, because two PTY owners is the divergence this primitive exists to end; it is reachable only when no agent is configured, and that mode is replaced by the agent |
| `processes.*`, `files.*` | **keep as separate capabilities** — but their missing ownership is OPEN-1 (§4) |
| port tunnels / preview | **integrate at the port layer**; no reservation ledger exists (§18) |
| settings key-value table | **preferences only** |
| `migrations/00N_*.sql` | **reuse** — next is `003_` |
| hello `capabilities` array | **not usable as-is** — needs persisting (§23) |
| `files.readChunk` offset contract | **reuse** as the log-read contract |
| `preview_port_range()` (P0 #4) | **reuse** for declared ports; reservations are P2 |

---

## 25. Trade-offs, stated

1. **Every log byte round-trips the backend.** Cheaper browser→agent; rejected — a second ingress that
   bypasses authz (master directive §14–18).
2. **Agent-as-supervisor vs systemd.** Split by kind (§5): systemd only for `service`/`worker`, and
   only in full-host mode.
3. **Per-request principal weakens the "one connection = one user" invariant.** Accepted; the
   invariant is already false for instance-scoped agents.
4. **P1 does not fix agent-restart or reboot survival for terminals.** Stated, not hidden; the broker
   (§18) is the answer, scheduled after this primitive.
5. **P2 requires full-host mode.** A confined install gets no cgroups, no boot persistence, no
   `runAs`. That is a real capability split and it is stated rather than discovered later.
6. **`runAs` is deferred**, so units are root by default in full-host mode. Deferring is acceptable;
   implying otherwise would not be.
7. **Fixing the whole RPC surface (OPEN-1) makes P1 bigger than revision 1 described.** That is the
   cost of the finding, not a reason to skip it.

---

## 26. Definition of Done (P1)

1. Unit registry on the agent; per-unit immutable ownership; `units.*` owner-checked.
2. **`terminal.kill` owner-checked** — a live defect, not a design point (§4).
3. **OPEN-1 decided and implemented**: either `files.*`/`processes.*` are owner-checked too, or the
   deferral is documented in `KNOWN-LIMITATIONS.md` with its exposure.
4. `units.*` RPC + REST + WS, zod-validated both sides; browser WS via the existing ticket.
5. `POST` verifies the principal may use the named agent before creating.
6. Terminal and Code Studio run on the primitive through adapters; **browser contracts unchanged**.
7. **Backend-restart adoption works, is tested, and is race-safe** — the reported bug fixed.
8. Both spawn paths implemented, both covered by the enforcement test (§6).
9. Process-group signalling; killing a unit kills its children (tested).
10. Honest exit model across both exit shapes; a signalled unit is never reported as success (tested).
11. Env-key rejection enforced and tested; `TERM`/`TZ` handled as spec fields, not env (§12).
12. `RLIMIT_NOFILE`/`CORE` applied via a stated mechanism; `wallClockMs` with SIGTERM→SIGKILL
    escalation; `stale` surfaced in the UI as a **small** frontend change, not a rewrite.
13. **Audit events recorded** for create/kill/signal/restart/limit-change.
14. Revocation closes the live agent socket.
15. Docs updated: `EXECUTION-MODEL.md`, `KNOWN-LIMITATIONS.md`, the roadmap; the six-scenario matrix
    re-run and **reported honestly**.
16. No `git push`.

---

## 27. Phasing

| Phase | Content | Delivers |
|---|---|---|
| **P1** | Unit registry; per-unit ownership; **the whole-RPC-surface ownership decision**; `units.*`; adapters; race-safe adoption; two spawn paths; process groups; exit model; env rejection; rlimits + timeout; audit; `stale`; revocation closes the socket | **Fixes the reported bug.** One primitive, every path on it. |
| **P2** | State file + boot recreation; systemd for `service`/`worker`; cgroups; log files; `execution_units` table + history; restart policies **with crash-loop protection**; `runAs`; secrets; port reservations | Units survive agent restart and reboot; a real App Runtime substrate |
| **P3** | Session broker for interactive PTY survival (opt-in tmux explored first) | Terminals survive agent restart and reboot |

**P1 is the deliverable this proposal asks approval for.** P2 and P3 are recorded so P1 is judged
against where it is going — the test in §17: if P2 or P3 requires changing the primitive, the
primitive was too narrow.

**One P1 line is already shipped** — per-unit ownership (for terminal sessions) and race-safe
adoption, which is the reported bug. Everything else in the P1 row is still design. §29 has the
change table.

---

## 28. What the adversarial review changed, and what is still open

**Fixed in revision 2 (all re-verified by hand against the source):**

1. The trust model was **backwards** — the pairing token authenticates the agent to the backend, and
   the agent verifies nothing (§4).
2. **`files.*` and `processes.*` have no owner concept at all**, and `terminal.kill` checks no owner —
   a larger hole than the terminal-session case revision 1 called "the blocker" (§4).
3. `RLIMIT_NPROC` is per-UID and **unenforced for root**, so it is not a unit limit; and Node has no
   `setrlimit`, so "rlimits at spawn" needed a mechanism (§10).
4. **Transient systemd units do not survive a reboot** — the survival matrix was wrong (§9).
5. **Confined mode breaks all of P2** and was never mentioned (§9).
6. **Pipe units do not die with the agent** (no controlling terminal, no SIGHUP) — orphans (§9).
7. Crash-loop protection was in P1's DoD with no P1 policy to exercise it, and its window math was
   defeatable by a slow-failing or exit-0 unit (§9).
8. **The version-negotiation claim was unimplementable** — the backend never stores agent
   capabilities (§23).
9. **The WebSocket cannot use JWT** in a browser; it reuses the existing single-use ticket (§20).
10. **Nothing said how the agent is chosen or authorized** when creating a unit (§20).
11. Separate stdout/stderr was demanded while only the PTY path was specified — **two spawn paths now
    named**, and the enforcement test extended to `child_process.spawn` (§6, §22).
12. `setsid` and `setpgid` were conflated (§6).
13. Exit reporting differs between the two paths; one formula did not cover both (§8).
14. **Audit events were missing entirely** (§14).
15. Per-user quotas, secrets, port reservations, preview fate, clock source, plan-vs-host port
    vocabulary, `runAs`/`ports` slots missing from the record, `TERM`/`TZ` self-contradiction,
    the dangling §33/§40 references, the duplicate reuse row, three wrong line citations, and the
    "1:1 map" overstatement (§2, §12, §13, §18, §19, §24).
16. Code Studio could not both keep its contract and gain separate streams — resolved to a `tty` unit
    in P1 (§7).
17. Workspace containment is vacuous at `/` in full-host mode and was presented as a boundary (§11).
18. Liveness-by-`/proc` did not account for zombies, `EPERM`, `hidepid`, or a reboot resetting the
    tick counter — hence `bootId` (§3).

**Still open — for the owner, not for the author:**

- **OPEN-1 (§4, §14, DoD 3) — answered for `files.*`/`processes.*`, still open for ports.** The
  question was whether P1's ownership work covers the whole agent RPC surface or only the terminal
  verbs. It now covers the terminal surface: the backend names the user on every terminal request,
  the agent prefers that name, and `terminal.kill` refuses a session the named principal does not
  own. `files.*` and `processes.*` stay delegated to the backend **by decision** — they are
  role-gated over one instance-wide workspace, so there is no per-user split for the agent to
  enforce, and a second copy of the role model is a second place to disagree with it. **Port
  tunnels remain a real gap**: the agent already stamps and checks a tunnel owner
  (`capabilities/port-tunnel.ts`), but `agent-ports.service.ts` does not pass the requesting user, so
  the owner stamped is the connection's paired owner. Self-consistent today, wrong in the same way
  the terminal surface was. Not in the shipped slice.
- **OPEN-2 (§16, §19):** does P1 stay single-replica (matching the default install, with converging
  reconciliation) or move the unit→agent mapping into the database now? The shipped adoption step
  narrows the gap without answering it: a restarted backend re-adopts from the agent, so a
  single-replica deployment no longer needs the mapping in the database to be correct.
- **Still pending from revision 1:** approval of the hybrid supervisor (§5), and of the deferred
  `runAs` (§13).

---

## 29. What shipped first, and why

The first implementation slice is **ownership + adoption** (§4, §16), and it is the only part of P1
whose code exists. It was chosen because it is the reported defect: a user's shell becomes
unreachable when the backend restarts, and — more seriously — the agent could not tell one user's
session from another's on an instance-scoped local agent.

What is in the working tree as of this slice:

| Change | Where | Why |
|---|---|---|
| `ownerUserId` on the request envelope | `packages/host-agent/src/protocol.ts` | One agent serves several users; one owner per connection cannot express that |
| The per-request principal preferred over the paired one; a malformed `ownerUserId` on the subscribe control frame **refused**, not ignored | `packages/host-agent/src/connection.ts` | Falling back to the paired owner would silently act as the wrong principal |
| `killOwnedSession` | `packages/host-agent/src/capabilities/terminal.ts` | `killSession` is the internal killer (idle timer, logout, shutdown — none of which acts as a person); the request path needs the owner check. An unowned id and a missing one both answer `false`, matching the 404-not-403 rule |
| `terminal.kill` routed through it | `packages/host-agent/src/router.ts` | |
| `ownerUserId` on `sendAgentRequest`; **required** on `subscribeAgentTerminal`; `connectedAgentIds()` | `packages/backend/src/services/agent-rpc.service.ts` | A subscribe that named nobody would silently succeed as the paired owner |
| The user named on every terminal send; adoption of sessions this replica has no record of, from agents the user is listed for | `packages/backend/src/services/host-terminal.service.ts` | Ownership and adoption ship together — adoption without it is the leak |
| The hello owner documented as the **fallback**, not the answer | `packages/backend/src/ws/agent.ws.ts` | |
| `seedSessionForTests` | `packages/host-agent/src/capabilities/terminal.ts` | Ownership is checked before anything touches the PTY, so a session with no PTY tests it — on every platform, including where `node-pty` does not build |

**One-time cost, stated:** sessions created before this change were keyed on the agent's id rather
than the user's, so the first `terminal.list` after deploying scopes them out and the backend drops
its records for them. Live shells from before the upgrade therefore become unaddressable once, and a
new session is correct. This is the price of removing the ambiguity; there is no way to migrate a
key the agent never told the backend it was using.

**Not shipped, and not claimed:** units, `units.*`, the supervisor, rlimits, audit events — all of
§5–§21 remain design. P2 and P3 are untouched.
