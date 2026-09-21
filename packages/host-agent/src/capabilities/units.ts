import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TERM,
  LIMITS,
  buildShellArgv,
  buildShellEnvironment,
  deriveUnitState,
  findRejectedEnvKeys,
  isTerminalUnitState,
  normalizeExit,
  type ExecutionUnit,
  type ExecutionUnitKind,
  type ExecutionUnitLiveness,
  type ExecutionUnitLogMode,
  type ExecutionUnitProcessIdentity,
  type ExecutionUnitState,
  type ExecutionUnitExit,
  type RestartPolicy,
} from '@aether/shared';
import { resolveHostIdentity } from '@aether/shared/node';

import {
  ConflictError,
  NotFoundError,
  NotImplementedError,
  ServiceUnavailableError,
  ValidationError,
} from '../errors.js';
import { subsystemLogger } from '../logger.js';
import { getWorkspaceRoot, joinToRoot, resolveExistingPath } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { IPty } from 'node-pty';
import type { ChildProcess } from 'node:child_process';

const log = subsystemLogger('units');

/**
 * The execution-unit registry.
 *
 * Everything Aether starts on a host goes through this file: an interactive
 * shell, a Code Studio run, and — as they arrive — workers, services and
 * deployments. It exists because the alternative was already happening: the
 * terminal had its own session table with its own lifecycle, Code Studio went
 * through that same table with a command, and any new consumer would have had
 * to either reuse a terminal-shaped API or build a third one. Two lifecycle
 * systems that are not the same system will disagree, and the way they disagree
 * is that one of them reports a process as running after the other has ended it.
 *
 * So there is one table, one state machine, one kill path and one log ring.
 * `capabilities/terminal.ts` is a *view* over it — it creates `tty` units and
 * projects them onto the session shape the browser already speaks — and nothing
 * else in the agent keeps process state at all.
 *
 * ## The two spawn paths
 *
 * - **`tty`** — a real pseudo-terminal through `node-pty`. This is what an
 *   interactive shell needs: job control, line editing, `isatty()` true for the
 *   programs inside it, and a window size that can change. Output is one
 *   merged stream, because that is what a terminal is.
 * - **`command`** — a plain child process with piped `stdout` and `stderr` and
 *   a detached process group. No terminal, so the two streams stay separate and
 *   a program does not emit escape sequences at a screen that is not there.
 *   `detached: true` is not about outliving the agent: it puts the child in its
 *   own process group, which is what makes a kill reach the shell *and*
 *   everything the shell started.
 *
 * Both build their argv and environment through `buildShellArgv` /
 * `buildShellEnvironment`, and a test enforces that for every spawn site in the
 * repository. There is no third path, and adding one that improvises an
 * environment fails the suite rather than quietly diverging.
 *
 * ## What this does not do
 *
 * Processes here do not survive the agent: they are children of it, and its
 * PTYs die with it. Nothing in this file claims otherwise, and no unit is
 * reported as running once its process is gone — see `reconcile`.
 */

/** What a unit emits to whoever is watching it. */
export type UnitEvent =
  | { type: 'output'; data: string; stream: 'pty' | 'stdout' | 'stderr' }
  | {
      type: 'exit';
      exitCode: number | null;
      signal: number | null;
      normalized: number;
      state: ExecutionUnitState;
    }
  | { type: 'state'; state: ExecutionUnitState }
  | { type: 'restart'; attempt: number };

export type UnitSubscriber = (event: UnitEvent) => void;

/**
 * A bounded ring of output.
 *
 * Bounded is the whole point: a unit that prints in a loop must not be able to
 * consume the host's memory through the agent. When the ring is full the oldest
 * bytes are dropped and `dropped` records how many, so a reader is told its
 * stream is incomplete rather than silently shown a gap.
 */
interface LogRing {
  chunks: string[];
  /**
   * Which stream each chunk came from, in lockstep with `chunks`.
   *
   * Kept alongside the text rather than inside it so that reading a ring stays
   * a pure byte operation, while a replay can still label a `pipe` unit's
   * output correctly instead of calling every merged chunk `stdout`.
   */
  streams: ('pty' | 'stdout' | 'stderr')[];
  bytes: number;
  dropped: number;
  total: number;
  maxBytes: number;
}

function createRing(maxBytes: number): LogRing {
  return { chunks: [], streams: [], bytes: 0, dropped: 0, total: 0, maxBytes };
}

function appendToRing(ring: LogRing, data: string, stream: 'pty' | 'stdout' | 'stderr'): void {
  const size = Buffer.byteLength(data, 'utf8');
  ring.total += size;

  // A single chunk larger than the whole ring is kept as its own tail: what
  // matters about a burst of output is its end, not its beginning.
  if (size >= ring.maxBytes) {
    const tail = Buffer.from(data, 'utf8').subarray(size - ring.maxBytes).toString('utf8');
    const kept = Buffer.byteLength(tail, 'utf8');
    ring.dropped += ring.bytes + (size - kept);
    ring.chunks = [tail];
    ring.streams = [stream];
    ring.bytes = kept;
    return;
  }

  ring.chunks.push(data);
  ring.streams.push(stream);
  ring.bytes += size;

  while (ring.bytes > ring.maxBytes && ring.chunks.length > 1) {
    const removed = ring.chunks.shift();
    ring.streams.shift();
    if (removed === undefined) break;
    const removedBytes = Buffer.byteLength(removed, 'utf8');
    ring.bytes -= removedBytes;
    ring.dropped += removedBytes;
  }
}

/**
 * Reads `skip` bytes into the ring and returns at most `limit` bytes of it.
 *
 * `skip` is an absolute offset into everything the unit has ever produced, not
 * an index into what is still held — that is what lets a client poll by offset
 * and notice that it fell behind, instead of being handed the tail of a stream
 * it believes is contiguous.
 */
function readRing(
  ring: LogRing,
  skip: number,
  limit: number
): { text: string; missed: number } {
  // Where the retained window starts, in absolute terms.
  const windowStart = ring.total - ring.bytes;
  const missed = Math.max(0, windowStart - skip);
  let remainingSkip = Math.max(0, skip - windowStart);

  const parts: string[] = [];
  let taken = 0;
  for (const chunk of ring.chunks) {
    if (taken >= limit) break;
    let piece = chunk;
    if (remainingSkip > 0) {
      const size = Buffer.byteLength(chunk, 'utf8');
      if (remainingSkip >= size) {
        remainingSkip -= size;
        continue;
      }
      piece = Buffer.from(chunk, 'utf8').subarray(remainingSkip).toString('utf8');
      remainingSkip = 0;
    }

    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (taken + pieceBytes <= limit) {
      parts.push(piece);
      taken += pieceBytes;
    } else {
      parts.push(Buffer.from(piece, 'utf8').subarray(0, limit - taken).toString('utf8'));
      taken = limit;
    }
  }

  return { text: parts.join(''), missed };
}

interface UnitRuntime {
  unit: ExecutionUnit;
  /** Set while a process exists. Exactly one of these is non-null. */
  pty: IPty | null;
  child: ChildProcess | null;
  /** Stops the current process. Sync, and safe to call more than once. */
  terminate: ((signal: NodeJS.Signals) => void) | null;
  write: ((data: string) => void) | null;
  resize: ((cols: number, rows: number) => void) | null;
  subscribers: Set<UnitSubscriber>;
  rings: { combined: LogRing; stdout: LogRing; stderr: LogRing };
  /** True when Aether asked this unit to end — which is what makes `killed` honest. */
  killRequested: boolean;
  /** Resolved when the current process ends, so a restart can wait for it. */
  ended: Promise<void>;
  resolveEnded: (() => void) | null;
  /** How long a finished record is kept, from the config in force when it was made. */
  reapAfterMs: number;
  idleTimer: NodeJS.Timeout | null;
  wallClockTimer: NodeJS.Timeout | null;
  escalateTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  reapTimer: NodeJS.Timeout | null;
}

const units = new Map<string, UnitRuntime>();

/**
 * Signal name to number, for a pipe child.
 *
 * `child_process` reports the signal that ended a process by name, and the
 * normalized exit code needs the number. These are the Linux values; on a
 * platform that numbers them differently the lookup returns null and the exit
 * is reported without a signal rather than with a wrong one.
 */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGTERM: 15,
};

function cloneUnit(unit: ExecutionUnit): ExecutionUnit {
  return {
    ...unit,
    spec: { ...unit.spec, env: { ...unit.spec.env } },
    process: { ...unit.process },
    exit: unit.exit === null ? null : { ...unit.exit },
    restart: { ...unit.restart },
    limits: { ...unit.limits },
    log: { ...unit.log },
  };
}

/* -------------------------------------------------------------------------- */
/* Process identity                                                            */
/* -------------------------------------------------------------------------- */

let cachedBootId: string | null | undefined;

/**
 * The kernel's boot identifier, read once.
 *
 * A pid is only meaningful within one boot. Recording which boot a unit was
 * started in is what lets a record survive a reboot without lying: the pid in
 * it is very likely to exist after a restart, pointing at something else
 * entirely, and only the boot id says so.
 */
export function readBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

/** Test hook: drops the cached boot id so a test can control what it reads. */
export function resetBootIdCacheForTests(): void {
  cachedBootId = undefined;
}

/**
 * Test hook: pins the boot id the liveness check reads.
 *
 * Reboot detection is the mechanism a `stale` reconciliation actually turns on,
 * and it is the one branch of `processLiveness` that is decidable without
 * `/proc` — so pinning a boot id here lets the stale-reconcile test run the same
 * way on a Linux runner and a Windows dev box, rather than depending on whether
 * the host happens to have a `/proc` entry for a made-up pid.
 */
export function setBootIdForTests(value: string | null): void {
  cachedBootId = value;
}

/**
 * Field 22 of `/proc/<pid>/stat`: the process's start time, in clock ticks
 * since boot.
 *
 * Parsed from after the last `)` because field 2 is the executable name in
 * parentheses, and it may itself contain spaces and parentheses. Splitting the
 * line naively is the classic way to read the wrong field for a process whose
 * name has a space in it.
 *
 * The state field (3) is read at the same time: a `Z` is a process that has
 * ended and not been reaped. It is not running, and reporting it as if it were
 * would be reporting a corpse as alive.
 */
export function readProcStat(pid: number): { state: string; startTicks: string } | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return null;
  }

  const close = raw.lastIndexOf(')');
  if (close === -1) return null;

  const fields = raw.slice(close + 2).split(' ');
  const state = fields[0];
  // After `)` come fields 3.., so field 22 is index 19.
  const startTicks = fields[19];
  if (state === undefined || startTicks === undefined) return null;

  return { state, startTicks };
}

/**
 * Whether a unit's recorded process is still the process it was.
 *
 * Returns `unknown` rather than guessing whenever the platform cannot answer —
 * a non-Linux host has no `/proc`, and a hardened one may hide other users'
 * processes. `unknown` is not a licence to report a unit dead or alive; it
 * means the caller keeps what it already believed and says nothing new.
 */
export function processLiveness(identity: ExecutionUnitProcessIdentity): ExecutionUnitLiveness {
  const pid = identity.pid;
  if (pid === null || pid <= 0) return 'gone';

  // A different boot means the machine restarted, so the process cannot be the
  // one this record describes — whatever is on that pid now is something else.
  const bootId = readBootId();
  if (bootId !== null && identity.bootId !== null && bootId !== identity.bootId) {
    return 'gone';
  }

  const stat = readProcStat(pid);
  if (stat !== null) {
    if (stat.state === 'Z') return 'gone';
    if (identity.startTicks !== null && stat.startTicks !== identity.startTicks) {
      // The pid was reused: the process this record names is gone, and this
      // number now belongs to somebody else.
      return 'gone';
    }
    return 'alive';
  }

  // No `/proc` entry. On Linux that is authoritative — the process is gone.
  if (process.platform === 'linux') return 'gone';

  // Elsewhere, fall back to asking the kernel directly.
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as { code?: string }).code;
    // EPERM means it exists and is not ours to signal: alive, not absent.
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* Shell and environment resolution                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the shell to spawn.
 *
 * The requested shell must appear in `TERMINAL_ALLOWED_SHELLS`. Without this
 * allowlist a caller could ask for any executable on the host as the "shell",
 * which would make every other guard here decorative.
 */
export function resolveShell(cfg: AgentConfig, requested?: string, preferred?: string): string {
  const allowed = cfg.TERMINAL_ALLOWED_SHELLS;

  if (requested) {
    if (!allowed.includes(requested)) {
      throw new NotFoundError('Requested shell is not in the allowlist', { shell: requested });
    }
    return requested;
  }

  // The account's login shell from passwd, but only if the allowlist permits
  // it. A service account's shell is often `/usr/sbin/nologin`, which must
  // never be spawned; the allowlist refuses it and the fallback below is used
  // instead — which is why the resolved shell is reported rather than the
  // passwd preference.
  if (preferred && allowed.includes(preferred)) return preferred;

  const fallback = allowed[0];
  if (!fallback) {
    throw new ServiceUnavailableError('No shell is configured for terminal sessions');
  }
  return fallback;
}

/**
 * Where a unit runs when the caller names no directory.
 *
 * A terminal on a real machine opens in the user's home, not at the root of the
 * filesystem. In full-host mode the agent runs as root and that home is
 * `/root`. A confined agent's home can sit outside the workspace root, though,
 * and starting a shell there would put it outside the tree the agent is scoped
 * to — so the root is used instead of escaping.
 *
 * The home comes from the host identity (passwd), not `process.env.HOME`, for
 * the same reason the environment does.
 */
async function defaultCwd(cfg: AgentConfig, root: string, home: string): Promise<string> {
  const relative = path.relative(root, home);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return root;

  try {
    const resolved = await resolveExistingPath(cfg, relative.split(path.sep).join('/'));
    return resolved.exists ? resolved.absolute : root;
  } catch {
    return root;
  }
}

/** The kinds this registry can actually run, as opposed to the kinds the model has. */
const RUNNABLE_KINDS: readonly ExecutionUnitKind[] = ['tty', 'command'];

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export interface UnitRestartOptions {
  policy: RestartPolicy;
  maxAttempts: number;
  backoffMs: number;
}

export interface CreateUnitOptions {
  kind: ExecutionUnitKind;
  /** A command to run under the shell. Required for `command`, optional for `tty`. */
  command?: string | undefined;
  /** Workspace-relative; resolved and contained by the agent. */
  cwd?: string | undefined;
  /**
   * An absolute directory, already resolved and contained.
   *
   * Used only by a restart: the spec records what the working directory
   * resolved to, and re-resolving the original relative request against a
   * workspace root that may since have changed is how a restart lands somewhere
   * other than where the unit was running.
   */
  absoluteCwd?: string | undefined;
  shell?: string | undefined;
  env?: Record<string, string> | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  term?: string | undefined;
  wallClockMs?: number | null | undefined;
  graceMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  restart?: UnitRestartOptions | undefined;
  requestId?: string | null | undefined;
}

function countLiveUnits(ownerUserId?: string): number {
  let count = 0;
  for (const runtime of units.values()) {
    if (isTerminalUnitState(runtime.unit.state)) continue;
    if (ownerUserId !== undefined && runtime.unit.ownerUserId !== ownerUserId) continue;
    count += 1;
  }
  return count;
}

/** The unit a repeated request already produced, if there is one. */
function findByRequestId(ownerUserId: string, requestId: string): UnitRuntime | null {
  for (const runtime of units.values()) {
    if (runtime.unit.ownerUserId === ownerUserId && runtime.unit.requestId === requestId) {
      return runtime;
    }
  }
  return null;
}

export async function createUnit(
  cfg: AgentConfig,
  ownerUserId: string,
  options: CreateUnitOptions
): Promise<ExecutionUnit> {
  // Remembered before anything can fail: the idle and limit timers fire outside
  // any request, and a timer with no config cannot act.
  rememberConfig(cfg);

  if (!cfg.EXECUTION_ENABLED) {
    throw new ServiceUnavailableError('Execution is disabled on this instance');
  }

  // An idempotency token names one intent. A retried request — a dropped reply,
  // a doubled click — must not leave two shells running, so the second call
  // gets the first call's unit back. If that unit has already ended it is
  // returned as it is: "this request produced this, and it has finished" is the
  // honest answer, not a second process.
  if (options.requestId) {
    const existing = findByRequestId(ownerUserId, options.requestId);
    if (existing) return cloneUnit(existing.unit);
  }

  if (countLiveUnits(ownerUserId) >= cfg.EXECUTION_MAX_UNITS_PER_USER) {
    throw new ConflictError('You have reached your execution unit limit', {
      limit: cfg.EXECUTION_MAX_UNITS_PER_USER,
    });
  }
  if (countLiveUnits() >= cfg.EXECUTION_MAX_UNITS_GLOBAL) {
    throw new ConflictError('This host has reached its execution unit limit', {
      limit: cfg.EXECUTION_MAX_UNITS_GLOBAL,
    });
  }

  assertSpawnable(cfg, options);

  const id = randomUUID();
  const now = new Date().toISOString();

  const runtime: UnitRuntime = {
    unit: {
      id,
      ownerUserId,
      kind: options.kind,
      agentId: cfg.AETHER_AGENT_ID,
      // Filled in by the first spawn; `spawnInto` is the only writer, so a
      // restart replaces it with what it actually resolved rather than what was
      // asked for.
      spec: {
        kind: options.kind,
        shell: '',
        cwd: '',
        env: {},
        tty: options.kind === 'tty',
        cols: options.kind === 'tty' ? (options.cols ?? 80) : null,
        rows: options.kind === 'tty' ? (options.rows ?? 24) : null,
        term: options.term ?? null,
        logMode: options.kind === 'tty' ? 'pty' : 'pipe',
        ...(options.command !== undefined ? { command: options.command } : {}),
      },
      state: 'starting',
      process: { pid: null, pgid: null, startTicks: null, bootId: null },
      exit: null,
      restart: {
        policy: options.restart?.policy ?? 'never',
        maxAttempts: options.restart?.maxAttempts ?? 0,
        backoffMs: options.restart?.backoffMs ?? 1_000,
        attempts: 0,
      },
      limits: {
        wallClockMs: options.wallClockMs ?? null,
        graceMs: options.graceMs ?? cfg.EXECUTION_GRACE_MS,
        maxOutputBytes: options.maxOutputBytes ?? cfg.EXECUTION_LOG_MAX_BYTES,
        exceeded: null,
      },
      log: { mode: 'pty', retainedBytes: 0, droppedBytes: 0, totalBytes: 0 },
      createdAt: now,
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
      requestId: options.requestId ?? null,
    },
    pty: null,
    child: null,
    terminate: null,
    write: null,
    resize: null,
    subscribers: new Set(),
    rings: {
      combined: createRing(options.maxOutputBytes ?? cfg.EXECUTION_LOG_MAX_BYTES),
      stdout: createRing(options.maxOutputBytes ?? cfg.EXECUTION_LOG_MAX_BYTES),
      stderr: createRing(options.maxOutputBytes ?? cfg.EXECUTION_LOG_MAX_BYTES),
    },
    killRequested: false,
    ended: Promise.resolve(),
    resolveEnded: null,
    reapAfterMs: cfg.EXECUTION_REAP_AFTER,
    idleTimer: null,
    wallClockTimer: null,
    escalateTimer: null,
    restartTimer: null,
    reapTimer: null,
  };

  units.set(id, runtime);

  try {
    await spawnInto(cfg, runtime, options, false);
  } catch (error) {
    // A unit that never spawned must not occupy the table or a slot: the caller
    // is being told it failed, and a record left behind would count against
    // their limit for a process that does not exist.
    clearTimers(runtime);
    units.delete(id);
    throw error;
  }

  log.info(
    { unitId: id, kind: runtime.unit.kind, pid: runtime.unit.process.pid, ownerUserId },
    'execution unit created'
  );
  return cloneUnit(runtime.unit);
}

/**
 * Everything that must be true before a process is spawned.
 *
 * Separated from `createUnit` so the checks read as one list and so a negative
 * test can drive them directly: each of these is a refusal that has to happen
 * *before* anything is started, because a check that runs after the spawn is a
 * check that has already failed to stop it.
 */
function assertSpawnable(cfg: AgentConfig, options: CreateUnitOptions): void {
  if (!RUNNABLE_KINDS.includes(options.kind)) {
    // NOT_IMPLEMENTED, not SERVICE_UNAVAILABLE: the difference is honest. A
    // service is not temporarily down — Aether has no supervisor for it yet, and
    // will not until the P-later work lands. Reporting 503 would invite a retry
    // that can never succeed; 501 says the capability does not exist. Refusing
    // here rather than starting something nothing will look after is the §40
    // rule (prefer NOT IMPLEMENTED over fake success) at the spawn boundary.
    throw new NotImplementedError(
      `A unit of kind "${options.kind}" cannot be run yet: Aether has no supervisor for it.`,
      { kind: options.kind, runnableKinds: [...RUNNABLE_KINDS] }
    );
  }

  if (options.kind === 'command' && (options.command === undefined || options.command === '')) {
    throw new ValidationError('A unit of kind "command" must be given a command to run', {
      kind: options.kind,
    });
  }

  if (options.kind === 'tty' && options.command === undefined && !cfg.TERMINAL_ENABLED) {
    throw new ServiceUnavailableError('Terminal access is disabled on this instance');
  }

  const rejected = findRejectedEnvKeys(options.env ?? {});
  if (rejected.length > 0) {
    throw new ValidationError(
      `These environment variables may not be set on a unit: ${rejected.join(', ')}`,
      { rejected }
    );
  }

  if (options.env !== undefined && Object.keys(options.env).length > 64) {
    throw new ValidationError('At most 64 environment variables may be set on one unit');
  }

  const wallClockMs = options.wallClockMs ?? null;
  if (wallClockMs !== null && wallClockMs > cfg.EXECUTION_WALL_CLOCK_MAX_MS) {
    throw new ValidationError(
      `A wall-clock limit may not exceed ${String(cfg.EXECUTION_WALL_CLOCK_MAX_MS)} ms on this host`,
      { maximum: cfg.EXECUTION_WALL_CLOCK_MAX_MS }
    );
  }

  const maxOutputBytes = options.maxOutputBytes ?? cfg.EXECUTION_LOG_MAX_BYTES;
  if (maxOutputBytes > cfg.EXECUTION_LOG_MAX_BYTES) {
    throw new ValidationError(
      `Retained output may not exceed ${String(cfg.EXECUTION_LOG_MAX_BYTES)} bytes on this host`,
      { maximum: cfg.EXECUTION_LOG_MAX_BYTES, requested: maxOutputBytes }
    );
  }
}

/** Resolves the spec and starts a process for `runtime`. */
async function spawnInto(
  cfg: AgentConfig,
  runtime: UnitRuntime,
  options: CreateUnitOptions,
  isRestart: boolean
): Promise<void> {
  const root = await getWorkspaceRoot(cfg);
  const identity = resolveHostIdentity();

  let cwd = await defaultCwd(cfg, root, identity.home);
  if (options.absoluteCwd !== undefined) {
    // A restart, which already holds the resolved directory. Contained again
    // rather than trusted: the workspace root is the boundary, and a spec is
    // data that came off the wire at some point.
    cwd = options.absoluteCwd;
  } else if (options.cwd) {
    const resolved = await resolveExistingPath(cfg, options.cwd);
    if (!resolved.exists) {
      throw new NotFoundError('Working directory does not exist', { path: options.cwd });
    }
    cwd = resolved.absolute;
  }

  const shell = resolveShell(cfg, options.shell, identity.shell);

  const mode: ExecutionUnitLogMode = options.kind === 'tty' ? 'pty' : 'pipe';
  const now = new Date().toISOString();

  runtime.killRequested = false;
  runtime.unit.spec = {
    kind: options.kind,
    shell,
    cwd,
    env: { ...(options.env ?? {}) },
    tty: options.kind === 'tty',
    cols: options.kind === 'tty' ? (options.cols ?? runtime.unit.spec.cols ?? 80) : null,
    rows: options.kind === 'tty' ? (options.rows ?? runtime.unit.spec.rows ?? 24) : null,
    term: options.term ?? runtime.unit.spec.term,
    logMode: mode,
    ...(options.command !== undefined ? { command: options.command } : {}),
  };
  runtime.unit.log = {
    mode,
    retainedBytes: 0,
    droppedBytes: 0,
    totalBytes: runtime.unit.log.totalBytes,
  };
  runtime.unit.exit = null;
  runtime.unit.state = 'starting';
  runtime.unit.startedAt = now;
  runtime.unit.lastActivityAt = now;
  runtime.unit.endedAt = null;

  if (isRestart) {
    runtime.unit.restart.attempts += 1;
  }

  runtime.ended = new Promise<void>((resolve) => {
    runtime.resolveEnded = resolve;
  });

  if (mode === 'pty') {
    const pty = await loadPty();
    // Both spawn sites below name `buildShellArgv` and `buildShellEnvironment`
    // in their own argument list rather than reaching for a value computed
    // earlier. That is deliberate: the one-model test reads the call site, and
    // a test that cannot see the argument it is checking stops checking
    // anything the moment somebody extracts a local. The two copies cannot
    // diverge in behaviour, because neither is executed by the same unit.
    //
    // The allowlist matters most here: the agent's pairing token lives in this
    // process's environment, and a shell running as the same user could read it
    // with a single `env`.
    const child = pty.spawn(
      shell,
      buildShellArgv(options.command),
      {
        name: options.term ?? DEFAULT_TERM,
        cols: runtime.unit.spec.cols ?? 80,
        rows: runtime.unit.spec.rows ?? 24,
        cwd,
        env: {
          ...buildShellEnvironment({ ...identity, shell }, { cwd, ambient: process.env }),
          ...(options.term !== undefined ? { TERM: options.term } : {}),
          ...(options.env ?? {}),
        },
      }
    );

    runtime.pty = child;
    runtime.unit.process = describeProcess(child.pid);
    runtime.unit.state = 'running';
    armWallClock(runtime);

    runtime.write = (data: string) => {
      child.write(data);
    };
    runtime.resize = (cols: number, rows: number) => {
      child.resize(cols, rows);
      runtime.unit.spec.cols = cols;
      runtime.unit.spec.rows = rows;
    };
    // node-pty sends SIGHUP to the terminal's foreground process group, which is
    // the job-control semantics an interactive shell expects. Reaching for the
    // process group by hand here would be a second, worse implementation of it.
    runtime.terminate = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch (error) {
        log.warn({ err: error, unitId: runtime.unit.id }, 'failed to signal pty process');
      }
    };

    child.onData((data) => {
      applyOutput(runtime, data, 'pty');
    });

    child.onExit(({ exitCode, signal }) => {
      finishUnit(runtime, {
        code: typeof exitCode === 'number' ? exitCode : null,
        signal: typeof signal === 'number' ? signal : null,
      });
    });

    return;
  }

  const child = spawnProcess(shell, buildShellArgv(options.command), {
    cwd,
    env: {
      ...buildShellEnvironment({ ...identity, shell }, { cwd, ambient: process.env }),
      ...(options.term !== undefined ? { TERM: options.term } : {}),
      ...(options.env ?? {}),
    },
    // A group of its own, so one signal reaches the shell and its children.
    // Not about outliving the agent: this process's lifetime is the agent's.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  runtime.child = child;

  // The child is a group leader by construction, so its group id is its pid.
  runtime.unit.process = describeProcess(child.pid ?? null);
  runtime.unit.state = 'running';
  armWallClock(runtime);

  runtime.write = null;
  runtime.resize = null;
  runtime.terminate = (signal: NodeJS.Signals) => {
    terminateProcessGroup(runtime, signal);
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (data: string) => {
    applyOutput(runtime, data, 'stdout');
  });
  child.stderr?.on('data', (data: string) => {
    applyOutput(runtime, data, 'stderr');
  });

  child.on('error', (error: Error) => {
    // A spawn failure that arrives after the process was recorded — a missing
    // interpreter, an EACCES — ends the unit as a failure rather than leaving a
    // record that claims to be running.
    log.warn({ err: error, unitId: runtime.unit.id }, 'execution unit process error');
    finishUnit(runtime, { code: null, signal: null }, error.message);
  });

  child.on('exit', (code: number | null, signalName: NodeJS.Signals | null) => {
    finishUnit(runtime, {
      code,
      signal: signalName === null ? null : (SIGNAL_NUMBERS[signalName] ?? null),
    });
  });
}

/**
 * Which process a unit is, with identity.
 *
 * `bootId` and `startTicks` are read at spawn time, when the process is
 * certainly alive, so later comparisons have something true to compare against.
 */
function describeProcess(pid: number | null): ExecutionUnitProcessIdentity {
  if (pid === null || pid <= 0) {
    return { pid: null, pgid: null, startTicks: null, bootId: null };
  }

  const stat = readProcStat(pid);
  return {
    pid,
    // Both spawn paths make the child a group leader: `node-pty` calls `setsid`,
    // and `detached: true` calls `setpgid`. That equality is what makes the
    // group killable by pid, and it is why it is recorded rather than assumed.
    pgid: pid,
    startTicks: stat?.startTicks ?? null,
    bootId: readBootId(),
  };
}

/**
 * Sends a signal to the unit's process group, after checking the group is still
 * the unit's.
 *
 * `kill(-pgid)` on a number that has been reused would signal a stranger's
 * entire process group, which is the worst thing this file could do. So the
 * leader is identified first: confirmed alive means the group is ours, gone
 * means there is nothing to signal, and *unknown* — a host with no `/proc` —
 * falls back to the child handle, which can only ever reach this unit's own
 * process. Narrower than a group kill, and the correct default when identity
 * cannot be established.
 */
function terminateProcessGroup(runtime: UnitRuntime, signal: NodeJS.Signals): void {
  const { pid, pgid } = runtime.unit.process;
  const child = runtime.child;

  const liveness = processLiveness(runtime.unit.process);
  if (liveness === 'gone') return;

  if (liveness === 'unknown') {
    try {
      child?.kill(signal);
    } catch (error) {
      log.warn({ err: error, unitId: runtime.unit.id }, 'failed to signal unit process');
    }
    return;
  }

  const target = pgid ?? pid;
  if (target === null || target <= 0) return;

  if (process.platform === 'win32') {
    // No process groups to signal; the direct child is all there is.
    try {
      child?.kill(signal);
    } catch (error) {
      log.warn({ err: error, unitId: runtime.unit.id }, 'failed to signal unit process');
    }
    return;
  }

  try {
    // A negative pid means "the process group with this id".
    process.kill(-target, signal);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ESRCH') {
      log.warn({ err: error, unitId: runtime.unit.id }, 'failed to signal unit process group');
    }
  }
}

/** Records output, fans it out to subscribers, and restarts the idle clock. */
function applyOutput(runtime: UnitRuntime, data: string, stream: 'pty' | 'stdout' | 'stderr'): void {
  appendToRing(runtime.rings.combined, data, stream);
  if (stream === 'stdout') appendToRing(runtime.rings.stdout, data, stream);
  if (stream === 'stderr') appendToRing(runtime.rings.stderr, data, stream);

  runtime.unit.log.retainedBytes = runtime.rings.combined.bytes;
  runtime.unit.log.droppedBytes = runtime.rings.combined.dropped;
  runtime.unit.log.totalBytes = runtime.rings.combined.total;
  runtime.unit.lastActivityAt = new Date().toISOString();

  broadcast(runtime, { type: 'output', data, stream });
  touchIdle(runtime);
}

function broadcast(runtime: UnitRuntime, event: UnitEvent): void {
  for (const subscriber of runtime.subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      log.warn({ err: error, unitId: runtime.unit.id }, 'execution unit subscriber threw');
    }
  }
}

/**
 * The single place a process's end is recorded.
 *
 * Everything that can end a process — its own exit, an error, a kill, a
 * liveness sweep — arrives here, so the unit moves to exactly one state and
 * every consumer sees the same event. `crash` is not a state a caller can
 * choose: it is derived from the exit, from whether Aether asked for it, and
 * from whether the process was ever there at all.
 */
function finishUnit(
  runtime: UnitRuntime,
  raw: { code: number | null; signal: number | null },
  errorDetail?: string
): void {
  const unit = runtime.unit;
  if (isTerminalUnitState(unit.state)) return;

  const at = new Date().toISOString();
  const exit: ExecutionUnitExit = {
    code: raw.code,
    signal: raw.signal,
    normalized: normalizeExit(raw.code, raw.signal),
    at,
  };

  unit.exit = exit;
  unit.state = deriveUnitState({ exit, killRequested: runtime.killRequested });
  unit.process = { pid: null, pgid: null, startTicks: null, bootId: null };
  unit.endedAt = at;

  clearTimers(runtime, { keepReap: true });
  runtime.pty = null;
  runtime.child = null;
  runtime.terminate = null;
  runtime.write = null;
  runtime.resize = null;
  runtime.resolveEnded?.();
  runtime.resolveEnded = null;

  if (errorDetail !== undefined) {
    // The process never ran, so there is no output to have explained it. The
    // detail goes into the stream a client is already reading, which is where
    // someone looking at a failed unit is looking.
    const line = `aether: ${errorDetail}\n`;
    appendToRing(runtime.rings.combined, line, 'stderr');
    appendToRing(runtime.rings.stderr, line, 'stderr');
    broadcast(runtime, { type: 'output', data: line, stream: 'stderr' });
  }

  broadcast(runtime, {
    type: 'exit',
    exitCode: raw.code,
    signal: raw.signal,
    normalized: exit.normalized,
    state: unit.state,
  });

  log.info(
    { unitId: unit.id, state: unit.state, code: raw.code, signal: raw.signal },
    'execution unit ended'
  );

  scheduleReap(runtime);
  maybeAutoRestart(runtime);
}

/** A finished unit is kept long enough for a client to read how it ended. */
function scheduleReap(runtime: UnitRuntime): void {
  clearReap(runtime);
  runtime.reapTimer = setTimeout(() => {
    units.delete(runtime.unit.id);
    log.debug({ unitId: runtime.unit.id }, 'execution unit record forgotten');
  }, runtime.reapAfterMs);
  runtime.reapTimer.unref();
}

function clearReap(runtime: UnitRuntime): void {
  if (runtime.reapTimer) clearTimeout(runtime.reapTimer);
  runtime.reapTimer = null;
}

function clearTimers(runtime: UnitRuntime, options: { keepReap?: boolean } = {}): void {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.wallClockTimer) clearTimeout(runtime.wallClockTimer);
  if (runtime.escalateTimer) clearTimeout(runtime.escalateTimer);
  if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
  runtime.idleTimer = null;
  runtime.wallClockTimer = null;
  runtime.escalateTimer = null;
  runtime.restartTimer = null;
  if (options.keepReap !== true) clearReap(runtime);
}

/**
 * A unit that ends by itself and is allowed to be restarted is restarted.
 *
 * The policy is checked against the *derived* state, so `on-failure` restarts a
 * crash and not a clean exit, and a unit Aether killed is never restarted —
 * restarting something an operator just stopped is the classic way a supervisor
 * becomes impossible to stop.
 */
function maybeAutoRestart(runtime: UnitRuntime): void {
  const { policy, maxAttempts, backoffMs, attempts } = runtime.unit.restart;
  if (policy === 'never' || attempts >= maxAttempts) return;

  const state = runtime.unit.state;
  const shouldRestart =
    policy === 'always' ? state === 'exited' || state === 'failed' : state === 'failed';
  if (!shouldRestart) return;

  const cfg = currentConfig;
  if (cfg === null) return;

  runtime.restartTimer = setTimeout(() => {
    runtime.restartTimer = null;
    void respawn(cfg, runtime, 'automatic').catch((error: unknown) => {
      log.warn({ err: error, unitId: runtime.unit.id }, 'automatic restart failed');
      finishUnit(runtime, { code: null, signal: null }, 'restart failed');
    });
  }, backoffMs);
  runtime.restartTimer.unref();

  broadcast(runtime, { type: 'restart', attempt: attempts + 1 });
}

/**
 * The configuration the registry was last used with.
 *
 * Timers fire outside any request, so an automatic restart has no config
 * argument to be given — and it needs one to spawn. Storing it here is the
 * smallest way to make a timer able to act, and it is set on every entry point
 * so it cannot be stale for long.
 */
let currentConfig: AgentConfig | null = null;

function rememberConfig(cfg: AgentConfig): void {
  currentConfig = cfg;
}

async function respawn(
  cfg: AgentConfig,
  runtime: UnitRuntime,
  trigger: 'automatic' | 'requested'
): Promise<void> {
  rememberConfig(cfg);

  const unit = runtime.unit;
  const previousAttempts = unit.restart.attempts;
  // The resolved directory from the last spawn, so a restart lands where the
  // unit was running rather than where a re-resolution would put it.
  const resolvedCwd = unit.spec.cwd;

  clearReap(runtime);

  // The spec of the last spawn is the instruction for the next one, so a
  // restart reproduces what was actually running — including the shell the
  // allowlist resolved — rather than re-deriving it from a request that is no
  // longer in hand.
  await spawnInto(
    cfg,
    runtime,
    {
      kind: unit.kind,
      absoluteCwd: resolvedCwd,
      shell: unit.spec.shell,
      env: unit.spec.env,
      cols: unit.spec.cols ?? undefined,
      rows: unit.spec.rows ?? undefined,
      term: unit.spec.term ?? undefined,
      wallClockMs: unit.limits.wallClockMs,
      graceMs: unit.limits.graceMs,
      maxOutputBytes: unit.limits.maxOutputBytes,
      ...(unit.spec.command !== undefined ? { command: unit.spec.command } : {}),
    },
    true
  );

  // A requested restart does not consume the automatic-restart budget: the
  // policy bounds what Aether does on its own, and an operator asking for a
  // restart has not used any of it.
  if (trigger === 'requested') unit.restart.attempts = previousAttempts;

  log.info({ unitId: unit.id, trigger, pid: unit.process.pid }, 'execution unit restarted');
}

/* -------------------------------------------------------------------------- */
/* The pty module                                                              */
/* -------------------------------------------------------------------------- */

let ptyModule: typeof import('node-pty') | null = null;
let ptyLoadError: Error | null = null;

async function loadPty(): Promise<typeof import('node-pty')> {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw ptyLoadError;

  try {
    ptyModule = await import('node-pty');
    return ptyModule;
  } catch (error) {
    ptyLoadError = error instanceof Error ? error : new Error(String(error));
    log.error({ err: ptyLoadError }, 'node-pty native module could not be loaded');
    throw new ServiceUnavailableError(
      'Terminal support is unavailable: the node-pty native module failed to load on this host.',
      { reason: ptyLoadError.message }
    );
  }
}

/** True when the PTY backend loaded successfully. Used by `/health` and the UI. */
export function isPtyAvailable(): boolean {
  return ptyLoadError === null;
}

/** Test hook: forgets a failed PTY load so a test can assert the retry path. */
export function resetPtyLoadForTests(): void {
  ptyModule = null;
  ptyLoadError = null;
}

/* -------------------------------------------------------------------------- */
/* Timers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Restarts the idle clock on a `tty` unit.
 *
 * Only interactive units: a shell nobody has typed into and nobody is attached
 * to is one nobody is coming back for, while a `command` unit that prints
 * nothing for an hour is a build that is working. `command` units are bounded
 * by `wallClockMs`, which is the honest bound for them.
 */
function touchIdle(runtime: UnitRuntime): void {
  if (runtime.unit.kind !== 'tty') return;
  const cfg = currentConfig;
  if (cfg === null) return;

  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  runtime.idleTimer = setTimeout(() => {
    log.info({ unitId: runtime.unit.id }, 'execution unit idle timeout reached');
    void endUnit(runtime, 'idle_timeout');
  }, cfg.EXECUTION_IDLE_TIMEOUT);
  runtime.idleTimer.unref();
}

function armWallClock(runtime: UnitRuntime): void {
  if (runtime.unit.limits.wallClockMs === null) return;
  runtime.wallClockTimer = setTimeout(() => {
    runtime.unit.limits.exceeded = 'wall_clock';
    log.info(
      { unitId: runtime.unit.id, wallClockMs: runtime.unit.limits.wallClockMs },
      'execution unit wall-clock limit reached'
    );
    void endUnit(runtime, 'wall_clock_limit');
  }, runtime.unit.limits.wallClockMs);
  runtime.wallClockTimer.unref();
}

/* -------------------------------------------------------------------------- */
/* Ending a unit                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Asks a unit to end, without waiting for it to.
 *
 * Synchronous on purpose: the signal goes out before this returns, which is
 * what lets a shutdown path — where awaiting is a luxury the process may not
 * have — be sure the `SIGTERM` was sent. `endUnit` awaits the result.
 */
function requestEnd(runtime: UnitRuntime, reason: string): void {
  if (isTerminalUnitState(runtime.unit.state)) return;

  runtime.killRequested = true;
  const terminated = runtime.terminate;
  if (terminated === null) {
    finishUnit(runtime, { code: null, signal: null });
    return;
  }

  terminated('SIGTERM');

  if (runtime.escalateTimer) clearTimeout(runtime.escalateTimer);
  runtime.escalateTimer = setTimeout(() => {
    runtime.escalateTimer = null;
    log.info({ unitId: runtime.unit.id, reason }, 'execution unit did not exit in time; killing');
    runtime.terminate?.('SIGKILL');
  }, runtime.unit.limits.graceMs);
  runtime.escalateTimer.unref();
}

/**
 * Ends a unit: ask first, insist after the grace period.
 *
 * `SIGTERM` then `SIGKILL` rather than an immediate `SIGKILL`, because a
 * process that is given the chance to shut down cleanly usually takes it — a
 * dev server flushes, a build writes its output — and killing that off by
 * default would make Aether the reason the work was lost. The escalation is
 * what makes the grace period a delay rather than a hope.
 */
async function endUnit(runtime: UnitRuntime, reason: string): Promise<void> {
  if (isTerminalUnitState(runtime.unit.state)) return;

  const ended = runtime.ended;
  requestEnd(runtime, reason);
  await ended;

  if (runtime.escalateTimer) {
    clearTimeout(runtime.escalateTimer);
    runtime.escalateTimer = null;
  }
}

/** Ends a unit and waits for it, as the public verbs do. */
export async function endOwnedUnit(
  unitId: string,
  ownerUserId: string,
  reason: string
): Promise<boolean> {
  const runtime = ownedOrNull(unitId, ownerUserId);
  // A unit owned by someone else and a unit that never existed both answer
  // `false`: an id held by a caller must not reveal that somebody else's unit
  // exists. Same rule as `getUnit`.
  if (!runtime) return false;

  await endUnit(runtime, reason);
  return true;
}

/** Ends every unit owned by a user. Used on logout and account disable. */
export async function endUnitsForUser(userId: string, reason: string): Promise<number> {
  let ended = 0;
  for (const runtime of [...units.values()]) {
    if (runtime.unit.ownerUserId !== userId) continue;
    await endUnit(runtime, reason);
    ended += 1;
  }
  return ended;
}

/** Ends every unit. Used during graceful shutdown so no child outlives the agent. */
export async function endAllUnits(reason: string): Promise<number> {
  const runtimes = [...units.values()];
  await Promise.all(runtimes.map((runtime) => endUnit(runtime, reason)));
  return runtimes.length;
}

/**
 * Asks every unit to end and returns at once.
 *
 * The shutdown path uses this: a process on its way out must not wait on a
 * child that may ignore `SIGTERM`, and the escalation timer it arms is enough
 * to make sure nothing is left behind if the process does linger.
 */
export function requestEndAllUnits(reason: string): number {
  let ended = 0;
  for (const runtime of units.values()) {
    if (isTerminalUnitState(runtime.unit.state)) continue;
    requestEnd(runtime, reason);
    ended += 1;
  }
  return ended;
}

/** Asks every unit owned by a user to end and returns at once. Used on logout. */
export function requestEndUnitsForUser(userId: string, reason: string): number {
  let ended = 0;
  for (const runtime of units.values()) {
    if (runtime.unit.ownerUserId !== userId) continue;
    if (isTerminalUnitState(runtime.unit.state)) continue;
    requestEnd(runtime, reason);
    ended += 1;
  }
  return ended;
}

/**
 * Asks one unit to end, without an owner.
 *
 * The internal path: shutdown, logout and the terminal's own teardown act on
 * units nobody is asking about on behalf of a user. A request from the wire
 * goes through `endOwnedUnit`, which checks ownership first.
 */
export function requestEndUnitUnscoped(unitId: string, reason: string): boolean {
  const runtime = units.get(unitId);
  if (!runtime || isTerminalUnitState(runtime.unit.state)) return false;
  requestEnd(runtime, reason);
  return true;
}

/** True when a unit is in a state it will not leave. */
export function isUnitEnded(unitId: string): boolean {
  const runtime = units.get(unitId);
  return runtime === undefined || isTerminalUnitState(runtime.unit.state);
}

/**
 * True when an end has been requested for this unit but no end has arrived yet.
 *
 * The gap this closes is the SIGTERM window. A process sent SIGTERM is still
 * genuinely there, so its state is still `running` and it would be a lie to say
 * otherwise — but a consumer that listed it would show, and in the backend's
 * case re-adopt, a session that somebody has just deliberately ended. "Running"
 * and "on its way out" are two different facts and both are needed.
 */
export function isUnitEnding(unitId: string): boolean {
  const runtime = units.get(unitId);
  if (runtime === undefined) return false;
  return runtime.killRequested && !isTerminalUnitState(runtime.unit.state);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

function ownedOrNull(unitId: string, ownerUserId: string): UnitRuntime | null {
  const runtime = units.get(unitId);
  if (!runtime || runtime.unit.ownerUserId !== ownerUserId) return null;
  return runtime;
}

function requireOwned(unitId: string, ownerUserId: string): UnitRuntime {
  const runtime = ownedOrNull(unitId, ownerUserId);
  if (!runtime) {
    // 404 rather than 403: whether someone else's unit exists is not this
    // caller's business, and distinguishing them would be a directory of other
    // people's processes.
    throw new NotFoundError('Execution unit does not exist', { unitId });
  }
  return runtime;
}

/**
 * Brings a unit's state in line with the process table before it is reported.
 *
 * The one thing this model must never do is call a process running after it has
 * gone. A process normally reports its own exit, but not always: a `SIGKILL`
 * from outside, an OOM kill, or a supervisor's `cgroup` sweep all leave a
 * record that believes it is running. So a unit that believes it is running is
 * checked against the process table, and a process that is positively gone
 * becomes `stale` — not `exited`, because it did not finish, and not `running`,
 * because that would be false.
 */
export function reconcileUnit(runtime: UnitRuntime): void {
  const unit = runtime.unit;
  if (isTerminalUnitState(unit.state) || unit.state === 'starting') return;
  if (unit.process.pid === null) return;

  if (processLiveness(unit.process) !== 'gone') return;

  log.warn(
    { unitId: unit.id, pid: unit.process.pid },
    'execution unit process is gone without having reported an exit'
  );

  const at = new Date().toISOString();
  unit.state = deriveUnitState({ exit: null, killRequested: false, processMissing: true });
  unit.process = { pid: null, pgid: null, startTicks: null, bootId: null };
  unit.endedAt = at;
  clearTimers(runtime, { keepReap: true });
  runtime.pty = null;
  runtime.child = null;
  runtime.terminate = null;
  runtime.write = null;
  runtime.resize = null;
  runtime.resolveEnded?.();
  runtime.resolveEnded = null;

  broadcast(runtime, { type: 'state', state: unit.state });
  scheduleReap(runtime);
}

/** Reconciles every held unit. Returns how many were found gone. */
export function reconcileAllUnits(): number {
  let gone = 0;
  for (const runtime of units.values()) {
    const before = runtime.unit.state;
    reconcileUnit(runtime);
    if (before !== runtime.unit.state) gone += 1;
  }
  return gone;
}

export interface ListUnitsOptions {
  /** Null lists every user's units; that is a privileged request, checked upstream. */
  ownerUserId: string | null;
  kind?: ExecutionUnitKind | undefined;
}

export function listUnits(options: ListUnitsOptions): ExecutionUnit[] {
  reconcileAllUnits();

  const result: ExecutionUnit[] = [];
  for (const runtime of units.values()) {
    const unit = runtime.unit;
    if (options.ownerUserId !== null && unit.ownerUserId !== options.ownerUserId) continue;
    if (options.kind !== undefined && unit.kind !== options.kind) continue;
    result.push(cloneUnit(unit));
  }
  return result;
}

export function getUnit(unitId: string, ownerUserId: string): ExecutionUnit {
  return cloneUnit(requireOwned(unitId, ownerUserId).unit);
}

/** An unowned read, for the backend's own reconciliation. Never exposed to a user. */
export function getUnitUnscoped(unitId: string): ExecutionUnit | null {
  const runtime = units.get(unitId);
  if (!runtime) return null;
  reconcileUnit(runtime);
  return cloneUnit(runtime.unit);
}

export function unitStats(cfg: AgentConfig): {
  active: number;
  total: number;
  available: boolean;
  maxPerUser: number;
  maxGlobal: number;
} {
  rememberConfig(cfg);
  let active = 0;
  for (const runtime of units.values()) {
    if (!isTerminalUnitState(runtime.unit.state)) active += 1;
  }
  return {
    active,
    total: units.size,
    available: cfg.EXECUTION_ENABLED && isPtyAvailable(),
    maxPerUser: cfg.EXECUTION_MAX_UNITS_PER_USER,
    maxGlobal: cfg.EXECUTION_MAX_UNITS_GLOBAL,
  };
}

/* -------------------------------------------------------------------------- */
/* Driving                                                                     */
/* -------------------------------------------------------------------------- */

export function writeUnitInput(unitId: string, ownerUserId: string, data: string): void {
  const runtime = requireOwned(unitId, ownerUserId);
  if (runtime.write === null) {
    throw new ConflictError('This unit has no terminal to write to', { unitId });
  }
  runtime.unit.lastActivityAt = new Date().toISOString();
  runtime.write(data);
  touchIdle(runtime);
}

export function resizeUnit(unitId: string, ownerUserId: string, cols: number, rows: number): void {
  const runtime = requireOwned(unitId, ownerUserId);
  if (runtime.resize === null) {
    throw new ConflictError('This unit has no terminal to resize', { unitId });
  }
  runtime.resize(cols, rows);
}

export interface SignalResult {
  delivered: boolean;
  /** True when the polite signal was not enough and SIGKILL followed. */
  escalated: boolean;
}

/**
 * Signals a unit's process group.
 *
 * `escalateAfterMs` is opt-in because escalation is a real escalation: it takes
 * away the process's chance to clean up. A caller that asks for it is saying it
 * would rather the process were gone than graceful.
 */
export async function signalUnit(
  unitId: string,
  ownerUserId: string,
  signal: NodeJS.Signals,
  escalateAfterMs: number | null
): Promise<SignalResult> {
  const runtime = requireOwned(unitId, ownerUserId);

  if (isTerminalUnitState(runtime.unit.state)) {
    // Signalling something that has ended is not an error worth an exception —
    // the goal state is already reached — but it is not "delivered" either.
    return { delivered: false, escalated: false };
  }

  if (signal === 'SIGKILL') {
    runtime.killRequested = true;
  }

  runtime.terminate?.(signal);

  if (escalateAfterMs === null || signal === 'SIGKILL') {
    return { delivered: true, escalated: false };
  }

  const ended = runtime.ended;
  const escalate = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(true);
    }, escalateAfterMs);
    timer.unref();
    void ended.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  const escalated = await escalate;
  if (escalated) {
    runtime.killRequested = true;
    runtime.terminate?.('SIGKILL');
  }
  return { delivered: true, escalated };
}

export async function restartUnit(
  cfg: AgentConfig,
  unitId: string,
  ownerUserId: string
): Promise<ExecutionUnit> {
  const runtime = requireOwned(unitId, ownerUserId);
  rememberConfig(cfg);

  if (!isTerminalUnitState(runtime.unit.state)) {
    await endUnit(runtime, 'restart_requested');
  }

  await respawn(cfg, runtime, 'requested');
  return cloneUnit(runtime.unit);
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReadUnitLogOptions {
  offset: number;
  limit: number;
  stream: 'combined' | 'stdout' | 'stderr';
}

export interface UnitLogRead {
  content: string;
  offset: number;
  retainedBytes: number;
  droppedBytes: number;
  totalBytes: number;
  ended: boolean;
}

/**
 * Reads a window of a unit's retained output.
 *
 * `offset` is absolute, so a client polling in a loop can ask for what it has
 * not seen yet and be told when it asked for something already dropped rather
 * than being handed the tail of a stream it thinks is contiguous. On a `pipe`
 * unit the two streams can be read separately; `combined` is the merged view,
 * which is all a `pty` unit has.
 */
export function readUnitLog(
  unitId: string,
  ownerUserId: string,
  options: ReadUnitLogOptions
): UnitLogRead {
  const runtime = requireOwned(unitId, ownerUserId);
  const ring =
    options.stream === 'stdout'
      ? runtime.rings.stdout
      : options.stream === 'stderr'
        ? runtime.rings.stderr
        : runtime.rings.combined;

  const { text, missed } = readRing(ring, options.offset, options.limit);

  return {
    content: text,
    // The caller is told where the data it is receiving starts, which is not
    // where it asked from when it asked for bytes that have been dropped.
    offset: options.offset + missed,
    retainedBytes: ring.bytes,
    droppedBytes: ring.dropped,
    totalBytes: ring.total,
    ended: isTerminalUnitState(runtime.unit.state),
  };
}

/* -------------------------------------------------------------------------- */
/* Watching                                                                    */
/* -------------------------------------------------------------------------- */

export interface SubscribeResult {
  unit: ExecutionUnit;
  /** Everything retained so far, oldest first, exactly as it would have streamed. */
  replay: UnitEvent[];
  unsubscribe: () => void;
}

/**
 * Attaches to a unit's output.
 *
 * The replay is built from the retained ring rather than from a separate
 * scrollback, so what a late subscriber sees is precisely what the ring holds —
 * including the fact that it may have missed the beginning, which the unit's
 * `log.droppedBytes` reports. A unit that has already ended replays and then
 * says so, because "it finished while you were away" is a thing a client must
 * be told rather than left to infer from silence.
 */
export function subscribeUnit(
  cfg: AgentConfig,
  unitId: string,
  ownerUserId: string,
  subscriber: UnitSubscriber
): SubscribeResult {
  rememberConfig(cfg);
  const runtime = requireOwned(unitId, ownerUserId);
  reconcileUnit(runtime);

  const replay: UnitEvent[] = [];
  runtime.rings.combined.chunks.forEach((chunk, index) => {
    replay.push({
      type: 'output',
      data: chunk,
      stream: runtime.rings.combined.streams[index] ?? 'stdout',
    });
  });

  if (isTerminalUnitState(runtime.unit.state)) {
    replay.push({
      type: 'exit',
      exitCode: runtime.unit.exit?.code ?? null,
      signal: runtime.unit.exit?.signal ?? null,
      normalized: runtime.unit.exit?.normalized ?? 0,
      state: runtime.unit.state,
    });
    return { unit: cloneUnit(runtime.unit), replay, unsubscribe: () => undefined };
  }

  runtime.subscribers.add(subscriber);
  if (runtime.unit.kind === 'tty') touchIdle(runtime);

  return {
    unit: cloneUnit(runtime.unit),
    replay,
    unsubscribe: () => {
      runtime.subscribers.delete(subscriber);
    },
  };
}

/** How many clients are currently attached to a unit. */
export function subscriberCount(unitId: string): number {
  return units.get(unitId)?.subscribers.size ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Test hooks                                                                  */
/* -------------------------------------------------------------------------- */

/** Test-only: clears the table so tests start isolated. */
export function resetUnitsForTests(): void {
  for (const runtime of units.values()) {
    runtime.killRequested = true;
    runtime.terminate?.('SIGKILL');
    clearTimers(runtime);
  }
  units.clear();
  currentConfig = null;
}

/**
 * Test-only: registers a unit with no process behind it.
 *
 * Ownership and lifecycle checks happen before anything touches a process, so a
 * unit with no process is enough to test them — and testing them this way means
 * the rules run on every platform, not only where `node-pty` builds. A suite
 * that skipped them on a Windows dev box would be a suite that never checked
 * them there at all. Production code never calls this: both spawn paths always
 * have a child, and `finishUnit` is the only other writer.
 */
/**
 * Drops keys whose value is `undefined`.
 *
 * A spread of a `Partial<T>` carries its `undefined` values with it, so
 * `{ id: realId, ...overrides }` silently becomes `{ id: undefined }` when the
 * caller passed `{ id: undefined }`. That is not a hypothetical: it is how a
 * seeded test unit lost its id and made an ownership test pass for the wrong
 * reason. Filtering here means a caller can build an overrides object with
 * conditional fields without the fields it left out erasing the defaults.
 */
function definedOnly<T extends object>(overrides: Partial<T>): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export function seedUnitForTests(
  ownerUserId: string,
  overrides: Partial<ExecutionUnit> = {}
): ExecutionUnit {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  const maxBytes = LIMITS.EXECUTION_UNIT_MAX_OUTPUT_BYTES;

  const unit: ExecutionUnit = {
    id,
    ownerUserId,
    kind: 'tty',
    agentId: '00000000-0000-4000-8000-0000000000aa',
    spec: {
      kind: 'tty',
      shell: '/bin/bash',
      cwd: '/',
      env: {},
      tty: true,
      cols: 80,
      rows: 24,
      term: null,
      logMode: 'pty',
    },
    state: 'running',
    process: { pid: null, pgid: null, startTicks: null, bootId: null },
    exit: null,
    restart: { policy: 'never', maxAttempts: 0, backoffMs: 1_000, attempts: 0 },
    limits: {
      wallClockMs: null,
      graceMs: 5_000,
      maxOutputBytes: maxBytes,
      exceeded: null,
    },
    log: { mode: 'pty', retainedBytes: 0, droppedBytes: 0, totalBytes: 0 },
    createdAt: now,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    requestId: null,
    ...definedOnly(overrides),
  };

  units.set(id, {
    unit,
    pty: null,
    child: null,
    terminate: null,
    write: null,
    resize: null,
    subscribers: new Set(),
    rings: {
      combined: createRing(maxBytes),
      stdout: createRing(maxBytes),
      stderr: createRing(maxBytes),
    },
    killRequested: false,
    ended: Promise.resolve(),
    resolveEnded: null,
    reapAfterMs: 30_000,
    idleTimer: null,
    wallClockTimer: null,
    escalateTimer: null,
    restartTimer: null,
    reapTimer: null,
  });

  return cloneUnit(unit);
}

/** Test-only: records output on a seeded unit, so the log path is testable without a process. */
export function appendOutputForTests(unitId: string, data: string, stream: 'pty' | 'stdout' | 'stderr' = 'pty'): void {
  const runtime = units.get(unitId);
  if (!runtime) throw new Error(`no such unit: ${unitId}`);
  applyOutput(runtime, data, stream);
}

/** Test-only: ends a seeded unit as if its process had exited. */
export function finishUnitForTests(
  unitId: string,
  raw: { code: number | null; signal: number | null },
  killRequested = false
): void {
  const runtime = units.get(unitId);
  if (!runtime) throw new Error(`no such unit: ${unitId}`);
  runtime.killRequested = killRequested;
  finishUnit(runtime, raw);
}

/** Test-only: arms the idle and wall-clock timers on a seeded unit. */
export function armTimersForTests(unitId: string, cfg: AgentConfig): void {
  const runtime = units.get(unitId);
  if (!runtime) throw new Error(`no such unit: ${unitId}`);
  rememberConfig(cfg);
  touchIdle(runtime);
  armWallClock(runtime);
}

/** Test-only: makes the registry hold a config without spawning anything. */
export function rememberConfigForTests(cfg: AgentConfig): void {
  rememberConfig(cfg);
}

/** Test-only: how many units are held, ended ones included. */
export function unitCountForTests(): number {
  return units.size;
}

export { joinToRoot };
