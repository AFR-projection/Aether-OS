import { Buffer } from 'node:buffer';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  LIMITS,
  type DirectoryListing,
  type FileEntry,
  type ReadFileResponse,
} from '@aether/shared';

import { sendAgentRequest } from './agent-rpc.service.js';
import { classifyContent, getMimeType } from './files.service.js';
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

  const parent =
    relative === ''
      ? null
      : path.posix.dirname(relative) === '.'
        ? ''
        : path.posix.dirname(relative);

  return { path: relative, parent, entries, truncated };
}

export async function hostReadFile(agentId: string, relative: string): Promise<ReadFileResponse> {
  const reply = expectRecord(
    await sendAgentRequest(agentId, 'files.read', { path: relative }),
    'read'
  );
  if (typeof reply.contentBase64 !== 'string') {
    throw new ServiceUnavailableError('The host agent returned no file content');
  }

  const buffer = Buffer.from(reply.contentBase64, 'base64');

  const readLimit = Math.min(buffer.length, LIMITS.MAX_FILE_READ_BYTES);
  const truncated = buffer.length > readLimit;
  const slice = buffer.subarray(0, readLimit);

  // A host path is even less likely than a workspace one to carry a telling
  // extension — `/etc/hostname`, `.env`, `Dockerfile`, `id_rsa` — so this leans
  // on the content check rather than the name. Same helper as the workspace
  // reader, so the two scopes cannot disagree about the same bytes.
  const { encoding, mimeType } = classifyContent(relative, slice);

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

export async function hostWriteFile(
  agentId: string,
  options: HostWriteOptions
): Promise<FileEntry> {
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

export async function hostDeletePath(
  agentId: string,
  relative: string,
  recursive = false
): Promise<void> {
  await sendAgentRequest(agentId, 'files.delete', { path: relative, recursive });
}

export async function hostRenamePath(
  agentId: string,
  options: { from: string; to: string; overwrite: boolean }
): Promise<FileEntry> {
  const reply = expectRecord(
    await sendAgentRequest(agentId, 'files.rename', {
      from: options.from,
      to: options.to,
      overwrite: options.overwrite,
    }),
    'rename'
  );

  const entry = reply.entry as AgentListEntry | undefined;
  if (!entry || typeof entry.path !== 'string') {
    // The rename succeeded — the agent answered ok — so failing here would
    // report a change that did happen as though it had not. Synthesize the
    // entry from the destination the caller named instead.
    return synthesizeEntry(options.to, 'file', 0);
  }

  return toFileEntry(entry);
}

/**
 * Size and content type of a host file, in one round trip.
 *
 * The agent's chunk reply carries the file's full size alongside the bytes it
 * was asked for, so the cheapest way to learn a size is to ask for a small read
 * and throw the bytes away — except they are not thrown away here. The sample
 * goes through the same content classification the editor's reader uses, which
 * is what gives a host file with no extension (`favicon`, a copied `photo`) the
 * right `Content-Type` instead of `application/octet-stream`, and the browser's
 * media element something it is willing to play.
 */
export async function hostProbeFile(
  agentId: string,
  relative: string
): Promise<{ size: number; name: string; mimeType: string }> {
  const sampleBytes = 4 * 1024;
  const reply = expectRecord(
    await sendAgentRequest(agentId, 'files.readChunk', {
      path: relative,
      offset: 0,
      length: sampleBytes,
    }),
    'read'
  );

  const size = typeof reply.size === 'number' ? reply.size : 0;
  const name = path.posix.basename(relative);
  const sample =
    typeof reply.contentBase64 === 'string'
      ? Buffer.from(reply.contentBase64, 'base64')
      : Buffer.alloc(0);

  // A probe that reads nothing must not decide the type from an empty buffer:
  // `classifyContent` would call an empty sample textual and hand a video
  // `text/plain`.
  if (sample.length === 0) {
    return { size, name, mimeType: getMimeType(relative) };
  }

  return { size, name, mimeType: classifyContent(relative, sample).mimeType };
}

/**
 * Streams a byte range of a host file as a Node readable.
 *
 * Each chunk crosses the agent's WebSocket as base64 in its own request/reply,
 * which is why the chunk size is bounded by the frame limit rather than by
 * anything about the file. The generator stops on a short read: the agent
 * returns fewer bytes than asked for only when the file ended, and asking again
 * would cost a round trip to be told the same thing.
 *
 * A host file is not on this container's filesystem, so there is no fd to hand
 * to `createReadStream` — this is the whole reason the range has to be pulled
 * rather than pushed.
 */
export function hostOpenRange(
  agentId: string,
  relative: string,
  range: { start: number; end: number }
): NodeJS.ReadableStream {
  const { start, end } = range;

  async function* chunks(): AsyncGenerator<Buffer> {
    let offset = start;

    while (offset <= end) {
      const length = Math.min(LIMITS.HOST_STREAM_CHUNK_BYTES, end - offset + 1);
      const reply = expectRecord(
        await sendAgentRequest(agentId, 'files.readChunk', { path: relative, offset, length }),
        'read'
      );

      if (typeof reply.contentBase64 !== 'string') {
        throw new ServiceUnavailableError('The host agent returned no file content');
      }

      const chunk = Buffer.from(reply.contentBase64, 'base64');
      if (chunk.length === 0) return;

      yield chunk;
      offset += chunk.length;

      // A short read is the agent telling us the file ended.
      if (chunk.length < length) return;
    }
  }

  return Readable.from(chunks());
}

/**
 * Writes a whole buffer to a host file in chunks.
 *
 * Uploads arrive as a stream on this side and have to leave as framed messages
 * on the other, so the bytes are buffered to one frame's worth and flushed as
 * each full chunk accumulates. The first flush truncates: without that, a small
 * new file landing on a larger old one would keep the old file's tail.
 */
export async function hostWriteStream(
  agentId: string,
  relative: string,
  source: NodeJS.ReadableStream
): Promise<FileEntry> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let offset = 0;
  let first = true;

  const flush = async (): Promise<void> => {
    if (pendingBytes === 0 && !first) return;

    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;

    await sendAgentRequest(agentId, 'files.writeChunk', {
      path: relative,
      offset,
      contentBase64: chunk.toString('base64'),
      truncate: first,
    });

    offset += chunk.length;
    first = false;
  };

  for await (const raw of source) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending.push(buffer);
    pendingBytes += buffer.length;

    if (pendingBytes >= LIMITS.HOST_STREAM_CHUNK_BYTES) await flush();
  }

  await flush();
  return synthesizeEntry(relative, 'file', offset);
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
