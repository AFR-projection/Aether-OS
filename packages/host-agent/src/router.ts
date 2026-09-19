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
  killSession,
  listSessionsForUser,
  resizeSession,
  sendSignal,
  writeInput,
} from './capabilities/terminal.js';
import { toErrorCode, toStatusCode } from './errors.js';
import { subsystemLogger } from './logger.js';
import { errReply, okReply, type ParsedRequest, type Reply } from './protocol.js';

import type { AgentConfig } from './config.js';

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
      writeInput(params.id, ownerUserId, params.data, cfg);
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
      const killed = killSession(params.id, 'backend_request');
      return { killed };
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
