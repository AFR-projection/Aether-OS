/**
 * Workspace-relative path helpers.
 *
 * These functions are pure and dependency-free so they can be unit tested in
 * isolation and reused by the frontend for pre-flight feedback. They operate on
 * *strings only* — they cannot decide whether a path escapes the workspace,
 * because that depends on symlinks on disk. The backend performs that check
 * with `fs.realpath` before touching the filesystem.
 */

/** Converts Windows separators to POSIX separators. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Normalises a workspace-relative path.
 *
 * Collapses `.` segments, removes leading/trailing separators, and collapses
 * repeated separators. Does **not** resolve `..` — callers must reject paths
 * containing `..` before or after normalisation.
 */
export function normalizeRelativePath(value: string): string {
  const posix = toPosixPath(value);
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.join('/');
}

/**
 * Returns true when `value` is a syntactically safe workspace-relative path.
 *
 * Rejects absolute paths, `..` traversal, NUL bytes, and Windows drive letters.
 * This is a fast first-pass filter; it is not a substitute for realpath checks.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.includes('\0')) return false;
  if (value === '') return true;

  const posix = toPosixPath(value);
  if (posix.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(posix)) return false;
  if (posix.startsWith('~')) return false;

  const segments = posix.split('/');
  return !segments.includes('..');
}

/**
 * Joins a workspace-relative path onto a POSIX root, producing an absolute
 * POSIX path. Assumes `isSafeRelativePath(relative)` already returned true.
 */
export function joinWorkspacePath(root: string, relative: string): string {
  const normalizedRoot = toPosixPath(root).replace(/\/+$/, '');
  const normalizedRelative = normalizeRelativePath(relative);
  return normalizedRelative === '' ? normalizedRoot : `${normalizedRoot}/${normalizedRelative}`;
}

/**
 * Returns the parent of a workspace-relative path, or `null` when the path is
 * already the root.
 */
export function parentRelativePath(relative: string): string | null {
  const normalized = normalizeRelativePath(relative);
  if (normalized === '') return null;
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

/** Returns the final segment of a workspace-relative path. Root returns `''`. */
export function basenameRelativePath(relative: string): string {
  const normalized = normalizeRelativePath(relative);
  if (normalized === '') return '';
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * Returns true when `child` is `parent` itself or lives underneath it.
 *
 * Both arguments must be absolute POSIX paths that have already been resolved
 * with `fs.realpath`. Comparison is segment-wise, so `/data/workspace-evil`
 * is correctly rejected for parent `/data/workspace`.
 */
export function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = toPosixPath(parent).replace(/\/+$/, '');
  const normalizedChild = toPosixPath(child).replace(/\/+$/, '');
  if (normalizedParent === normalizedChild) return true;
  return normalizedChild.startsWith(`${normalizedParent}/`);
}
