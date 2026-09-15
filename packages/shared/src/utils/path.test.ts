import { describe, expect, it } from 'vitest';

import {
  basenameRelativePath,
  isPathInside,
  isSafeRelativePath,
  joinWorkspacePath,
  normalizeRelativePath,
  parentRelativePath,
  toPosixPath,
} from './path.js';

describe('toPosixPath', () => {
  it('converts Windows separators', () => {
    expect(toPosixPath('a\\b\\c')).toBe('a/b/c');
  });

  it('leaves POSIX paths untouched', () => {
    expect(toPosixPath('a/b/c')).toBe('a/b/c');
  });
});

describe('normalizeRelativePath', () => {
  it('removes leading and trailing separators', () => {
    expect(normalizeRelativePath('/foo/bar/')).toBe('foo/bar');
  });

  it('collapses repeated separators', () => {
    expect(normalizeRelativePath('foo//bar///baz')).toBe('foo/bar/baz');
  });

  it('removes single-dot segments', () => {
    expect(normalizeRelativePath('./foo/./bar')).toBe('foo/bar');
  });

  it('preserves parent segments rather than resolving them', () => {
    // Resolution is the caller's job; silently collapsing `..` here would hide
    // a traversal attempt from the safety check that runs next.
    expect(normalizeRelativePath('foo/../bar')).toBe('foo/../bar');
  });

  it('maps the root to an empty string', () => {
    expect(normalizeRelativePath('')).toBe('');
    expect(normalizeRelativePath('/')).toBe('');
    expect(normalizeRelativePath('.')).toBe('');
  });

  it('converts backslashes before normalising', () => {
    expect(normalizeRelativePath('foo\\bar')).toBe('foo/bar');
  });
});

describe('isSafeRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(isSafeRelativePath('foo/bar.txt')).toBe(true);
    expect(isSafeRelativePath('')).toBe(true);
    expect(isSafeRelativePath('a')).toBe(true);
  });

  it('rejects absolute POSIX paths', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
  });

  it('rejects Windows drive-letter paths', () => {
    expect(isSafeRelativePath('C:\\Windows\\System32')).toBe(false);
    expect(isSafeRelativePath('c:/windows')).toBe(false);
  });

  it('rejects home-relative paths', () => {
    expect(isSafeRelativePath('~/.ssh/id_rsa')).toBe(false);
  });

  it('rejects any parent-directory segment', () => {
    expect(isSafeRelativePath('..')).toBe(false);
    expect(isSafeRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('foo/../../etc')).toBe(false);
    expect(isSafeRelativePath('foo/..')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeRelativePath('foo\0bar')).toBe(false);
  });

  it('rejects backslash traversal that would look harmless on POSIX', () => {
    expect(isSafeRelativePath('..\\..\\windows')).toBe(false);
  });

  it('allows a file whose name merely contains dots', () => {
    expect(isSafeRelativePath('archive.tar.gz')).toBe(true);
    expect(isSafeRelativePath('..hidden')).toBe(true);
  });
});

describe('joinWorkspacePath', () => {
  it('joins a relative path onto the root', () => {
    expect(joinWorkspacePath('/srv/aether/workspace', 'foo/bar')).toBe('/srv/aether/workspace/foo/bar');
  });

  it('returns the root for an empty relative path', () => {
    expect(joinWorkspacePath('/srv/aether/workspace', '')).toBe('/srv/aether/workspace');
  });

  it('tolerates a root with a trailing separator', () => {
    expect(joinWorkspacePath('/srv/aether/workspace/', 'foo')).toBe('/srv/aether/workspace/foo');
  });
});

describe('parentRelativePath', () => {
  it('returns the parent of a nested path', () => {
    expect(parentRelativePath('foo/bar/baz.txt')).toBe('foo/bar');
  });

  it('returns the root for a top-level entry', () => {
    expect(parentRelativePath('foo')).toBe('');
  });

  it('returns null for the root itself', () => {
    expect(parentRelativePath('')).toBeNull();
  });
});

describe('basenameRelativePath', () => {
  it('returns the final segment', () => {
    expect(basenameRelativePath('foo/bar/baz.txt')).toBe('baz.txt');
    expect(basenameRelativePath('baz.txt')).toBe('baz.txt');
  });

  it('returns an empty string for the root', () => {
    expect(basenameRelativePath('')).toBe('');
  });
});

describe('isPathInside', () => {
  it('accepts the root itself', () => {
    expect(isPathInside('/srv/aether', '/srv/aether')).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isPathInside('/srv/aether', '/srv/aether/workspace/file.txt')).toBe(true);
  });

  it('rejects a sibling with a shared prefix', () => {
    // The whole point of segment-wise comparison: `/srv/aether-evil` must not
    // be treated as living inside `/srv/aether`.
    expect(isPathInside('/srv/aether', '/srv/aether-evil/passwd')).toBe(false);
  });

  it('rejects a parent directory', () => {
    expect(isPathInside('/srv/aether/workspace', '/srv/aether')).toBe(false);
  });

  it('rejects an unrelated path', () => {
    expect(isPathInside('/srv/aether', '/etc/passwd')).toBe(false);
  });

  it('ignores trailing separators', () => {
    expect(isPathInside('/srv/aether/', '/srv/aether/workspace/')).toBe(true);
  });
});
