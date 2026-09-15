import { createReadStream, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile as writeFileFs,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { LIMITS, type DirectoryListing, type FileEntry, type FileEntryType, type ReadFileResponse } from '@aether/shared';

import { config } from '../config.js';
import { ConflictError, NotFoundError, PathRejectedError, PayloadTooLargeError } from '../utils/errors.js';

import { getWorkspaceRoot, joinToRoot, resolveExistingPath, resolvePathForWrite } from '../security/workspace.js';

/**
 * Filesystem operations inside the workspace sandbox.
 *
 * Every public function here takes a *workspace-relative* path. Absolute paths
 * never reach this module: the route layer validates the shape and the
 * `security/workspace` module resolves and re-checks containment against the
 * real, symlink-resolved root.
 */

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.ini': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/plain',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** Extensions we are willing to return as UTF-8 text. */
const TEXT_EXTENSIONS = new Set(
  Object.entries(MIME_TYPES)
    .filter(([, mime]) => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml')
    .map(([extension]) => extension),
);

export function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

function classify(stats: Stats): FileEntryType {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSocket()) return 'socket';
  return 'other';
}

async function toEntry(root: string, absolutePath: string, name: string): Promise<FileEntry> {
  const linkStats = await lstat(absolutePath);
  const type = classify(linkStats);

  let targetStats = linkStats;
  let symlinkTarget: string | null = null;
  let escapesWorkspace = false;

  if (type === 'symlink') {
    symlinkTarget = await readlink(absolutePath).catch(() => null);

    try {
      const resolved = await realpath(absolutePath);
      const resolvedRoot = root.endsWith(path.sep) ? root : root + path.sep;
      // Compare against the root with a trailing separator so a sibling
      // directory whose name starts with the root's name is not accepted.
      escapesWorkspace =
        resolved !== root && !resolved.toLowerCase().startsWith(resolvedRoot.toLowerCase());
      targetStats = await stat(absolutePath);
    } catch {
      // Broken symlink — listed, but not followable.
      escapesWorkspace = true;
    }
  }

  const relative = path.relative(root, absolutePath).split(path.sep).join('/');

  return {
    name,
    path: relative,
    type,
    size: targetStats.isDirectory() ? 0 : Number(targetStats.size),
    modifiedAt: targetStats.mtime.toISOString(),
    createdAt: targetStats.birthtime.toISOString(),
    mode: (targetStats.mode & 0o777).toString(8).padStart(3, '0'),
    // `fs.access` checks are TOCTOU-prone; mode bits are reported as a hint and
    // the actual operation is what fails if permission is missing.
    readable: true,
    writable: true,
    symlinkTarget,
    escapesWorkspace,
  };
}

export interface ListDirectoryOptions {
  relative: string;
  showHidden: boolean;
}

export async function listDirectory(options: ListDirectoryOptions): Promise<DirectoryListing> {
  const root = await getWorkspaceRoot();
  const resolved = await resolveExistingPath(options.relative);

  if (!resolved.exists) {
    throw new NotFoundError('Directory does not exist', { path: options.relative });
  }

  const stats = await lstat(resolved.absolute);
  if (!stats.isDirectory()) {
    throw new PathRejectedError('Path is not a directory', { path: options.relative });
  }

  const dirents = await readdir(resolved.absolute, { withFileTypes: true });

  const visible = options.showHidden ? dirents : dirents.filter((entry) => !entry.name.startsWith('.'));

  const truncated = visible.length > LIMITS.MAX_DIRECTORY_ENTRIES;
  const selected = visible.slice(0, LIMITS.MAX_DIRECTORY_ENTRIES);

  const entries = await Promise.all(
    selected.map(async (entry) => {
      try {
        return await toEntry(root, path.join(resolved.absolute, entry.name), entry.name);
      } catch {
        // An entry that disappears between readdir and lstat (a log file being
        // rotated, for example) is skipped rather than failing the whole listing.
        return null;
      }
    }),
  );

  const filtered = entries.filter((entry): entry is FileEntry => entry !== null);

  filtered.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

  const parentRelative = path.posix.dirname(resolved.relative);

  return {
    path: resolved.relative,
    parent: resolved.relative === '' ? null : parentRelative === '.' ? '' : parentRelative,
    entries: filtered,
    truncated,
  };
}

export async function statPath(relative: string): Promise<FileEntry> {
  const root = await getWorkspaceRoot();
  const resolved = await resolveExistingPath(relative);

  if (!resolved.exists) {
    throw new NotFoundError('Path does not exist', { path: relative });
  }

  return toEntry(root, resolved.absolute, path.basename(resolved.absolute));
}

/** Resolves a path for reading and asserts it is a regular file within limits. */
async function assertReadableFile(relative: string): Promise<{ absolute: string; size: number }> {
  const resolved = await resolveExistingPath(relative);

  if (!resolved.exists) {
    throw new NotFoundError('File does not exist', { path: relative });
  }

  const stats = await stat(resolved.absolute);
  if (!stats.isFile()) {
    throw new PathRejectedError('Path is not a regular file', { path: relative });
  }

  if (stats.size > config.MAX_FILE_SIZE) {
    throw new PayloadTooLargeError('File exceeds the maximum readable size', {
      size: stats.size,
      limit: config.MAX_FILE_SIZE,
    });
  }

  return { absolute: resolved.absolute, size: stats.size };
}

/**
 * Reads a file for display in the Files app.
 *
 * Files larger than `MAX_FILE_READ_BYTES` are truncated rather than rejected so
 * a large log file is still inspectable. Binary files are returned base64.
 */
export async function readFile(relative: string, forceEncoding?: 'utf8' | 'base64'): Promise<ReadFileResponse> {
  const { absolute, size } = await assertReadableFile(relative);
  const mimeType = getMimeType(absolute);
  const extension = path.extname(absolute).toLowerCase();

  const looksTextual = TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/');
  const encoding = forceEncoding ?? (looksTextual ? 'utf8' : 'base64');

  const readLimit = Math.min(size, LIMITS.MAX_FILE_READ_BYTES);
  const truncated = size > readLimit;

  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(readLimit);
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
    const slice = buffer.subarray(0, bytesRead);

    return {
      path: relative,
      encoding,
      content: slice.toString(encoding === 'utf8' ? 'utf8' : 'base64'),
      size,
      truncated,
      mimeType,
    };
  } finally {
    await handle.close();
  }
}

export interface WriteFileOptions {
  relative: string;
  content: string;
  encoding: 'utf8' | 'base64';
  createOnly: boolean;
}

export async function writeFile(options: WriteFileOptions): Promise<FileEntry> {
  const buffer = Buffer.from(options.content, options.encoding === 'utf8' ? 'utf8' : 'base64');

  if (buffer.byteLength > config.MAX_FILE_SIZE) {
    throw new PayloadTooLargeError('Content exceeds the maximum file size', {
      size: buffer.byteLength,
      limit: config.MAX_FILE_SIZE,
    });
  }

  const target = await resolvePathForWrite(options.relative);

  if (options.createOnly && target.exists) {
    throw new ConflictError('File already exists', { path: options.relative });
  }

  const existing = target.exists ? await stat(target.absolute) : null;
  if (existing?.isDirectory()) {
    throw new PathRejectedError('Path is a directory', { path: options.relative });
  }

  // `wx` makes "create only" atomic; the pre-check above is for a better error
  // message, not for correctness.
  await writeFileFs(target.absolute, buffer, options.createOnly ? { flag: 'wx' } : undefined);

  const root = await getWorkspaceRoot();
  return toEntry(root, target.absolute, path.basename(target.absolute));
}

export async function createDirectory(relative: string, recursive: boolean): Promise<FileEntry> {
  // `createParents: recursive` is what makes `mkdir -p` actually work: without
  // it the sandbox refuses to resolve a path whose parent does not exist yet.
  const target = await resolvePathForWrite(relative, { createParents: recursive });

  if (target.exists) {
    throw new ConflictError('Path already exists', { path: relative });
  }

  await mkdir(target.absolute, { recursive });

  const root = await getWorkspaceRoot();
  return toEntry(root, target.absolute, path.basename(target.absolute));
}

export interface RenameOptions {
  from: string;
  to: string;
  overwrite: boolean;
}

export async function renamePath(options: RenameOptions): Promise<FileEntry> {
  const source = await resolveExistingPath(options.from);
  if (!source.exists) {
    throw new NotFoundError('Source path does not exist', { path: options.from });
  }

  if (source.relative === '') {
    throw new PathRejectedError('Cannot rename the workspace root');
  }

  const destination = await resolvePathForWrite(options.to);

  if (destination.exists && !options.overwrite) {
    throw new ConflictError('Destination already exists', { path: options.to });
  }

  // Refuse to move a directory inside itself — `rename` would fail with EINVAL
  // on Linux, but a clear error is better than an errno.
  if (destination.relative.startsWith(`${source.relative}/`)) {
    throw new PathRejectedError('Cannot move a directory into itself');
  }

  await rename(source.absolute, destination.absolute);

  const root = await getWorkspaceRoot();
  return toEntry(root, destination.absolute, path.basename(destination.absolute));
}

export async function deletePath(relative: string, recursive: boolean): Promise<void> {
  const resolved = await resolveExistingPath(relative);

  if (!resolved.exists) {
    throw new NotFoundError('Path does not exist', { path: relative });
  }

  if (resolved.relative === '') {
    throw new PathRejectedError('Cannot delete the workspace root');
  }

  const stats = await lstat(resolved.absolute);

  if (stats.isDirectory() && !recursive) {
    const children = await readdir(resolved.absolute);
    if (children.length > 0) {
      throw new ConflictError('Directory is not empty; set recursive to delete it', {
        path: relative,
        entries: children.length,
      });
    }
  }

  await rm(resolved.absolute, { recursive, force: false });
}

export interface SearchOptions {
  relative: string;
  query: string;
  limit: number;
}

/**
 * Case-insensitive substring search over entry names.
 *
 * This is a name search, not a content search. File *content* indexing is not
 * implemented; see `KNOWN-LIMITATIONS.md`.
 */
export async function searchEntries(options: SearchOptions): Promise<FileEntry[]> {
  const root = await getWorkspaceRoot();
  const start = await resolveExistingPath(options.relative);

  if (!start.exists) {
    throw new NotFoundError('Search root does not exist', { path: options.relative });
  }

  const needle = options.query.toLowerCase();
  const results: FileEntry[] = [];
  const queue: string[] = [start.absolute];
  let visited = 0;

  while (queue.length > 0 && results.length < options.limit && visited < 20_000) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      const absolute = path.join(current, dirent.name);
      try {
        const entry = await toEntry(root, absolute, dirent.name);
        if (dirent.name.toLowerCase().includes(needle)) {
          results.push(entry);
          if (results.length >= options.limit) break;
        }
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
          queue.push(absolute);
        }
      } catch {
        continue;
      }
    }
  }

  return results;
}

/** Opens a readable stream for the download endpoint. */
export async function openReadStream(relative: string): Promise<{ stream: NodeJS.ReadableStream; size: number; name: string }> {
  const { absolute, size } = await assertReadableFile(relative);
  return {
    stream: createReadStream(absolute),
    size,
    name: path.basename(absolute),
  };
}

/** Ensures the configured upload directory exists inside the workspace. */
export async function ensureUploadDirectory(): Promise<string> {
  const root = await getWorkspaceRoot();
  const uploadsRelative = config.UPLOAD_DIR.replace(/^\.\//, '');
  const absolute = joinToRoot(root, uploadsRelative);
  await mkdir(absolute, { recursive: true });
  return absolute;
}

/**
 * Streams an upload to disk, enforcing a hard byte ceiling.
 *
 * The ceiling is enforced while writing rather than by trusting a
 * `Content-Length` header, because that header is attacker-controlled. If the
 * limit is exceeded the partial file is removed before the error propagates, so
 * a rejected upload never leaves a truncated file in place.
 */
export async function streamToFile(
  relativeDirectory: string,
  fileName: string,
  source: Readable,
  maxBytes: number,
): Promise<FileEntry> {
  const relative = relativeDirectory === '' ? fileName : `${relativeDirectory}/${fileName}`;
  const target = await resolvePathForWrite(relative);

  const root = await getWorkspaceRoot();
  const handle = await open(target.absolute, 'w');

  let written = 0;
  let aborted = false;

  try {
    const writable = handle.createWriteStream();

    await new Promise<void>((resolve, reject) => {
      source.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > maxBytes) {
          aborted = true;
          source.destroy(new PayloadTooLargeError('Upload exceeds the maximum file size', {
            limit: maxBytes,
          }));
        }
      });

      source.on('error', reject);
      writable.on('error', reject);
      writable.on('finish', resolve);

      source.pipe(writable);
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target.absolute, { force: true }).catch(() => undefined);
    throw error;
  }

  await handle.close();

  if (aborted) {
    await rm(target.absolute, { force: true }).catch(() => undefined);
    throw new PayloadTooLargeError('Upload exceeds the maximum file size', { limit: maxBytes });
  }

  return toEntry(root, target.absolute, path.basename(target.absolute));
}
