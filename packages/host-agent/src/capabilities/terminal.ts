import path from 'node:path';

import {
  terminalSessionFromUnit,
  terminalStatusToUnitState,
  type ExecutionUnit,
  type TerminalServerMessage,
  type TerminalSession,
} from '@aether/shared';

import { subsystemLogger } from '../logger.js';
import {
  createUnit,
  endOwnedUnit,
  getUnit,
  getUnitUnscoped,
  isPtyAvailable,
  isUnitEnded,
  isUnitEnding,
  listUnits,
  requestEndAllUnits,
  requestEndUnitsForUser,
  requestEndUnitUnscoped,
  resetUnitsForTests,
  resizeUnit,
  resolveShell,
  seedUnitForTests,
  signalUnit,
  subscriberCount,
  subscribeUnit,
  unitStats,
  writeUnitInput,
  type UnitEvent,
} from './units.js';
import { getWorkspaceRoot } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';

const log = subsystemLogger('terminal');

/**
 * The Terminal, as a view over the execution-unit registry.
 *
 * There is no session table here any more. An interactive shell *is* an
 * execution unit of kind `tty`, and this module is the projection of one onto
 * the session shape the browser already speaks: `createSession` creates a unit,
 * `listSessionsForUser` reads units, `attach` subscribes to a unit, and killing
 * a session ends the unit. Nothing is stored twice, so the two cannot disagree
 * about whether a shell is running.
 *
 * That is the whole point of the layer. When the terminal had its own table,
 * every question worth asking — is this alive, whose is it, what did it print,
 * how did it end — had one answer here and another in the registry, and the two
 * drifted. Now there is one answer and this file renames it.
 *
 * ## The projection is lossy, deliberately
 *
 * A unit has six states; `TerminalStatus` has four. `failed` and `stale` both
 * arrive here as `exited`, because from a terminal's point of view a process
 * that is not running is not running — the difference lives in the unit's own
 * `state` and `exit`, which is where a consumer that needs it reads it. The
 * mapping is written down in `terminalSessionFromUnit` rather than implied.
 */

export type TerminalSubscriber = (message: TerminalServerMessage) => void;

/** True when a real shell can be spawned on this host. */
export function isTerminalAvailable(cfg: AgentConfig): boolean {
  return cfg.TERMINAL_ENABLED && isPtyAvailable();
}

export interface CreateSessionOptions {
  ownerUserId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  /**
   * A command to run instead of an interactive shell.
   *
   * Passed to the shell as `-c <command>` by the registry, so pipelines, `&&`,
   * globs and `$VAR` behave the way the person who typed it expects. The shell
   * itself still comes from the allowlist, so this does not widen what can be
   * spawned — only what the allowed shell is asked to do, which is the same
   * thing a terminal already grants.
   */
  command?: string;
}

export async function createSession(
  cfg: AgentConfig,
  options: CreateSessionOptions
): Promise<TerminalSession> {
  const unit = await createUnit(cfg, options.ownerUserId, {
    kind: 'tty',
    command: options.command,
    cwd: options.cwd,
    shell: options.shell,
    cols: options.cols,
    rows: options.rows,
  });
  return terminalSessionFromUnit(unit, 0);
}

/** Returns the session only if `userId` owns it. */
export function getOwnedSession(sessionId: string, userId: string): TerminalSession {
  // `getUnit` raises the same 404 for someone else's unit as for one that does
  // not exist: an id held by a caller must not reveal that another user's
  // session is there.
  return terminalSessionFromUnit(getUnit(sessionId, userId), subscriberCount(sessionId));
}

/**
 * Whether the Terminal lists a unit.
 *
 * A unit that ended by itself stays listed — that is the honesty rule this
 * module exists to hold: a shell the user watched exit must not silently
 * vanish, and its final output is still readable through `attach`. A unit whose
 * end was *requested* is not listed, whether or not the process has finished
 * dying. The terminal's contract has always been that a killed session is gone,
 * and listing it during the SIGTERM window would do worse than show a stale row:
 * the backend reconciles its own records against this listing and adopts what it
 * finds, so a session killed a moment ago would come straight back.
 */
function visibleInTerminal(unit: ExecutionUnit): boolean {
  return unit.state !== 'killed' && !isUnitEnding(unit.id);
}

export function listSessionsForUser(userId: string): TerminalSession[] {
  return listUnits({ ownerUserId: userId, kind: 'tty' })
    .filter(visibleInTerminal)
    .map((unit) => terminalSessionFromUnit(unit, subscriberCount(unit.id)));
}

export function writeInput(sessionId: string, userId: string, data: string): void {
  writeUnitInput(sessionId, userId, data);
}

export function resizeSession(sessionId: string, userId: string, cols: number, rows: number): void {
  resizeUnit(sessionId, userId, cols, rows);
}

export function sendSignal(
  sessionId: string,
  userId: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
): void {
  // Not awaited on purpose. `signalUnit` is asynchronous only because an
  // escalating signal waits for the process to die; a terminal's never
  // escalates, and the signal itself has been sent by the time the promise is
  // created. Waiting here would make the caller's reply depend on a process that
  // may take its time about exiting, which is the opposite of what a keystroke
  // needs.
  void signalUnit(sessionId, userId, signal, null).catch((error: unknown) => {
    log.warn({ err: error, sessionId, signal }, 'failed to signal terminal session');
  });
}

/**
 * Ends a session, whatever its owner.
 *
 * The internal killer: the shutdown path and the logout path call it, and
 * neither acts as a person, so neither has an owner to check against. A request
 * arriving over the wire does, and that path goes through `killOwnedSession`.
 */
export function killSession(sessionId: string, reason: string): boolean {
  return requestEndUnitUnscoped(sessionId, reason);
}

/**
 * Kills a session only if `userId` owns it.
 *
 * A session owned by someone else and a session that does not exist both answer
 * `false`. That is deliberate and matches `getOwnedSession`: an unowned id must
 * not be distinguishable from a missing one.
 */
export function killOwnedSession(sessionId: string, userId: string, reason: string): boolean {
  void reason;
  let unit: ExecutionUnit;
  try {
    unit = getUnit(sessionId, userId);
  } catch {
    return false;
  }
  if (unit.state !== 'running' && unit.state !== 'starting') return false;
  void endOwnedUnit(sessionId, userId, 'backend_request').catch((error: unknown) => {
    log.warn({ err: error, sessionId }, 'failed to end terminal session');
  });
  return true;
}

/** Kills every session owned by a user. Used on logout and account disable. */
export function killSessionsForUser(userId: string, reason: string): number {
  return requestEndUnitsForUser(userId, reason);
}

/** Kills every session. Used during graceful shutdown. */
export function killAllSessions(reason: string): number {
  return requestEndAllUnits(reason);
}

export interface AttachResult {
  session: TerminalSession;
  /** Output produced before the client attached, oldest first. */
  replay: string[];
  unsubscribe: () => void;
}

/** Projects one registry event onto the terminal's wire protocol. */
function forwardEvent(event: UnitEvent, subscriber: TerminalSubscriber): void {
  switch (event.type) {
    case 'output':
      subscriber({ type: 'output', data: event.data });
      return;
    case 'exit':
      subscriber({ type: 'exit', exitCode: event.normalized, signal: event.signal });
      return;
    case 'state':
    case 'restart':
      // A unit that ends without an exit frame — found `stale` by the liveness
      // check, or restarted underneath its client — still has to reach the
      // client as an end. A terminal that showed nothing would be showing a
      // shell that is no longer there.
      subscriber({ type: 'exit', exitCode: -1, signal: null });
      return;
  }
}

export function attach(
  cfg: AgentConfig,
  sessionId: string,
  userId: string,
  subscriber: TerminalSubscriber
): AttachResult {
  const attached = subscribeUnit(cfg, sessionId, userId, (event) => {
    forwardEvent(event, subscriber);
  });

  const replay: string[] = [];
  for (const event of attached.replay) {
    if (event.type === 'output') replay.push(event.data);
  }

  return {
    session: terminalSessionFromUnit(attached.unit, subscriberCount(sessionId)),
    replay,
    unsubscribe: attached.unsubscribe,
  };
}

export function terminalStats(cfg: AgentConfig): {
  active: number;
  available: boolean;
  maxPerUser: number;
} {
  const stats = unitStats(cfg);
  return {
    // Counted over `tty` units, because this is the terminal's own health
    // figure: a host whose capacity is spent on command units has not run out
    // of terminals, and a number that said so would mislead the one place
    // anybody reads it.
    active: listUnits({ ownerUserId: null, kind: 'tty' }).length,
    available: isTerminalAvailable(cfg),
    maxPerUser: stats.maxPerUser,
  };
}

/** Resolves a workspace-relative path for display in the session listing. */
export async function relativeCwd(cfg: AgentConfig, absolute: string): Promise<string> {
  const root = await getWorkspaceRoot(cfg);
  return path.relative(root, absolute).split(path.sep).join('/');
}

export { resolveShell };

/* -------------------------------------------------------------------------- */
/* Test hooks                                                                  */
/* -------------------------------------------------------------------------- */

/** Test-only hook: clears the registry table so tests start isolated. */
export function resetSessionsForTests(): void {
  resetUnitsForTests();
}

/**
 * Test-only hook: registers a session with no process behind it.
 *
 * Ownership is checked before anything touches the PTY, so a session with no
 * PTY is enough to test it — and testing it that way means the ownership rules
 * run on every platform, not only where `node-pty` builds. A suite that skipped
 * them on a Windows dev box would be one that never checked them there at all.
 * Production code never calls this; nothing else can put a process-less unit in
 * the registry, since both spawn paths always have a child.
 */
export function seedSessionForTests(
  ownerUserId: string,
  overrides: Partial<TerminalSession> = {}
): TerminalSession {
  const unit = seedUnitForTests(ownerUserId, {
    id: overrides.id,
    kind: 'tty',
    state:
      overrides.status === undefined ? 'running' : terminalStatusToUnitState(overrides.status),
    spec: {
      kind: 'tty',
      shell: overrides.shell ?? '/bin/bash',
      cwd: overrides.cwd ?? '/',
      env: {},
      tty: true,
      cols: overrides.cols ?? 80,
      rows: overrides.rows ?? 24,
      term: null,
      logMode: 'pty',
    },
  });
  return terminalSessionFromUnit(unit, 0);
}

/** Test-only: true when the registry still holds this unit and it has not ended. */
export function isSessionLiveForTests(sessionId: string): boolean {
  return !isUnitEnded(sessionId);
}

/** Unused today, but kept so a future caller does not re-derive an unscoped read. */
export { getUnitUnscoped };
