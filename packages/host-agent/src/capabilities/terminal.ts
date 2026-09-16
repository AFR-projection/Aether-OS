import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  type TerminalServerMessage,
  type TerminalSession,
  type TerminalStatus,
} from '@aether/shared';

import { ConflictError, NotFoundError, ServiceUnavailableError } from '../errors.js';
import { subsystemLogger } from '../logger.js';
import { getWorkspaceRoot, joinToRoot, resolveExistingPath } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { IPty } from 'node-pty';

const log = subsystemLogger('terminal');

/**
 * Server-side PTY session manager.
 *
 * `node-pty` is a native addon. It is loaded lazily so that a build without a
 * working native module still serves the rest of the agent, and so the failure
 * is reported as a clear `TERMINAL_UNAVAILABLE` error rather than a crash at
 * boot.
 */

export type TerminalSubscriber = (message: TerminalServerMessage) => void;

interface TerminalRuntime {
  session: TerminalSession;
  ownerUserId: string;
  pty: IPty | null;
  subscribers: Set<TerminalSubscriber>;
  /** Recent output retained so a reconnecting client can rebuild its screen. */
  scrollback: string[];
  scrollbackBytes: number;
  idleTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, TerminalRuntime>();

const MAX_SCROLLBACK_BYTES = 256 * 1024;

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
export function isTerminalAvailable(cfg: AgentConfig): boolean {
  return ptyLoadError === null && cfg.TERMINAL_ENABLED;
}

function countSessionsForUser(userId: string): number {
  let count = 0;
  for (const runtime of sessions.values()) {
    if (runtime.ownerUserId === userId) count += 1;
  }
  return count;
}

function pruneScrollback(runtime: TerminalRuntime, cfg: AgentConfig): void {
  const maxChunks = Math.max(1, cfg.TERMINAL_SCROLLBACK_LINES);
  while (runtime.scrollbackBytes > MAX_SCROLLBACK_BYTES && runtime.scrollback.length > 1) {
    const removed = runtime.scrollback.shift();
    if (removed === undefined) break;
    runtime.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
  }
  while (runtime.scrollback.length > maxChunks) {
    const removed = runtime.scrollback.shift();
    if (removed === undefined) break;
    runtime.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
  }
}

function broadcast(runtime: TerminalRuntime, message: TerminalServerMessage): void {
  for (const subscriber of runtime.subscribers) {
    try {
      subscriber(message);
    } catch (error) {
      log.warn({ err: error, sessionId: runtime.session.id }, 'terminal subscriber threw');
    }
  }
}

function resetIdleTimer(runtime: TerminalRuntime, cfg: AgentConfig): void {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);

  runtime.idleTimer = setTimeout(() => {
    log.info({ sessionId: runtime.session.id }, 'terminal session idle timeout reached');
    killSession(runtime.session.id, 'idle_timeout');
  }, cfg.TERMINAL_IDLE_TIMEOUT);

  runtime.idleTimer.unref();
}

export interface CreateSessionOptions {
  ownerUserId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
}

export async function createSession(
  cfg: AgentConfig,
  options: CreateSessionOptions
): Promise<TerminalSession> {
  if (!cfg.TERMINAL_ENABLED) {
    throw new ServiceUnavailableError('Terminal access is disabled on this instance');
  }

  if (countSessionsForUser(options.ownerUserId) >= cfg.TERMINAL_MAX_SESSIONS) {
    throw new ConflictError('You have reached your terminal session limit', {
      limit: cfg.TERMINAL_MAX_SESSIONS,
    });
  }

  const pty = await loadPty();
  const root = await getWorkspaceRoot(cfg);

  let cwd = root;
  if (options.cwd) {
    const resolved = await resolveExistingPath(cfg, options.cwd);
    if (!resolved.exists) {
      throw new NotFoundError('Working directory does not exist', { path: options.cwd });
    }
    cwd = resolved.absolute;
  }

  const shell = resolveShell(cfg, options.shell);
  const id = randomUUID();

  const child = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd,
    env: buildChildEnvironment(root),
  });

  const now = new Date().toISOString();

  const runtime: TerminalRuntime = {
    session: {
      id,
      pid: child.pid,
      shell,
      cwd,
      cols: options.cols,
      rows: options.rows,
      status: 'running',
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      attachedClients: 0,
    },
    ownerUserId: options.ownerUserId,
    pty: child,
    subscribers: new Set(),
    scrollback: [],
    scrollbackBytes: 0,
    idleTimer: null,
    killTimer: null,
  };

  child.onData((data) => {
    runtime.session.lastActivityAt = new Date().toISOString();
    runtime.scrollback.push(data);
    runtime.scrollbackBytes += Buffer.byteLength(data, 'utf8');
    pruneScrollback(runtime, cfg);
    broadcast(runtime, { type: 'output', data });
    resetIdleTimer(runtime, cfg);
  });

  child.onExit(({ exitCode, signal }) => {
    runtime.session.status = 'exited';
    runtime.session.exitCode = exitCode;
    runtime.session.pid = null;

    broadcast(runtime, {
      type: 'exit',
      exitCode,
      signal: typeof signal === 'number' ? signal : null,
    });

    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);

    // Give an attached client a moment to receive the exit frame before the
    // session is dropped from the map.
    runtime.killTimer = setTimeout(() => sessions.delete(id), 30_000);
    runtime.killTimer.unref();
  });

  sessions.set(id, runtime);
  resetIdleTimer(runtime, cfg);

  log.info(
    { sessionId: id, pid: child.pid, shell, ownerUserId: options.ownerUserId },
    'terminal session created'
  );

  return { ...runtime.session };
}

/**
 * Resolves the shell to spawn.
 *
 * The requested shell must appear in `TERMINAL_ALLOWED_SHELLS`. Without this
 * allowlist a caller could ask for any executable on the host as the "shell".
 */
export function resolveShell(cfg: AgentConfig, requested?: string): string {
  const allowed = cfg.TERMINAL_ALLOWED_SHELLS;

  if (requested) {
    if (!allowed.includes(requested)) {
      throw new NotFoundError('Requested shell is not in the allowlist', { shell: requested });
    }
    return requested;
  }

  const preferred = process.env.SHELL;
  if (preferred && allowed.includes(preferred)) return preferred;

  const fallback = allowed[0];
  if (!fallback) {
    throw new ServiceUnavailableError('No shell is configured for terminal sessions');
  }
  return fallback;
}

/**
 * Builds the environment for the spawned shell.
 *
 * A minimal environment is passed rather than inheriting `process.env`
 * wholesale: the agent process holds `AETHER_PAIRING_TOKEN`, and a shell
 * running as the same user would be able to read it with a single `env`
 * command.
 */
function buildChildEnvironment(root: string): Record<string, string> {
  const user = process.env.USER ?? process.env.USERNAME ?? 'aether';
  const home = process.env.HOME ?? process.env.USERPROFILE ?? root;

  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    USER: user,
    LOGNAME: user,
    HOME: home,
    PWD: root,
    SHELL: process.env.SHELL ?? '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
}

function requireSession(sessionId: string): TerminalRuntime {
  const runtime = sessions.get(sessionId);
  if (!runtime) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }
  return runtime;
}

/** Returns the session only if `userId` owns it. */
export function getOwnedSession(sessionId: string, userId: string): TerminalSession {
  const runtime = requireSession(sessionId);

  if (runtime.ownerUserId !== userId) {
    // 404 rather than 403: a different user must not learn that this session id
    // exists at all.
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }

  return { ...runtime.session };
}

export function listSessionsForUser(userId: string): TerminalSession[] {
  const result: TerminalSession[] = [];
  for (const runtime of sessions.values()) {
    if (runtime.ownerUserId === userId) result.push({ ...runtime.session });
  }
  return result;
}

export function writeInput(
  sessionId: string,
  userId: string,
  data: string,
  cfg: AgentConfig
): void {
  const runtime = requireSession(sessionId);
  if (runtime.ownerUserId !== userId) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }
  if (!runtime.pty) {
    throw new ConflictError('Terminal session has already exited', { sessionId });
  }

  runtime.session.lastActivityAt = new Date().toISOString();
  runtime.pty.write(data);
  resetIdleTimer(runtime, cfg);
}

export function resizeSession(sessionId: string, userId: string, cols: number, rows: number): void {
  const runtime = requireSession(sessionId);
  if (runtime.ownerUserId !== userId) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }
  if (!runtime.pty) return;

  runtime.pty.resize(cols, rows);
  runtime.session.cols = cols;
  runtime.session.rows = rows;
}

export function sendSignal(
  sessionId: string,
  userId: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
): void {
  const runtime = requireSession(sessionId);
  if (runtime.ownerUserId !== userId) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }

  if (signal === 'SIGKILL' || signal === 'SIGTERM') {
    killSession(sessionId, `signal_${signal}`);
    return;
  }

  runtime.pty?.write('');
}

export function killSession(sessionId: string, reason: string): boolean {
  const runtime = sessions.get(sessionId);
  if (!runtime) return false;

  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  if (runtime.killTimer) clearTimeout(runtime.killTimer);

  const status: TerminalStatus = 'killed';
  runtime.session.status = status;
  runtime.session.pid = null;

  try {
    runtime.pty?.kill();
  } catch (error) {
    log.warn({ err: error, sessionId }, 'failed to kill pty process');
  }
  runtime.pty = null;

  broadcast(runtime, { type: 'exit', exitCode: -1, signal: null });
  runtime.subscribers.clear();
  sessions.delete(sessionId);

  log.info({ sessionId, reason }, 'terminal session killed');
  return true;
}

export interface AttachResult {
  session: TerminalSession;
  /** Output produced before the client attached, oldest first. */
  replay: string[];
  unsubscribe: () => void;
}

export function attach(
  cfg: AgentConfig,
  sessionId: string,
  userId: string,
  subscriber: TerminalSubscriber
): AttachResult {
  const runtime = requireSession(sessionId);
  if (runtime.ownerUserId !== userId) {
    throw new NotFoundError('Terminal session does not exist', { sessionId });
  }

  runtime.subscribers.add(subscriber);
  runtime.session.attachedClients = runtime.subscribers.size;
  resetIdleTimer(runtime, cfg);

  return {
    session: { ...runtime.session },
    replay: [...runtime.scrollback],
    unsubscribe: () => {
      runtime.subscribers.delete(subscriber);
      runtime.session.attachedClients = runtime.subscribers.size;
    },
  };
}

/** Kills every session owned by a user. Used on logout and account disable. */
export function killSessionsForUser(userId: string, reason: string): number {
  let killed = 0;
  for (const [sessionId, runtime] of [...sessions]) {
    if (runtime.ownerUserId === userId) {
      if (killSession(sessionId, reason)) killed += 1;
    }
  }
  return killed;
}

/** Kills every session. Used during graceful shutdown. */
export function killAllSessions(reason: string): number {
  let killed = 0;
  for (const sessionId of [...sessions.keys()]) {
    if (killSession(sessionId, reason)) killed += 1;
  }
  return killed;
}

export function terminalStats(cfg: AgentConfig): {
  active: number;
  available: boolean;
  maxPerUser: number;
} {
  return {
    active: sessions.size,
    available: isTerminalAvailable(cfg),
    maxPerUser: cfg.TERMINAL_MAX_SESSIONS,
  };
}

/** Resolves a workspace-relative path for display in the session listing. */
export async function relativeCwd(cfg: AgentConfig, absolute: string): Promise<string> {
  const root = await getWorkspaceRoot(cfg);
  return path.relative(root, absolute).split(path.sep).join('/');
}

/** Test-only hook: clears the session table so tests start isolated. */
export function resetSessionsForTests(): void {
  for (const runtime of sessions.values()) {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (runtime.killTimer) clearTimeout(runtime.killTimer);
  }
  sessions.clear();
}

export { joinToRoot };
