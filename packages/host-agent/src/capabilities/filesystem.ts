import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, NotFoundError } from '../errors.js';
import { subsystemLogger } from '../logger.js';
import { joinToRoot, resolveExistingPath, resolvePathForWrite } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { Stats } from 'node:fs';

const log = subsystemLogger('filesystem');

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: string;
  mode: string;
}

function statsToFileEntry(name: string, fullPath: string, stats: Stats): FileEntry {
  let type: FileEntry['type'];
  if (stats.isSymbolicLink()) type = 'symlink';
  else if (stats.isDirectory()) type = 'directory';
  else type = 'file';

  return {
    name,
    path: fullPath,
    type,
    size: stats.size,
    mtime: new Date(stats.mtime).toISOString(),
    mode: type === 'symlink' ? '' : stats.mode.toString(8).slice(-4),
  };
}

export async function listFiles(cfg: AgentConfig, relative: string): Promise<FileEntry[]> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('Directory does not exist', { path: relative });
  }

  const statResult = await stat(resolved.absolute);
  if (!statResult.isDirectory()) {
    throw new NotFoundError('Path is not a directory', { path: relative });
  }

  const entries = await readdir(resolved.absolute, { withFileTypes: true });

  const result: FileEntry[] = [];
  for (const entry of entries) {
    const entryPath = resolved.relative === '' ? entry.name : `${resolved.relative}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      result.push({
        name: entry.name,
        path: entryPath,
        type: 'symlink',
        size: 0,
        mtime: '',
        mode: '',
      });
      continue;
    }

    const childPath = path.join(resolved.absolute, entry.name);
    const childStat = await stat(childPath);
    result.push(statsToFileEntry(entry.name, entryPath, childStat));
  }

  return result.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFileContent(cfg: AgentConfig, relative: string): Promise<Buffer> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('File does not exist', { path: relative });
  }

  const statResult = await stat(resolved.absolute);
  if (statResult.isDirectory()) {
    throw new NotFoundError('Path is a directory, not a file', { path: relative });
  }

  return readFile(resolved.absolute);
}

export interface ChunkResult {
  content: Buffer;
  /** Total size of the file, so a ranged reader learns the boundary it asked about. */
  size: number;
}

/**
 * Reads one byte range out of a file.
 *
 * The existing `files.read` returns a whole file, which is the wrong shape for
 * anything a browser plays or seeks: a video is far larger than one WebSocket
 * frame, and the only frame the reader cares about is the one the player asked
 * for. Reading a range keeps a 4 GB film as cheap to serve as a 4 KB icon, and
 * it is what makes HTTP `Range` requests answerable at all.
 *
 * The returned buffer is shorter than `length` when the request runs past the
 * end of the file — the caller compares `offset + content.length` against `size`
 * to tell a short read from a complete one.
 */
export async function readFileChunk(
  cfg: AgentConfig,
  relative: string,
  offset: number,
  length: number
): Promise<ChunkResult> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('File does not exist', { path: relative });
  }

  const stats = await stat(resolved.absolute);
  if (stats.isDirectory()) {
    throw new NotFoundError('Path is a directory, not a file', { path: relative });
  }

  if (offset >= stats.size) {
    return { content: Buffer.alloc(0), size: stats.size };
  }

  const toRead = Math.min(length, stats.size - offset);
  const handle = await open(resolved.absolute, 'r');
  try {
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
    return { content: buffer.subarray(0, bytesRead), size: stats.size };
  } finally {
    await handle.close();
  }
}

/**
 * Writes one byte range into a file, optionally truncating it first.
 *
 * The first chunk of an upload passes `truncate`, which is what stops a new file
 * landing on top of a longer old one and keeping that file's tail. Subsequent
 * chunks append at increasing offsets without it.
 */
export async function writeFileChunk(
  cfg: AgentConfig,
  relative: string,
  offset: number,
  content: Buffer,
  truncate: boolean
): Promise<number> {
  const resolved = await resolvePathForWrite(cfg, relative, { createParents: false });

  const handle = await open(resolved.absolute, truncate ? 'w' : 'r+');
  try {
    if (!truncate && offset > 0) {
      // `r+` on a file shorter than the offset would leave a hole of NUL bytes.
      // Creating it first keeps the append position honest.
      const stats = await handle.stat();
      if (stats.size < offset) {
        await handle.truncate(offset);
      }
    }
    const { bytesWritten } = await handle.write(content, 0, content.length, offset);
    return bytesWritten;
  } finally {
    await handle.close();
  }
}

export interface RenameOptions {
  from: string;
  to: string;
  overwrite: boolean;
}

export async function renameEntry(cfg: AgentConfig, options: RenameOptions): Promise<FileEntry> {
  const source = await resolveExistingPath(cfg, options.from);
  if (!source.exists) {
    throw new NotFoundError('Source path does not exist', { path: options.from });
  }

  const destination = await resolvePathForWrite(cfg, options.to, { createParents: false });

  if (destination.exists && !options.overwrite) {
    throw new ConflictError('Destination already exists', { path: options.to });
  }

  // A directory moved inside itself fails with EINVAL at the syscall; catching it
  // here means the caller gets a reason rather than an errno.
  if (source.relative !== '' && destination.relative.startsWith(`${source.relative}/`)) {
    throw new ConflictError('Cannot move a directory into itself');
  }

  await rename(source.absolute, destination.absolute);
  const stats = await stat(destination.absolute);
  return statsToFileEntry(path.posix.basename(destination.relative), destination.relative, stats);
}

export async function deleteEntry(
  cfg: AgentConfig,
  relative: string,
  recursive = false
): Promise<void> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('Path does not exist', { path: relative });
  }

  if (resolved.relative === '') {
    throw new ConflictError('Refusing to delete the root of the agent workspace');
  }

  const statResult = await stat(resolved.absolute);
  if (statResult.isDirectory()) {
    const entries = await readdir(resolved.absolute);
    if (entries.length > 0 && !recursive) {
      throw new ConflictError('Refusing to delete a non-empty directory', { path: relative });
    }
    // `rmdir` cannot remove a tree, and `rm -r` on a machine where the agent
    // runs as root is exactly the call that must not be sloppy about its
    // boundary — so `recursive` is honoured literally rather than being passed
    // through from the caller unexamined.
    await rm(resolved.absolute, { recursive, force: false });
  } else {
    await unlink(resolved.absolute);
  }

  log.info({ path: relative, recursive }, 'entry deleted');
}

export async function writeFileContent(
  cfg: AgentConfig,
  relative: string,
  content: Buffer | string,
  options?: { createParents?: boolean }
): Promise<void> {
  const resolved = await resolvePathForWrite(cfg, relative, {
    createParents: options?.createParents,
  });
  await writeFile(resolved.absolute, content);
}

export async function createDirectory(cfg: AgentConfig, relative: string): Promise<void> {
  const resolved = await resolvePathForWrite(cfg, relative, { createParents: false });

  if (resolved.exists) {
    throw new NotFoundError('Path already exists', { path: relative });
  }

  await mkdir(resolved.absolute, { recursive: false });
}

export async function fileStat(
  cfg: AgentConfig,
  relative: string
): Promise<{ entry: FileEntry; absolute: string }> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('Path does not exist', { path: relative });
  }

  const stats = await stat(resolved.absolute);
  const name = resolved.relative === '' ? '' : path.posix.basename(resolved.relative);
  return { entry: statsToFileEntry(name, resolved.relative, stats), absolute: resolved.absolute };
}

export { joinToRoot };
