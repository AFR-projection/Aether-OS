import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';

import { type ProcessInfo, type ProcessListResponse } from '@aether/shared';

import type { AgentConfig } from '../config.js';
import { ForbiddenError, NotFoundError, NotImplementedError } from '../errors.js';
import { subsystemLogger } from '../logger.js';

const LINUX = process.platform === 'linux';

const log = subsystemLogger('processes');

/**
 * Page size used to convert `RSS` from `/proc/<pid>/stat` (which is in pages)
 * into bytes. 4 KiB is correct for every mainstream x86_64 and arm64 Linux
 * build; a host with 16 KiB pages would over-report by 4x, so the value is
 * labelled here rather than buried in the arithmetic.
 */
const PAGE_SIZE_BYTES = 4096;

/** Parses `/proc/<pid>/stat`, accounting for the parenthesised command name. */
function parseProcStatLine(content: string): {
  state: string;
  ppid: number;
  utime: number;
  stime: number;
  starttime: number;
  rssPages: number;
} | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open === -1 || close === -1) return null;

  const fields = content
    .slice(close + 2)
    .trim()
    .split(/\s+/);

  // After the command name, field 3 onwards: state is index 0 here, ppid is 1.
  const state = fields[0];
  const ppid = Number.parseInt(fields[1] ?? '', 10);
  const utime = Number.parseInt(fields[11] ?? '', 10);
  const stime = Number.parseInt(fields[12] ?? '', 10);
  const starttime = Number.parseInt(fields[19] ?? '', 10);
  const rssPages = Number.parseInt(fields[21] ?? '', 10);

  if (state === undefined || [ppid, utime, stime, starttime, rssPages].some(Number.isNaN)) {
    return null;
  }

  return { state, ppid, utime, stime, starttime, rssPages };
}

async function readProcFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function readProcess(
  pid: number,
  clockTicks: number,
  bootTimeMs: number,
  protectedPids: ReadonlySet<number>,
  cfg: AgentConfig,
): Promise<ProcessInfo | null> {
  const statContent = await readProcFile(`/proc/${pid}/stat`);
  if (!statContent) return null;

  const parsed = parseProcStatLine(statContent);
  if (!parsed) return null;

  const statusContent = (await readProcFile(`/proc/${pid}/status`)) ?? '';
  const userMatch = /^Uid:\s+(\d+)/m.exec(statusContent);
  const nameMatch = /^Name:\s+(.*)$/m.exec(statusContent);

  const cmdlineRaw = (await readProcFile(`/proc/${pid}/cmdline`)) ?? '';
  const command =
    cmdlineRaw.replace(/\0/g, ' ').trim() ||
    nameMatch?.[1]?.trim() ||
    statContent.slice(statContent.indexOf('(') + 1, statContent.lastIndexOf(')')) ||
    'unknown';

  const startedAt = bootTimeMs + (parsed.starttime / clockTicks) * 1000;

  return {
    pid,
    ppid: parsed.ppid,
    user: userMatch?.[1] ?? 'unknown',
    // Per-process CPU percentage needs two samples separated in time; without
    // that baseline 0 is reported rather than a fabricated instantaneous value.
    // See KNOWN-LIMITATIONS.md.
    cpuPercent: 0,
    memoryBytes: parsed.rssPages * PAGE_SIZE_BYTES,
    state: parsed.state,
    startedAt: new Date(startedAt).toISOString(),
    command,
    signalable: cfg.PROCESS_SIGNAL_ENABLED && !protectedPids.has(pid),
  };
}

/**
 * PIDs Aether will never signal, however it is configured.
 *
 * pid 1 is the host's init (or the container's entrypoint): killing it takes the
 * machine down. The rest are this process and its ancestors — signalling any of
 * them would make Aether terminate the thing that is serving the request, which
 * looks to the user like a crash rather than a deliberate action.
 */
async function collectProtectedPids(): Promise<Set<number>> {
  const protectedPids = new Set<number>([1, process.pid]);

  if (!LINUX) return protectedPids;

  let current = process.pid;
  // Bounded so a corrupt or cyclic ppid chain cannot spin forever.
  for (let depth = 0; depth < 64; depth += 1) {
    current = await readParentPid(current);
    if (current <= 1) break;
    protectedPids.add(current);
  }

  return protectedPids;
}

async function readParentPid(pid: number): Promise<number> {
  const content = await readProcFile(`/proc/${pid}/stat`);
  if (content === null) return 1;
  const parsed = parseProcStatLine(content);
  return parsed?.ppid ?? 1;
}

export interface ListProcessOptions {
  limit: number;
  sortBy?: 'memory' | 'pid' | 'name';
  search?: string;
}

export async function listProcesses(cfg: AgentConfig, options: ListProcessOptions): Promise<ProcessListResponse> {
  const emptyResponse: ProcessListResponse = {
    processes: [],
    total: 0,
    truncated: false,
    running: 0,
    signalEnabled: cfg.PROCESS_SIGNAL_ENABLED,
  };

  if (!LINUX) return emptyResponse;

  const clockTicks = 100; // USER_HZ is 100 on every mainstream Linux build.
  const bootTimeMs = Date.now() - os.uptime() * 1000;

  let pids: string[];
  try {
    pids = await readdir('/proc');
  } catch (error) {
    log.warn({ err: error }, 'could not read /proc');
    return emptyResponse;
  }

  const numericPids = pids
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => Number.parseInt(entry, 10));

  const total = numericPids.length;
  const protectedPids = await collectProtectedPids();

  const results = await Promise.all(
    numericPids.map((pid) => readProcess(pid, clockTicks, bootTimeMs, protectedPids, cfg))
  );

  let processes = results.filter((process): process is ProcessInfo => process !== null);

  // Counted before the search filter and the page slice, so the figure describes
  // the machine rather than the current view.
  const running = processes.filter((process) => process.state === 'R').length;

  if (options.search) {
    const needle = options.search.toLowerCase();
    processes = processes.filter(
      (process) => process.command.toLowerCase().includes(needle) || String(process.pid) === needle
    );
  }

  processes.sort((a, b) => {
    if (options.sortBy === 'pid') return a.pid - b.pid;
    if (options.sortBy === 'name') return a.command.localeCompare(b.command);
    return b.memoryBytes - a.memoryBytes;
  });

  const truncated = processes.length > options.limit;
  processes = processes.slice(0, options.limit);

  return {
    processes,
    total,
    truncated,
    running,
    signalEnabled: cfg.PROCESS_SIGNAL_ENABLED,
  };
}

/** Signals the process may be sent. Deliberately excludes the uncatchable ones. */
export const ALLOWED_PROCESS_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'] as const;
export type AllowedProcessSignal = (typeof ALLOWED_PROCESS_SIGNALS)[number];

/**
 * Sends a signal to a process.
 *
 * Every refusal is decided here rather than in the route, so the rule cannot be
 * bypassed by a second caller. The guards are checked in order of severity: a
 * disabled feature first, then an unknown process, then the protected set.
 */
export async function signalProcess(cfg: AgentConfig, pid: number, signal: AllowedProcessSignal): Promise<void> {
  if (!cfg.PROCESS_SIGNAL_ENABLED) {
    throw new ForbiddenError(
      'Process signalling is disabled on this instance. Set PROCESS_SIGNAL_ENABLED=true to allow it.',
      { reason: 'feature_disabled' }
    );
  }

  // Checked before the platform gate: refusing pid 1, this process, and this
  // process's ancestors is a policy decision that holds everywhere, so it is
  // answered the same way on every platform.
  const protectedPids = await collectProtectedPids();

  if (protectedPids.has(pid)) {
    throw new ForbiddenError('Aether will not signal this process', {
      reason: pid === 1 ? 'pid_1_is_init' : 'protected_process',
      pid,
    });
  }

  if (!LINUX) {
    throw new NotImplementedError('Process signalling is only implemented on Linux');
  }

  // Confirm the process exists before signalling, so a stale row in the UI
  // produces "not found" rather than a bare ESRCH.
  if ((await readProcFile(`/proc/${pid}/stat`)) === null) {
    throw new NotFoundError('Process does not exist', { pid });
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ESRCH') {
      throw new NotFoundError('Process does not exist', { pid });
    }

    if (code === 'EPERM') {
      // The kernel refuses to let this user signal that process. Reporting the
      // kernel's decision verbatim is more honest than pretending it worked.
      throw new ForbiddenError('Aether does not have permission to signal this process', { pid });
    }

    throw error;
  }

  log.warn({ pid, signal }, 'process signalled');
}
