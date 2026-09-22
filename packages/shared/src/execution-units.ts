/**
 * The execution unit: one description of every process Aether starts on a host.
 *
 * A terminal session, a Code Studio run, a background worker and (later) a
 * service, an AI-agent task or a deployment are the *same thing* underneath —
 * a process with an owner, a lifecycle, a place to write its output, and a way
 * to be stopped. They differ in what is spawned and how its output is handled,
 * not in what may be asked of it. This module is that common vocabulary, and it
 * is the reason there is one registry and not one per consumer.
 *
 * It is deliberately pure: no `node:` imports, so the frontend can use the same
 * types and the same state machine the agent runs. Everything that needs the
 * host — reading `/proc`, spawning, killing — lives in the host agent.
 *
 * ## What each field is for
 *
 * | Field | The question it answers |
 * | --- | --- |
 * | `id` | What is this, stably, across restarts and reconnects? |
 * | `ownerUserId` | Whose is it — and who may see, drive or end it? |
 * | `kind` | What sort of thing is it (see `ExecutionUnitKind`)? |
 * | `agentId` | Which host is it running on? |
 * | `spec` | What exactly was asked for, so it can be reproduced? |
 * | `state` | Is it running, done, or was it killed? |
 * | `process` | Which process is it, precisely (pid *and* identity)? |
 * | `exit` | How did it end, normalized? |
 * | `restart` | What happens if it dies on its own? |
 * | `limits` | What bounds it, and has it hit one? |
 * | `log` | Where its output went and how much is retained. |
 * | timestamps | When it started, last moved, and ended. |
 *
 * ## Honest states
 *
 * `state` is what is *known*, not what is hoped. A unit whose process cannot be
 * found is `stale`, never `running`: a record that says "running" while the
 * process is gone is the single most misleading thing this model could do, and
 * it is the failure the previous terminal bookkeeping actually had.
 */

import type { TerminalSession, TerminalStatus } from './types/terminal.js';

/** What sort of process a unit is. */
export const EXECUTION_UNIT_KINDS = ['tty', 'command', 'service', 'worker'] as const;

export type ExecutionUnitKind = (typeof EXECUTION_UNIT_KINDS)[number];

/**
 * What a unit is doing, as far as anything can tell.
 *
 * - `starting` — spawned, but not yet observed running.
 * - `running` — spawned, and the process is there.
 * - `exited` — ended by itself, successfully.
 * - `failed` — ended by itself with a non-zero result, or on a signal nobody
 *   asked for.
 * - `killed` — ended because Aether was asked to end it.
 * - `stale` — the record says it was running and the process is not there. It
 *   did not report an exit; it was lost (a reboot, an OOM kill, a `kill -9`
 *   from outside). Distinct from `exited` on purpose, because "it finished" and
 *   "it vanished" are different facts and only one of them is fine.
 */
export const EXECUTION_UNIT_STATES = [
  'starting',
  'running',
  'exited',
  'failed',
  'killed',
  'stale',
] as const;

export type ExecutionUnitState = (typeof EXECUTION_UNIT_STATES)[number];

/** States from which a unit will not move again. */
export const TERMINAL_UNIT_STATES = ['exited', 'failed', 'killed', 'stale'] as const;

export function isTerminalUnitState(state: ExecutionUnitState): boolean {
  return (TERMINAL_UNIT_STATES as readonly string[]).includes(state);
}

/** How a unit's output is carried. `pty` is a terminal, `pipe` is a byte stream. */
export const EXECUTION_UNIT_LOG_MODES = ['pty', 'pipe'] as const;

export type ExecutionUnitLogMode = (typeof EXECUTION_UNIT_LOG_MODES)[number];

/** What should happen when a unit ends on its own. */
export const RESTART_POLICIES = ['never', 'on-failure', 'always'] as const;

export type RestartPolicy = (typeof RESTART_POLICIES)[number];

/** How a unit ended. */
export interface ExecutionUnitExit {
  /** The process's own exit status, when it exited rather than being signalled. */
  code: number | null;
  /** The signal number that ended it, when one did. */
  signal: number | null;
  /**
   * `code` and `signal` collapsed into one shell-compatible number, so a caller
   * comparing against `$?` sees what a shell would see. See `normalizeExit`.
   */
  normalized: number;
  /** When the exit was observed, ISO 8601. */
  at: string;
}

/** Whether a unit is supervised, and how far that has got. */
export interface ExecutionUnitRestart {
  policy: RestartPolicy;
  /** Ceiling on automatic restarts; 0 means the policy is effectively `never`. */
  maxAttempts: number;
  /** Delay before an automatic restart. */
  backoffMs: number;
  /** How many times it has been restarted so far, automatic or requested. */
  attempts: number;
}

/** The bounds a unit runs under, and whether one of them has fired. */
export interface ExecutionUnitLimits {
  /** Longest it may run before Aether ends it. Null means no wall-clock bound. */
  wallClockMs: number | null;
  /** How long it may take to die after a polite signal before `SIGKILL`. */
  graceMs: number;
  /** Output bytes retained in the agent's in-memory ring. */
  maxOutputBytes: number;
  /**
   * Virtual-address-space ceiling (`RLIMIT_AS`), in bytes. Null means unset.
   *
   * This is *not* a substitute for a cgroup `memory.max`. `RLIMIT_AS` bounds the
   * process's virtual address space, which a program can exceed in ways that
   * matter (mmapped files, overcommit) and which does not account shared pages
   * the way a memory controller does. It is the honest, no-privilege-required
   * bound the shell can set on itself; a real memory cage is the systemd/cgroup
   * supervisor, which is P2 and deliberately not built here.
   */
  addressSpaceBytes: number | null;
  /** CPU-time ceiling (`RLIMIT_CPU`), in seconds. Null means unset. */
  cpuSeconds: number | null;
  /** Open-file-descriptor ceiling (`RLIMIT_NOFILE`), a count. Null means unset. */
  maxOpenFiles: number | null;
  /** Core-dump-size ceiling (`RLIMIT_CORE`), in bytes; 0 disables cores. Null means unset. */
  coreDumpBytes: number | null;
  /**
   * Whether the host actually applied the requested rlimits.
   *
   * True only when at least one rlimit above was requested *and* the platform
   * could enforce it (a POSIX shell that honours `ulimit`). On Windows, or when
   * no rlimit was requested, this is `false` — the field reports what happened,
   * never what was hoped, so a caller is never told a bound is in force when it
   * is not.
   */
  enforced: boolean;
  /** Which bound fired, if one did. */
  exceeded: 'wall_clock' | 'output' | null;
}

/**
 * Which process a unit is — with identity, not just a number.
 *
 * `pid` alone is not an identity: the kernel reuses pid numbers, so a record
 * holding only a pid will eventually describe a different process. `startTicks`
 * is the process's start time in clock ticks since boot, read from
 * `/proc/<pid>/stat`; `bootId` is the kernel's boot identifier. Together they
 * are the smallest tuple that survives a reboot and a pid wrap:
 *
 * - a different `bootId` means the machine restarted, so the process is gone
 *   however plausible the pid looks;
 * - a different `startTicks` for the same pid means the number was reused, so
 *   the process this record describes is gone.
 *
 * Both are null on a platform that does not expose them, and a null identity is
 * reported as unknown rather than as verified — see `executionUnitLiveness`.
 */
export interface ExecutionUnitProcessIdentity {
  pid: number | null;
  /**
   * Process group to signal. Equal to `pid` for a unit Aether spawned, because
   * both spawn paths make the child a group leader — which is what lets a kill
   * reach the shell *and* everything the shell started.
   */
  pgid: number | null;
  startTicks: string | null;
  bootId: string | null;
}

/** What was asked for, kept so the unit can be reproduced exactly. */
export interface ExecutionUnitSpec {
  kind: ExecutionUnitKind;
  /** The program spawned. For `tty` and `command` this is an allowlisted shell. */
  shell: string;
  /** The command handed to the shell with `-c`, if any. */
  command?: string;
  /** Where it runs. */
  cwd: string;
  /**
   * Extra environment for this unit, by name. Refused if it names anything in
   * `REJECTED_ENV_KEYS` — see `findRejectedEnvKeys`.
   */
  env: Record<string, string>;
  /** Whether the unit has a terminal. `tty` units always do; `pipe` units do not. */
  tty: boolean;
  cols: number | null;
  rows: number | null;
  term: string | null;
  /** The log mode this resolved to. */
  logMode: ExecutionUnitLogMode;
}

/** How much output is retained, and whether anything was dropped. */
export interface ExecutionUnitLog {
  mode: ExecutionUnitLogMode;
  /** Bytes currently held in the ring. */
  retainedBytes: number;
  /** Bytes dropped because the ring was full. Non-zero means output was lost. */
  droppedBytes: number;
  /** Total bytes produced since the unit started. */
  totalBytes: number;
}

/**
 * One process Aether started, and everything known about it.
 *
 * This is the whole record. Anything a consumer needs — the Terminal, Code
 * Studio, an AI-agent task list, a deployment view — is a projection of this,
 * never a parallel store of its own.
 */
export interface ExecutionUnit {
  id: string;
  /**
   * Who the unit belongs to. Immutable for the unit's lifetime: ownership is
   * not something a running process can be handed to, because every permission
   * decision about it is made against this value.
   */
  ownerUserId: string;
  kind: ExecutionUnitKind;
  /** The host this runs on, as the agent reports itself. */
  agentId: string;
  spec: ExecutionUnitSpec;
  state: ExecutionUnitState;
  process: ExecutionUnitProcessIdentity;
  exit: ExecutionUnitExit | null;
  restart: ExecutionUnitRestart;
  limits: ExecutionUnitLimits;
  log: ExecutionUnitLog;
  createdAt: string;
  /** When the current process was spawned. Differs from `createdAt` after a restart. */
  startedAt: string;
  lastActivityAt: string;
  /** When it reached a terminal state, else null. */
  endedAt: string | null;
  /**
   * Caller-supplied idempotency token. Two `units.create` calls carrying the
   * same token and owner describe one unit, not two, so a retried request — a
   * dropped reply, a doubled click — cannot leave two shells running.
   */
  requestId: string | null;
}

/** The unit as a client sees it: identical, but never carrying the process group. */
export type ExecutionUnitView = ExecutionUnit;

export const DEFAULT_EXECUTION_UNIT_LIMITS: ExecutionUnitLimits = {
  wallClockMs: null,
  graceMs: 5_000,
  maxOutputBytes: 256 * 1024,
  addressSpaceBytes: null,
  cpuSeconds: null,
  maxOpenFiles: null,
  coreDumpBytes: null,
  enforced: false,
  exceeded: null,
};

/** The rlimit subset a caller may request on a unit. All optional; null means unset. */
export interface ExecutionUnitRlimits {
  addressSpaceBytes: number | null;
  cpuSeconds: number | null;
  maxOpenFiles: number | null;
  coreDumpBytes: number | null;
}

/** True when at least one rlimit is actually requested (not all null). */
export function hasRequestedRlimits(rlimits: ExecutionUnitRlimits): boolean {
  return (
    rlimits.addressSpaceBytes !== null ||
    rlimits.cpuSeconds !== null ||
    rlimits.maxOpenFiles !== null ||
    rlimits.coreDumpBytes !== null
  );
}

/**
 * A shell prologue that applies the requested rlimits, or `''` when none are.
 *
 * Every limit is set with no `-H`/`-S` flag, which sets *both* the soft and the
 * hard limit — so the value is the ceiling and the child cannot raise it again,
 * which is the "not raisable by the command" guarantee. Lowering a hard limit
 * needs no privilege, so this works whether the agent runs as root or not.
 *
 * The prologue ends with a separator so the caller appends the real command (or
 * an `exec` into an interactive shell) after it, in the same shell, before any
 * user code runs — the "hard limit applied before target exec" requirement.
 *
 * `ulimit -v` and `-c` take units of 1024 bytes; `-t` seconds; `-n` a count.
 * Byte inputs are converted here so the model speaks bytes and the shell speaks
 * its own units in exactly one place.
 */
export function buildRlimitPrologue(rlimits: ExecutionUnitRlimits): string {
  const parts: string[] = [];
  if (rlimits.coreDumpBytes !== null) {
    parts.push(`ulimit -c ${Math.ceil(rlimits.coreDumpBytes / 1024)}`);
  }
  if (rlimits.maxOpenFiles !== null) {
    parts.push(`ulimit -n ${rlimits.maxOpenFiles}`);
  }
  if (rlimits.addressSpaceBytes !== null) {
    parts.push(`ulimit -v ${Math.ceil(rlimits.addressSpaceBytes / 1024)}`);
  }
  if (rlimits.cpuSeconds !== null) {
    parts.push(`ulimit -t ${rlimits.cpuSeconds}`);
  }
  return parts.length === 0 ? '' : `${parts.join('; ')};`;
}

/**
 * Collapses an exit status and a signal into one number, the way a shell does.
 *
 * `128 + signal` is the shell convention: a process killed by `SIGTERM` (15)
 * leaves `143` in `$?`. It is computed here rather than left to each caller so
 * that a unit's exit means the same thing in the agent, the backend, the API
 * and the UI — and so that a signalled process is never compared as if it had
 * exited zero.
 */
export function normalizeExit(code: number | null, signal: number | null): number {
  if (signal !== null) return 128 + signal;
  return code ?? 0;
}

/** What is known about a unit at the moment its state is being decided. */
export interface DeriveUnitStateInput {
  /** Its reported exit, or null while it has not ended. */
  exit: ExecutionUnitExit | null;
  /** Whether Aether asked this unit to end. */
  killRequested: boolean;
  /**
   * Whether the process is known to be gone despite not having reported an exit.
   * Only ever set from a positive observation — see `executionUnitLiveness`.
   */
  processMissing?: boolean;
}

/**
 * The state a unit is in, from what has been observed.
 *
 * Kept pure and exported so the rule is testable without spawning anything: the
 * difference between "finished" and "vanished", and between "asked for" and
 * "crashed", is the part of this model most worth being able to assert directly.
 */
export function deriveUnitState(input: DeriveUnitStateInput): ExecutionUnitState {
  const { exit, killRequested } = input;

  if (exit === null) {
    return input.processMissing === true ? 'stale' : 'running';
  }

  // A kill Aether asked for is never reported as a failure, whatever the
  // process's own exit said. `SIGTERM` on a shell that traps it and exits 0
  // would otherwise read as a clean finish, and one that exits 143 would read
  // as a crash.
  if (killRequested) return 'killed';

  return exit.code === 0 && exit.signal === null ? 'exited' : 'failed';
}

/**
 * What is known about whether a unit's process is still there.
 *
 * - `alive` — confirmed running, by identity where the platform allows it.
 * - `gone` — confirmed not running. The only value that may turn a running
 *   record into `stale` or a missing exit into a conclusion.
 * - `unknown` — cannot be determined on this platform or for this process. A
 *   caller must treat this as "no news", and must never report a unit as gone
 *   on it.
 */
export type ExecutionUnitLiveness = 'alive' | 'gone' | 'unknown';

/**
 * Environment variable names a unit may not set, and why each one is here.
 *
 * Two distinct reasons, and both matter:
 *
 * 1. **They would subvert the execution model.** `PATH`, `HOME`, `SHELL`,
 *    `USER`, `LOGNAME`, `PWD` and `IFS` are what `buildShellEnvironment`
 *    derives from the host's own passwd database, and a caller overriding them
 *    would spawn a process that is not the one the model describes. `BASH_ENV`,
 *    `ENV` and `PROMPT_COMMAND` make a shell read a file, `LD_PRELOAD`,
 *    `LD_LIBRARY_PATH` and `LD_AUDIT` make the dynamic linker load code, and
 *    `NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH`, `PERL5OPT`, `RUBYOPT` and
 *    `GEM_HOME` do the same for specific runtimes — each is a way to run code
 *    that was never asked for.
 * 2. **They are names Aether's own processes carry secrets in.** Accepting
 *    `AETHER_*`, `JWT_SECRET`, `DATABASE_URL` or `ENCRYPTION_KEY` would let a
 *    caller plant a value under a name other Aether code trusts.
 *
 * `TERM` and `TZ` are deliberately **absent**: neither is a credential, both
 * are per-unit sensible, and a unit that wants a specific terminal type or
 * timezone should be able to say so.
 */
export const REJECTED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'IFS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5OPT',
  'RUBYOPT',
  'GEM_HOME',
  'JWT_SECRET',
  'DATABASE_URL',
  'ENCRYPTION_KEY',
];

/**
 * Namespaces that are refused as a whole.
 *
 * `AETHER_` is the prefix every one of Aether's own secrets and settings uses —
 * `AETHER_PAIRING_TOKEN`, `AETHER_BACKEND_URL`, `AETHER_WORKSPACE_ROOT` — so
 * refusing the namespace is more durable than refusing today's list of names,
 * and it cannot be outrun by adding a new setting later.
 */
export const REJECTED_ENV_PREFIXES: readonly string[] = ['AETHER_'];

/**
 * The offending names in `env`, or an empty array when it is acceptable.
 *
 * Returns *all* of them rather than the first, so a caller is told everything
 * wrong with a request in one answer instead of one rejection per attempt.
 */
export function findRejectedEnvKeys(env: Record<string, string>): string[] {
  const rejected: string[] = [];
  for (const key of Object.keys(env)) {
    if (REJECTED_ENV_KEYS.includes(key)) {
      rejected.push(key);
      continue;
    }
    if (REJECTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      rejected.push(key);
    }
  }
  return rejected;
}

/**
 * The unit states a terminal session can show.
 *
 * The Terminal's browser contract has four statuses and a large amount of UI
 * already reads it, so the unit's six are projected onto those four rather than
 * widening the contract in the same change that introduces the model. The
 * projection is lossy in exactly one direction and honestly so:
 *
 * | Unit state | Terminal status | Note |
 * | --- | --- | --- |
 * | `starting` | `running` | A unit that has been spawned reads as running to a terminal client. |
 * | `running` | `running` | |
 * | `exited` | `exited` | |
 * | `failed` | `exited` | Non-zero `exitCode` carries the difference. |
 * | `killed` | `killed` | |
 * | `stale` | `exited` | It is gone; the terminal must not show a live shell. |
 *
 * The unit keeps the full vocabulary, so a consumer that needs to tell a crash
 * from a clean exit reads `state` and `exit` from the unit itself rather than
 * from the terminal projection.
 */
export function unitStateToTerminalStatus(state: ExecutionUnitState): TerminalStatus {
  switch (state) {
    case 'starting':
    case 'running':
      return 'running';
    case 'killed':
      return 'killed';
    case 'exited':
    case 'failed':
    case 'stale':
      return 'exited';
  }
}

/** The inverse of the table above, for a terminal status that arrived from elsewhere. */
export function terminalStatusToUnitState(status: TerminalStatus): ExecutionUnitState {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'killed':
      return 'killed';
    case 'exited':
      return 'exited';
  }
}

/**
 * Projects a unit onto the terminal session shape the browser already knows.
 *
 * This is the whole adapter. The Terminal is not a second implementation of
 * anything: it reads units of kind `tty` through this function, which is why a
 * fix to the registry is a fix to the Terminal, and why the two cannot drift.
 */
export function terminalSessionFromUnit(
  unit: ExecutionUnit,
  attachedClients: number
): TerminalSession {
  return {
    id: unit.id,
    pid: unit.process.pid,
    // The resolved shell, not the spec's request: the agent may have fallen back
    // to the allowlist default, and a client showing a shell it is not running
    // would be wrong in a way that matters when something goes wrong.
    shell: unit.spec.shell,
    cwd: unit.spec.cwd,
    cols: unit.spec.cols ?? 80,
    rows: unit.spec.rows ?? 24,
    status: unitStateToTerminalStatus(unit.state),
    exitCode: unit.exit === null ? null : unit.exit.code,
    createdAt: unit.createdAt,
    lastActivityAt: unit.lastActivityAt,
    attachedClients,
  };
}

/** Kinds a unit of this kind is allowed to be restarted into, for validation messages. */
export function isExecutionUnitKind(value: unknown): value is ExecutionUnitKind {
  return typeof value === 'string' && (EXECUTION_UNIT_KINDS as readonly string[]).includes(value);
}

export function isExecutionUnitState(value: unknown): value is ExecutionUnitState {
  return typeof value === 'string' && (EXECUTION_UNIT_STATES as readonly string[]).includes(value);
}
