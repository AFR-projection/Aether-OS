import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isSafeRelativePath, normalizeRelativePath } from '@aether/shared';

import { PathRejectedError } from '../errors.js';
import { getLogger } from '../logger.js';

import type { AgentConfig } from '../config.js';
import type { Stats } from 'node:fs';

let workspaceRootPromise: Promise<string> | null = null;

export function getWorkspaceRoot(cfg: AgentConfig): Promise<string> {
  workspaceRootPromise ??= (async () => {
    const configured = path.resolve(cfg.AETHER_WORKSPACE_ROOT);
    await mkdir(configured, { recursive: true });
    const resolved = await realpath(configured);
    getLogger().info({ workspaceRoot: resolved }, 'workspace root resolved');
    return resolved;
  })();
  return workspaceRootPromise;
}

export function resetWorkspaceRootCache(): void {
  workspaceRootPromise = null;
}

function isInside(parent: string, child: string): boolean {
  const normalize = (value: string): string => {
    const withoutTrailing = value.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? withoutTrailing.toLowerCase() : withoutTrailing;
  };
  const p = normalize(parent);
  const c = normalize(child);
  if (p === c) return true;
  return c.startsWith(`${p}${path.sep}`);
}

export function assertSafeRelativePath(relative: string): string {
  if (!isSafeRelativePath(relative)) {
    getLogger().warn({ relative }, 'rejected unsafe relative path');
    throw new PathRejectedError('Path contains disallowed segments');
  }
  return normalizeRelativePath(relative);
}

export function joinToRoot(root: string, relative: string): string {
  const normalised = normalizeRelativePath(relative);
  return normalised === '' ? root : path.join(root, ...normalised.split('/'));
}

export interface ResolvedPath {
  absolute: string;
  relative: string;
  exists: boolean;
}

export async function resolveExistingPath(
  cfg: AgentConfig,
  relative: string
): Promise<ResolvedPath> {
  const root = await getWorkspaceRoot(cfg);
  const safeRelative = assertSafeRelativePath(relative);
  const candidate = joinToRoot(root, safeRelative);

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { absolute: candidate, relative: safeRelative, exists: false };
    }
    throw error;
  }

  if (!isInside(root, resolved)) {
    getLogger().warn({ relative, resolved }, 'rejected path escaping workspace via symlink');
    throw new PathRejectedError('Path resolves outside the workspace');
  }

  return {
    absolute: resolved,
    relative: normalizeRelativePath(path.relative(root, resolved)),
    exists: true,
  };
}

export interface ResolveWriteOptions {
  createParents?: boolean;
}

export async function resolvePathForWrite(
  cfg: AgentConfig,
  relative: string,
  options: ResolveWriteOptions = {}
): Promise<ResolvedPath> {
  const root = await getWorkspaceRoot(cfg);
  const safeRelative = assertSafeRelativePath(relative);

  if (safeRelative === '') {
    throw new PathRejectedError('Cannot write to the workspace root itself');
  }

  const segments = safeRelative.split('/');
  const leaf = segments[segments.length - 1] as string;
  let parentSegments = segments.slice(0, -1);
  let missingSegments: string[] = [];

  let resolvedParent: string;
  for (;;) {
    try {
      resolvedParent = await realpath(joinToRoot(root, parentSegments.join('/')));
      break;
    } catch (error) {
      const canAscend =
        options.createParents === true &&
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        parentSegments.length > 0;
      if (!canAscend) throw error;
      missingSegments = [parentSegments[parentSegments.length - 1] as string, ...missingSegments];
      parentSegments = parentSegments.slice(0, -1);
    }
  }

  if (!isInside(root, resolvedParent)) {
    getLogger().warn({ relative, resolvedParent }, 'rejected write through symlinked parent');
    throw new PathRejectedError('Parent directory resolves outside the workspace');
  }

  const target = path.join(resolvedParent, ...missingSegments, leaf);

  let leafStat: Stats | null = null;
  try {
    leafStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (leafStat) {
    if (leafStat.isSymbolicLink()) {
      getLogger().warn({ relative }, 'rejected write to a symbolic link');
      throw new PathRejectedError('Refusing to write through a symbolic link');
    }
    const realTarget = await realpath(target);
    if (!isInside(root, realTarget)) {
      throw new PathRejectedError('Target resolves outside the workspace');
    }
  }

  return {
    absolute: target,
    relative: normalizeRelativePath(path.relative(root, target)),
    exists: leafStat !== null,
  };
}
