import { Buffer } from 'node:buffer';

import {
  createDirectory,
  deleteEntry,
  listFiles,
  readFileChunk,
  readFileContent,
  renameEntry,
  writeFileChunk,
  writeFileContent,
} from './capabilities/filesystem.js';
import { closeTunnel, openTunnel, readTunnel, writeTunnel } from './capabilities/port-tunnel.js';
import { listListeningPorts } from './capabilities/ports.js';
import {
  ALLOWED_PROCESS_SIGNALS,
  listProcesses,
  signalProcess,
  type AllowedProcessSignal,
} from './capabilities/processes.js';
import { getSystemInfo } from './capabilities/system.js';
import {
  attach,
  createSession,
  killOwnedSession,
  listSessionsForUser,
  resizeSession,
  sendSignal,
  writeInput,
} from './capabilities/terminal.js';
import {
  createUnit,
  endOwnedUnit,
  getUnit,
  listUnits,
  readUnitLog,
  restartUnit,
  signalUnit,
  subscribeUnit,
} from './capabilities/units.js';
import { toErrorCode, toStatusCode } from './errors.js';
import { subsystemLogger } from './logger.js';
import { errReply, okReply, type ParsedRequest, type Reply } from './protocol.js';

import type { UnitEvent } from './capabilities/units.js';
import type { AgentConfig } from './config.js';
import type { UnitSignal } from '@aether/shared';

const log = subsystemLogger('router');

/**
 * Dispatches one validated backend request to the local capability that
 * implements it.
 *
 * All errors are converted to `{ ok: false, error: { code, message } }` replies
 * here, so the connection layer never has to interpret domain failures. 5xx
 * faults are logged with their stack; 4xx rejections are logged at debug level
 * because they describe a bad request, not a broken agent.
 */

interface ProcessListParams {
  limit?: number;
  sortBy?: 'memory' | 'pid' | 'name';
  search?: string;
}

interface ProcessSignalParams {
  pid: number;
  signal: AllowedProcessSignal;
}

interface PathParams {
  path: string;
}

interface WriteParams {
  path: string;
  contentBase64: string;
}

interface ReadChunkParams {
  path: string;
  offset: number;
  length: number;
}

interface WriteChunkParams {
  path: string;
  offset: number;
  contentBase64: string;
  truncate: boolean;
}

interface DeleteParams {
  path: string;
  recursive: boolean;
}

interface RenameParams {
  from: string;
  to: string;
  overwrite: boolean;
}

interface PortOpenParams {
  port: number;
  host?: string;
}

interface PortReadParams {
  tunnelId: string;
  maxBytes: number;
}

interface PortWriteParams {
  tunnelId: string;
  contentBase64: string;
}

interface PortCloseParams {
  tunnelId: string;
}

interface TerminalCreateParams {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  command?: string;
}

interface TerminalIdParams {
  id: string;
}

interface TerminalInputParams {
  id: string;
  data: string;
}

interface TerminalResizeParams {
  id: string;
  cols: number;
  rows: number;
}

interface TerminalSignalParams {
  id: string;
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
}

interface UnitsCreateParams {
  kind: 'tty' | 'command' | 'service' | 'worker';
  command?: string;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  term?: string;
  wallClockMs: number | null;
  graceMs: number;
  maxOutputBytes: number;
  restart?: { policy: 'never' | 'on-failure' | 'always'; maxAttempts: number; backoffMs: number };
  requestId?: string;
}

interface UnitsListParams {
  kind?: 'tty' | 'command' | 'service' | 'worker';
  scope: 'mine' | 'all';
}

interface UnitsIdParams {
  id: string;
}

interface UnitsSignalParams {
  id: string;
  signal: UnitSignal;
  escalateAfterMs: number | null;
}

interface UnitsLogParams {
  id: string;
  offset: number;
  limit: number;
  stream: 'combined' | 'stdout' | 'stderr';
}

export async function dispatchRequest(
  cfg: AgentConfig,
  ownerUserId: string,
  request: ParsedRequest
): Promise<Reply> {
  try {
    const result = await route(cfg, ownerUserId, request);
    return okReply(request.id, result);
  } catch (error) {
    const code = toErrorCode(error);
    const status = toStatusCode(error);
    const message = error instanceof Error ? error.message : 'Internal error';

    if (status >= 500) {
      log.error({ err: error, requestId: request.id, type: request.type }, 'request failed');
    } else {
      log.debug({ requestId: request.id, type: request.type, code }, 'request rejected');
    }

    const safeMessage = status >= 500 ? 'Internal error' : message;
    return errReply(request.id, code, safeMessage);
  }
}

async function route(
  cfg: AgentConfig,
  ownerUserId: string,
  request: ParsedRequest
): Promise<unknown> {
  switch (request.type) {
    case 'system.info': {
      return getSystemInfo(cfg);
    }

    case 'processes.list': {
      const params = request.params as ProcessListParams;
      return listProcesses(cfg, {
        limit: params.limit ?? 100,
        sortBy: params.sortBy,
        search: params.search,
      });
    }

    case 'processes.signal': {
      const params = request.params as ProcessSignalParams;
      if (!ALLOWED_PROCESS_SIGNALS.includes(params.signal)) {
        throw new Error(`Unsupported signal: ${params.signal}`);
      }
      await signalProcess(cfg, params.pid, params.signal);
      return { signalled: true, pid: params.pid, signal: params.signal };
    }

    case 'files.list': {
      const params = request.params as PathParams;
      return { entries: await listFiles(cfg, params.path) };
    }

    case 'files.read': {
      const params = request.params as PathParams;
      const content = await readFileContent(cfg, params.path);
      return { contentBase64: content.toString('base64') };
    }

    case 'files.readChunk': {
      const params = request.params as ReadChunkParams;
      const { content, size } = await readFileChunk(cfg, params.path, params.offset, params.length);
      return { contentBase64: content.toString('base64'), size, offset: params.offset };
    }

    case 'files.write': {
      const params = request.params as WriteParams;
      const content = Buffer.from(params.contentBase64, 'base64');
      await writeFileContent(cfg, params.path, content, { createParents: false });
      return { written: true, path: params.path, bytes: content.length };
    }

    case 'files.writeChunk': {
      const params = request.params as WriteChunkParams;
      const content = Buffer.from(params.contentBase64, 'base64');
      const bytes = await writeFileChunk(cfg, params.path, params.offset, content, params.truncate);
      return { written: true, path: params.path, bytes, offset: params.offset };
    }

    case 'files.delete': {
      const params = request.params as DeleteParams;
      await deleteEntry(cfg, params.path, params.recursive);
      return { deleted: true, path: params.path };
    }

    case 'files.mkdir': {
      const params = request.params as PathParams;
      await createDirectory(cfg, params.path);
      return { created: true, path: params.path };
    }

    case 'files.rename': {
      const params = request.params as RenameParams;
      const entry = await renameEntry(cfg, {
        from: params.from,
        to: params.to,
        overwrite: params.overwrite,
      });
      return { renamed: true, entry };
    }

    case 'ports.list': {
      return listListeningPorts(cfg);
    }

    case 'ports.open': {
      const params = request.params as PortOpenParams;
      return openTunnel(cfg, {
        port: params.port,
        ...(params.host !== undefined ? { host: params.host } : {}),
        ownerUserId,
      });
    }

    case 'ports.read': {
      const params = request.params as PortReadParams;
      return readTunnel(cfg, params.tunnelId, ownerUserId, params.maxBytes);
    }

    case 'ports.write': {
      const params = request.params as PortWriteParams;
      return writeTunnel(
        cfg,
        params.tunnelId,
        ownerUserId,
        Buffer.from(params.contentBase64, 'base64')
      );
    }

    case 'ports.close': {
      const params = request.params as PortCloseParams;
      return closeTunnel(params.tunnelId, ownerUserId);
    }

    case 'terminal.create': {
      const params = request.params as TerminalCreateParams;
      return createSession(cfg, {
        ownerUserId,
        cols: params.cols ?? 80,
        rows: params.rows ?? 24,
        cwd: params.cwd,
        shell: params.shell,
        command: params.command,
      });
    }

    case 'terminal.list': {
      return { sessions: listSessionsForUser(ownerUserId) };
    }

    case 'terminal.input': {
      const params = request.params as TerminalInputParams;
      writeInput(params.id, ownerUserId, params.data);
      return { accepted: true };
    }

    case 'terminal.resize': {
      const params = request.params as TerminalResizeParams;
      resizeSession(params.id, ownerUserId, params.cols, params.rows);
      return { resized: true };
    }

    case 'terminal.signal': {
      const params = request.params as TerminalSignalParams;
      sendSignal(params.id, ownerUserId, params.signal);
      return { signalled: true };
    }

    case 'terminal.kill': {
      const params = request.params as TerminalIdParams;
      // Ownership-checked: `killSession` is the internal killer and takes no
      // owner, so reaching for it here would let any caller kill any session.
      const killed = killOwnedSession(params.id, ownerUserId, 'backend_request');
      return { killed };
    }

    /**
     * The general execution-unit surface.
     *
     * Every one of these names the owner, and every one of them answers a unit
     * belonging to somebody else exactly as it answers one that does not exist.
     * The agent is the last line of defence — it holds the processes, and it is
     * the only party that can refuse to act on one — so a verb that skipped the
     * check here would not be caught anywhere.
     */
    case 'units.create': {
      const params = request.params as UnitsCreateParams;
      return createUnit(cfg, ownerUserId, {
        kind: params.kind,
        command: params.command,
        cwd: params.cwd,
        shell: params.shell,
        env: params.env,
        cols: params.cols,
        rows: params.rows,
        term: params.term,
        wallClockMs: params.wallClockMs,
        graceMs: params.graceMs,
        maxOutputBytes: params.maxOutputBytes,
        restart: params.restart,
        requestId: params.requestId,
      });
    }

    case 'units.list': {
      const params = request.params as UnitsListParams;
      // `all` is the absence of an owner filter. Only the backend can send it —
      // the pairing token authenticates it — and the permission that makes it
      // legitimate is checked there, where the roles are.
      return {
        units: listUnits({
          ownerUserId: params.scope === 'all' ? null : ownerUserId,
          kind: params.kind,
        }),
      };
    }

    case 'units.get': {
      const params = request.params as UnitsIdParams;
      return { unit: getUnit(params.id, ownerUserId) };
    }

    case 'units.signal': {
      const params = request.params as UnitsSignalParams;
      return signalUnit(params.id, ownerUserId, params.signal, params.escalateAfterMs);
    }

    case 'units.kill': {
      const params = request.params as UnitsIdParams;
      const killed = await endOwnedUnit(params.id, ownerUserId, 'backend_request');
      return { killed };
    }

    case 'units.restart': {
      const params = request.params as UnitsIdParams;
      return { unit: await restartUnit(cfg, params.id, ownerUserId) };
    }

    case 'units.log': {
      const params = request.params as UnitsLogParams;
      const read = readUnitLog(params.id, ownerUserId, {
        offset: params.offset,
        limit: params.limit,
        stream: params.stream,
      });
      return {
        // Base64 because a stream is bytes: a partial UTF-8 sequence at a chunk
        // boundary is normal, and JSON would corrupt it.
        contentBase64: Buffer.from(read.content, 'utf8').toString('base64'),
        offset: read.offset,
        retainedBytes: read.retainedBytes,
        droppedBytes: read.droppedBytes,
        totalBytes: read.totalBytes,
        ended: read.ended,
      };
    }

    default: {
      throw new Error(`Unsupported request type: ${(request as { type: string }).type}`);
    }
  }
}

/** Subscribe to output of one owned session, with scrollback replay. */
export function subscribeToSession(
  cfg: AgentConfig,
  sessionId: string,
  ownerUserId: string,
  onMessage: (message: { type: string; data?: string }) => void
): () => void {
  const attached = attach(cfg, sessionId, ownerUserId, onMessage);
  for (const chunk of attached.replay) {
    onMessage({ type: 'output', data: chunk });
  }
  return attached.unsubscribe;
}

/**
 * Subscribe to a unit's events, with its retained output replayed first.
 *
 * The general form of `subscribeToSession`: it carries the unit's own event
 * vocabulary — which includes a state change that is not an exit — rather than
 * the terminal's narrower one. A subscriber that has already been handed the
 * end of a finished unit gets nothing further, because there is nothing further
 * to send.
 */
export function subscribeToUnit(
  cfg: AgentConfig,
  unitId: string,
  ownerUserId: string,
  onEvent: (event: UnitEvent) => void
): () => void {
  const attached = subscribeUnit(cfg, unitId, ownerUserId, onEvent);
  for (const event of attached.replay) {
    onEvent(event);
  }
  return attached.unsubscribe;
}
