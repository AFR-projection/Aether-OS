import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isSafeRelativePath, normalizeRelativePath } from '@aether/shared';

import { config } from '../config.js';
import { PathRejectedError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

import type { Stats } from 'node:fs';

const log = subsystemLogger('workspace');

/**
 * Workspace sandbox.
 *
 * Every filesystem operation the Web UI can trigger goes through this module.
 * The rules are:
 *
 * 1. Input must be a relative path. Absolute paths, `~`, drive letters, and
 *    `..` segments are rejected before touching the disk.
 * 2. For reads the path is resolved with `fs.realpath`, which follows every
 *    symlink, and the *resolved* path must still be inside the workspace root.
 *    This defeats symlink escapes such as `workspace/escape -> /etc`.
 * 3. For writes the parent directory is resolved with `fs.realpath` and must be
 *    inside the root, and the final segment must not be a symlink (a symlink
 *    target would otherwise be overwritten outside the sandbox).
 *
 * Rejection is always an error, never a silent rewrite: silently clamping a
 * path would let a caller believe it read a different file than it did.
 */

let workspaceRootPromise: Promise<string> | null = null;

/**
 * Returns the canonical (symlink-resolved) workspace root, creating the
 * directory if it does not exist yet.
 */
export function getWorkspaceRoot(): Promise<string> {
  workspaceRootPromise ??= (async () => {
    const configured = path.resolve(config.AETHER_WORKSPACE_ROOT);
    await mkdir(configured, { recursive: true });
    const resolved = await realpath(configured);
    log.info({ workspaceRoot: resolved }, 'workspace root resolved');
    return resolved;
  })();

  return workspaceRootPromise;
}

/** Test-only hook: clears the memoised root so a new root can be picked up. */
export function resetWorkspaceRootCache(): void {
  workspaceRootPromise = null;
}

/**
 * Case-insensitive path containment check on Windows, case-sensitive elsewhere.
 *
 * Windows filesystems are case-insensitive, so `C:\Data\Ws` and `c:\data\ws`
 * are the same directory. Comparing them case-sensitively would reject valid
 * paths on a developer machine, so the comparison follows the platform.
 */
function isInside(parent: string, child: string): boolean {
  const normalize = (value: string): string => {
    const withoutTrailing = value.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? withoutTrailing.toLowerCase() : withoutTrailing;
  };

  const normalisedParent = normalize(parent);
  const normalisedChild = normalize(child);

  if (normalisedParent === normalisedChild) return true;
  return normalisedChild.startsWith(`${normalisedParent}${path.sep}`);
}

/**
 * Validates the *shape* of a client-supplied relative path.
 * Throws `PathRejectedError` when the path could never be safe.
 */
export function assertSafeRelativePath(relative: string): string {
  if (!isSafeRelativePath(relative)) {
    log.warn({ relative }, 'rejected unsafe relative path');
    throw new PathRejectedError('Path contains disallowed segments');
  }
  return normalizeRelativePath(relative);
}

/** Joins a validated relative path onto the workspace root. */
export function joinToRoot(root: string, relative: string): string {
  const normalised = normalizeRelativePath(relative);
  return normalised === '' ? root : path.join(root, ...normalised.split('/'));
}

/** Converts an absolute path back into a workspace-relative POSIX path. */
export async function toRelativePath(absolute: string): Promise<string> {
  const root = await getWorkspaceRoot();
  if (!isInside(root, absolute)) {
    throw new PathRejectedError('Path is outside the workspace');
  }
  const relative = path.relative(root, absolute);
  return normalizeRelativePath(relative);
}

export interface ResolvedPath {
  /** Canonical absolute path. For reads this has every symlink resolved. */
  absolute: string;
  /** Workspace-relative POSIX path. */
  relative: string;
  /** True when the target exists on disk. */
  exists: boolean;
}

/**
 * Resolves an existing path for reading.
 *
 * Every symlink in the chain is resolved and the result must remain inside the
 * workspace root. Symlinks that point outside are rejected.
 */
export async function resolveExistingPath(relative: string): Promise<ResolvedPath> {
  const root = await getWorkspaceRoot();
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
    log.warn({ relative, resolved }, 'rejected path escaping workspace via symlink');
    throw new PathRejectedError('Path resolves outside the workspace');
  }

  return {
    absolute: resolved,
    relative: normalizeRelativePath(path.relative(root, resolved)),
    exists: true,
  };
}

export interface ResolveWriteOptions {
  /**
   * Allow the parent directories to be missing, so `mkdir -p`-style creation
   * works. The deepest *existing* ancestor is resolved with `realpath` and must
   * still be inside the workspace, so an attacker cannot use a symlinked
   * ancestor to escape merely because the intermediate directories do not exist
   * yet. Defaults to false: a plain file write never invents directories.
   */
  createParents?: boolean;
}

/**
 * Resolves a path for writing.
 *
 * The parent directory must resolve inside the workspace. If the target itself
 * exists it must not be a symlink, otherwise a write would follow the link out
 * of the sandbox.
 */
export async function resolvePathForWrite(
  relative: string,
  options: ResolveWriteOptions = {}
): Promise<ResolvedPath> {
  const root = await getWorkspaceRoot();
  const safeRelative = assertSafeRelativePath(relative);

  if (safeRelative === '') {
    throw new PathRejectedError('Cannot write to the workspace root itself');
  }

  const segments = safeRelative.split('/');
  const leaf = segments[segments.length - 1] as string;
  let parentSegments = segments.slice(0, -1);
  /** Segments below the deepest existing ancestor, outermost first. */
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
    log.warn({ relative, resolvedParent }, 'rejected write through symlinked parent');
    throw new PathRejectedError('Parent directory resolves outside the workspace');
  }

  const target = path.join(resolvedParent, ...missingSegments, leaf);

  let leafStat: Stats | null = null;
  try {
    // `lstat` does not follow the final symlink, so a link is reported as a link
    // rather than as its target.
    leafStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (leafStat) {
    if (leafStat.isSymbolicLink()) {
      log.warn({ relative }, 'rejected write to a symbolic link');
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
