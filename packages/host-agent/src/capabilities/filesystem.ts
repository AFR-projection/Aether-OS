import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { Stats } from 'node:fs';

import type { AgentConfig } from '../config.js';
import { NotFoundError } from '../errors.js';
import { subsystemLogger } from '../logger.js';
import {
  joinToRoot,
  resolveExistingPath,
  resolvePathForWrite,
} from '../security/workspace.js';

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
    const entryPath =
      resolved.relative === '' ? entry.name : `${resolved.relative}/${entry.name}`;

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

export async function writeFileContent(
  cfg: AgentConfig,
  relative: string,
  content: Buffer | string,
  options?: { createParents?: boolean },
): Promise<void> {
  const resolved = await resolvePathForWrite(cfg, relative, { createParents: options?.createParents });
  await writeFile(resolved.absolute, content);
}

export async function deleteEntry(cfg: AgentConfig, relative: string): Promise<void> {
  const resolved = await resolveExistingPath(cfg, relative);

  if (!resolved.exists) {
    throw new NotFoundError('Path does not exist', { path: relative });
  }

  const statResult = await stat(resolved.absolute);
  if (statResult.isDirectory()) {
    const entries = await readdir(resolved.absolute);
    if (entries.length > 0) {
      throw new NotFoundError('Refusing to delete a non-empty directory', { path: relative });
    }
    await rmdir(resolved.absolute);
  } else {
    await unlink(resolved.absolute);
  }

  log.info({ path: relative }, 'entry deleted');
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
  relative: string,
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
