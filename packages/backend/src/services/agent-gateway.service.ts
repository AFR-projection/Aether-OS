import { Buffer } from 'node:buffer';
import { readFile, writeFile, readdir, stat, mkdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ALLOWED_PROCESS_SIGNALS,
  getSystemInfo,
  listProcesses,
  signalProcess,
} from './system.service.js';
import {
  createSession,
  writeInput,
  resizeSession,
  sendSignal,
  killSession,
  listSessionsForUser,
} from './terminal.service.js';
import { resolveExistingPath, resolvePathForWrite } from '../security/workspace.js';
import { subsystemLogger } from '../utils/logger.js';

import type { AgentRecord } from './agent-pairing.service.js';

const log = subsystemLogger('agent-gateway');

/**
 * Agent message gateway.
 *
 * Each inbound JSON frame is validated against the host-agent protocol
 * schemas, dispatched to the backend capability that implements it, and
 * returned as a JSON reply string. The gateway never trusts the frame
 * shape — only validated fields reach the capability.
 */

function okReply(id: string, result: unknown): string {
  return JSON.stringify({ replyTo: id, ok: true, result });
}

function errReply(id: string, code: string, message: string): string {
  return JSON.stringify({ replyTo: id, ok: false, error: { code, message } });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Internal error';
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    return (error as { code: string }).code;
  }
  return 'INTERNAL_ERROR';
}

export async function dispatchAgentMessage(
  record: AgentRecord,
  rawFrame: string
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return errReply('unknown', 'VALIDATION_FAILED', 'Frame is not valid JSON');
  }

  const frame = parsed as Record<string, unknown>;
  const id = typeof frame.id === 'string' ? frame.id : 'unknown';
  const type = typeof frame.type === 'string' ? frame.type : '';

  // Hello is handled at the WS layer — we never see it here.
  if (type === 'hello') {
    return null;
  }

  try {
    const result = await handleRequest(record, type, frame);
    return okReply(id, result);
  } catch (error) {
    log.warn({ err: error, agentId: record.agentId, type }, 'agent request failed');
    const code = errorCode(error);
    const message = code.startsWith('INTERNAL') ? 'Internal error' : errorMessage(error);
    return errReply(id, code, message);
  }
}

async function handleRequest(
  record: AgentRecord,
  type: string,
  frame: Record<string, unknown>
): Promise<unknown> {
  const params = (
    typeof frame.params === 'object' && frame.params !== null ? frame.params : {}
  ) as Record<string, unknown>;
  const ownerUserId = record.ownerUserId;

  switch (type) {
    case 'system.info':
      return getSystemInfo();

    case 'processes.list':
      return listProcesses({
        limit: Math.min(Number(params.limit) || 100, 500),
        sortBy: (params.sortBy as 'memory' | 'pid' | 'name') ?? undefined,
        search: typeof params.search === 'string' ? params.search : undefined,
      });

    case 'processes.signal': {
      const pid = Number(params.pid);
      const signal = params.signal;
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid pid');
      if (
        typeof signal !== 'string' ||
        !ALLOWED_PROCESS_SIGNALS.includes(signal as (typeof ALLOWED_PROCESS_SIGNALS)[number])
      ) {
        throw new Error('Invalid signal');
      }
      await signalProcess(pid, signal as (typeof ALLOWED_PROCESS_SIGNALS)[number]);
      return { signalled: true, pid, signal };
    }

    case 'files.list': {
      const relative = typeof params.path === 'string' ? params.path : '';
      const resolved = await resolveExistingPath(relative);
      const st = await stat(resolved.absolute);
      if (!st.isDirectory()) throw new Error('Path is not a directory');
      const entries = await readdir(resolved.absolute, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        const childPath = path.join(resolved.absolute, entry.name);
        const childSt = await stat(childPath);
        const relPath = resolved.relative ? `${resolved.relative}/${entry.name}` : entry.name;
        result.push({
          name: entry.name,
          path: relPath,
          type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
          size: childSt.size,
          mtime: new Date(childSt.mtime).toISOString(),
          mode: entry.isSymbolicLink() ? '' : childSt.mode.toString(8).slice(-4),
        });
      }
      return {
        entries: result.sort(
          (a: { name: string; type: string }, b: { name: string; type: string }) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
          }
        ),
      };
    }

    case 'files.read': {
      if (typeof params.path !== 'string') throw new Error('path is required');
      const resolved = await resolveExistingPath(params.path);
      if (!resolved.exists) throw new Error('File does not exist');
      const content = await readFile(resolved.absolute);
      return { contentBase64: content.toString('base64') };
    }

    case 'files.write': {
      if (typeof params.path !== 'string') throw new Error('path is required');
      if (typeof params.contentBase64 !== 'string') throw new Error('contentBase64 is required');
      const resolved = await resolvePathForWrite(params.path, { createParents: false });
      const content = Buffer.from(params.contentBase64, 'base64');
      await writeFile(resolved.absolute, content);
      return { written: true, path: params.path, bytes: content.length };
    }

    case 'files.delete': {
      if (typeof params.path !== 'string') throw new Error('path is required');
      const resolved = await resolveExistingPath(params.path);
      if (!resolved.exists) throw new Error('Path does not exist');
      const st = await stat(resolved.absolute);
      if (st.isDirectory()) {
        const entries = await readdir(resolved.absolute);
        if (entries.length > 0) throw new Error('Refusing to delete a non-empty directory');
        await rmdir(resolved.absolute);
      } else {
        await unlink(resolved.absolute);
      }
      return { deleted: true, path: params.path };
    }

    case 'files.mkdir': {
      if (typeof params.path !== 'string') throw new Error('path is required');
      const resolved = await resolvePathForWrite(params.path, { createParents: false });
      if (resolved.exists) throw new Error('Path already exists');
      await mkdir(resolved.absolute, { recursive: false });
      return { created: true, path: params.path };
    }

    case 'terminal.create': {
      const session = await createSession({
        ownerUserId,
        cols: Number(params.cols) || 80,
        rows: Number(params.rows) || 24,
        cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        shell: typeof params.shell === 'string' ? params.shell : undefined,
      });
      return session;
    }

    case 'terminal.list':
      return { sessions: listSessionsForUser(ownerUserId) };

    case 'terminal.input': {
      if (typeof params.id !== 'string') throw new Error('id is required');
      if (typeof params.data !== 'string') throw new Error('data is required');
      writeInput(params.id, ownerUserId, params.data);
      return { accepted: true };
    }

    case 'terminal.resize': {
      if (typeof params.id !== 'string') throw new Error('id is required');
      resizeSession(params.id, ownerUserId, Number(params.cols) || 80, Number(params.rows) || 24);
      return { resized: true };
    }

    case 'terminal.signal': {
      if (typeof params.id !== 'string') throw new Error('id is required');
      const sig = params.signal;
      if (typeof sig !== 'string') throw new Error('signal is required');
      sendSignal(params.id, ownerUserId, sig as 'SIGINT' | 'SIGTERM' | 'SIGKILL');
      return { signalled: true };
    }

    case 'terminal.kill': {
      if (typeof params.id !== 'string') throw new Error('id is required');
      const killed = killSession(params.id, 'backend_request');
      return { killed };
    }

    default:
      throw new Error(`Unsupported message type: ${type}`);
  }
}
