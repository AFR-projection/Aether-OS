import { Buffer } from 'node:buffer';
import path from 'node:path';

import { LIMITS, type DirectoryListing, type FileEntry, type ReadFileResponse } from '@aether/shared';

import { sendAgentRequest } from './agent-rpc.service.js';
import { getMimeType } from './files.service.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/errors.js';

/**
 * Host-scope filesystem operations.
 *
 * These mirror `files.service` but run against a connected host agent instead of
 * this backend's own sandbox: each call proxies to the agent over RPC and adapts
 * the agent's compact reply into the same `FileEntry` / `DirectoryListing` /
 * `ReadFileResponse` shapes the workspace-scope routes return, so the Files app
 * and Code Studio consume both scopes through one set of types.
 *
 * The agent enforces its own path containment against its configured root, so a
 * local agent running as root on the VPS is what turns this into real,
 * whole-host file access. The set of operations here is exactly what the agent
 * protocol exposes today: list, read, write, mkdir, delete.
 */

interface AgentListEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: string;
  mode: string;
}

/** Fills the fields the agent does not report so the entry matches `FileEntry`. */
function toFileEntry(entry: AgentListEntry): FileEntry {
  const mtime = entry.mtime && entry.mtime.length > 0 ? entry.mtime : new Date(0).toISOString();
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.type === 'directory' ? 0 : Number(entry.size) || 0,
    modifiedAt: mtime,
    createdAt: mtime,
    mode: entry.mode || '000',
    // The agent does not probe per-entry access; the operation itself is the
    // authoritative check, exactly as in workspace scope.
    readable: true,
    writable: true,
    // Host entries are already inside the agent's own root; there is no separate
    // "workspace" for them to escape, so links are shown as ordinary links.
    symlinkTarget: null,
    escapesWorkspace: false,
  };
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ServiceUnavailableError(`The host agent returned an unexpected ${context} reply`);
  }
  return value as Record<string, unknown>;
}

export async function hostListDirectory(
  agentId: string,
  relative: string,
  showHidden: boolean
): Promise<DirectoryListing> {
  const reply = expectRecord(
    await sendAgentRequest(agentId, 'files.list', { path: relative }),
    'directory'
  );
  const rawEntries = Array.isArray(reply.entries) ? (reply.entries as AgentListEntry[]) : [];

  const visible = showHidden ? rawEntries : rawEntries.filter((e) => !e.name.startsWith('.'));
  const truncated = visible.length > LIMITS.MAX_DIRECTORY_ENTRIES;
  const entries = visible.slice(0, LIMITS.MAX_DIRECTORY_ENTRIES).map(toFileEntry);

  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

  const parent = relative === '' ? null : path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);

  return { path: relative, parent, entries, truncated };
}

export async function hostReadFile(agentId: string, relative: string): Promise<ReadFileResponse> {
  const reply = expectRecord(await sendAgentRequest(agentId, 'files.read', { path: relative }), 'read');
  if (typeof reply.contentBase64 !== 'string') {
    throw new ServiceUnavailableError('The host agent returned no file content');
  }

  const buffer = Buffer.from(reply.contentBase64, 'base64');
  const mimeType = getMimeType(relative);
  const looksTextual =
    mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
  const encoding: 'utf8' | 'base64' = looksTextual ? 'utf8' : 'base64';

  const readLimit = Math.min(buffer.length, LIMITS.MAX_FILE_READ_BYTES);
  const truncated = buffer.length > readLimit;
  const slice = buffer.subarray(0, readLimit);

  return {
    path: relative,
    encoding,
    content: slice.toString(encoding === 'utf8' ? 'utf8' : 'base64'),
    size: buffer.length,
    truncated,
    mimeType,
  };
}

export interface HostWriteOptions {
  relative: string;
  content: string;
  encoding: 'utf8' | 'base64';
  createOnly: boolean;
}

export async function hostWriteFile(agentId: string, options: HostWriteOptions): Promise<FileEntry> {
  const buffer = Buffer.from(options.content, options.encoding === 'utf8' ? 'utf8' : 'base64');

  // The agent write always overwrites, so "create only" is enforced here with a
  // pre-check. It is best-effort (a race is possible), matching how the
  // workspace path treats the pre-check as a better error, not the guarantee.
  if (options.createOnly) {
    let exists = true;
    try {
      await sendAgentRequest(agentId, 'files.read', { path: options.relative });
    } catch (error) {
      if (error instanceof NotFoundError) exists = false;
      else throw error;
    }
    if (exists) {
      throw new ConflictError('File already exists', { path: options.relative });
    }
  }

  await sendAgentRequest(agentId, 'files.write', {
    path: options.relative,
    contentBase64: buffer.toString('base64'),
  });

  return synthesizeEntry(options.relative, 'file', buffer.length);
}

export async function hostCreateDirectory(agentId: string, relative: string): Promise<FileEntry> {
  await sendAgentRequest(agentId, 'files.mkdir', { path: relative });
  return synthesizeEntry(relative, 'directory', 0);
}

export async function hostDeletePath(agentId: string, relative: string): Promise<void> {
  await sendAgentRequest(agentId, 'files.delete', { path: relative });
}

/**
 * Builds a `FileEntry` for an item the agent just created.
 *
 * The write/mkdir replies carry no stat, and re-listing to fetch one would cost
 * a round trip the caller does not need: every UI path invalidates and re-lists
 * the directory anyway. Timestamps are stamped now; mode is a conventional
 * default until the next listing reports the real bits.
 */
function synthesizeEntry(relative: string, type: 'file' | 'directory', size: number): FileEntry {
  const now = new Date().toISOString();
  return {
    name: path.posix.basename(relative),
    path: relative,
    type,
    size,
    modifiedAt: now,
    createdAt: now,
    mode: type === 'directory' ? '755' : '644',
    readable: true,
    writable: true,
    symlinkTarget: null,
    escapesWorkspace: false,
  };
}
