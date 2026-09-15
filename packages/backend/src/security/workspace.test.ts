import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PathRejectedError } from '../utils/errors.js';

import {
  assertSafeRelativePath,
  getWorkspaceRoot,
  joinToRoot,
  resolveExistingPath,
  resolvePathForWrite,
  toRelativePath,
} from './workspace.js';

/**
 * Containment tests for the workspace sandbox.
 *
 * These exercise the real filesystem: the sandbox's whole job is to reason
 * about what is actually on disk, so a mocked `fs` would test nothing.
 */

let root: string;
let sandbox: string;
let outside: string;

/**
 * Creating a directory symlink needs Developer Mode on Windows and is
 * unavailable in some CI sandboxes. The escape tests are skipped rather than
 * silently passing when the platform cannot express the attack.
 */
async function canCreateDirectorySymlink(): Promise<boolean> {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'aether-symlink-probe-'));
  try {
    await mkdir(path.join(probe, 'target'));
    await symlink(path.join(probe, 'target'), path.join(probe, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  root = await getWorkspaceRoot();
  sandbox = await mkdtemp(path.join(root, 'workspace-test-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'aether-outside-'));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('assertSafeRelativePath', () => {
  it('normalises an acceptable path', () => {
    expect(assertSafeRelativePath('./docs//readme.md')).toBe('docs/readme.md');
  });

  it('rejects traversal, absolute, and home-relative input', () => {
    expect(() => assertSafeRelativePath('../etc/passwd')).toThrow(PathRejectedError);
    expect(() => assertSafeRelativePath('/etc/passwd')).toThrow(PathRejectedError);
    expect(() => assertSafeRelativePath('~/secrets')).toThrow(PathRejectedError);
    expect(() => assertSafeRelativePath('a/../../b')).toThrow(PathRejectedError);
  });
});

describe('resolveExistingPath', () => {
  it('reports a missing path without throwing', async () => {
    const result = await resolveExistingPath(path.relative(root, path.join(sandbox, 'absent.txt')));
    expect(result.exists).toBe(false);
  });

  it('resolves a file inside the workspace', async () => {
    const file = path.join(sandbox, 'inside.txt');
    await writeFile(file, 'hello');

    const result = await resolveExistingPath(path.relative(root, file).split(path.sep).join('/'));

    expect(result.exists).toBe(true);
    expect(result.absolute).toBe(await import('node:fs/promises').then((fs) => fs.realpath(file)));
    expect(result.relative).toBe(path.relative(root, file).split(path.sep).join('/'));
  });

  it('rejects a traversal attempt before touching the disk', async () => {
    await expect(resolveExistingPath('../../../../etc/passwd')).rejects.toThrow(PathRejectedError);
  });

  it('rejects a symlink that points outside the workspace', async ({ skip }) => {
    if (!(await canCreateDirectorySymlink())) {
      skip('directory symlinks are not permitted on this platform');
      return;
    }

    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'top secret');

    const link = path.join(sandbox, 'escape-link');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const relativeLink = path.relative(root, path.join(link, 'secret.txt')).split(path.sep).join('/');

    await expect(resolveExistingPath(relativeLink)).rejects.toThrow(PathRejectedError);
  });
});

describe('resolvePathForWrite', () => {
  it('allows a new file in an existing directory', async () => {
    const target = path.join(sandbox, 'new-file.txt');
    const result = await resolvePathForWrite(path.relative(root, target).split(path.sep).join('/'));

    expect(result.exists).toBe(false);
    expect(result.absolute).toBe(target);
  });

  it('refuses to write to the workspace root', async () => {
    await expect(resolvePathForWrite('')).rejects.toThrow(PathRejectedError);
  });

  it('rejects a traversal path', async () => {
    await expect(resolvePathForWrite('../../evil.txt')).rejects.toThrow(PathRejectedError);
  });

  it('rejects a missing parent directory', async () => {
    await expect(resolvePathForWrite('no-such-dir/file.txt')).rejects.toThrow();
  });

  it('refuses to write through a symlinked directory that leaves the workspace', async ({ skip }) => {
    if (!(await canCreateDirectorySymlink())) {
      skip('directory symlinks are not permitted on this platform');
      return;
    }

    const link = path.join(sandbox, 'write-escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const relativeLink = path.relative(root, path.join(link, 'planted.txt')).split(path.sep).join('/');

    await expect(resolvePathForWrite(relativeLink)).rejects.toThrow(PathRejectedError);
  });

  it('refuses to overwrite a symbolic link in place', async ({ skip }) => {
    const probe = await mkdtemp(path.join(os.tmpdir(), 'aether-symlink-file-'));
    try {
      const target = path.join(probe, 'target.txt');
      const link = path.join(sandbox, 'file-link.txt');
      await writeFile(target, 'original');

      try {
        await symlink(target, link, 'file');
      } catch {
        skip('file symlinks are not permitted on this platform');
        return;
      }

      const relativeLink = path.relative(root, link).split(path.sep).join('/');
      await expect(resolvePathForWrite(relativeLink)).rejects.toThrow(PathRejectedError);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  });

  describe('createParents', () => {
    it('refuses to invent missing parents unless explicitly asked', async () => {
      await expect(resolvePathForWrite('missing-a/missing-b/file.txt')).rejects.toThrow();
    });

    it('resolves a target below missing directories when asked', async () => {
      const expected = path.join(sandbox, 'fresh', 'nested', 'leaf.txt');
      const result = await resolvePathForWrite(
        path.relative(root, expected).split(path.sep).join('/'),
        { createParents: true },
      );

      expect(result.exists).toBe(false);
      expect(result.absolute).toBe(expected);
    });

    it('still rejects a symlinked ancestor that leaves the workspace', async ({ skip }) => {
      if (!(await canCreateDirectorySymlink())) {
        skip('directory symlinks are not permitted on this platform');
        return;
      }

      const link = path.join(sandbox, 'mkdir-escape');
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

      const target = path.relative(root, path.join(link, 'new', 'deep', 'file.txt'))
        .split(path.sep)
        .join('/');

      // Missing intermediate directories must not become a way around the
      // containment check on the deepest existing ancestor.
      await expect(resolvePathForWrite(target, { createParents: true })).rejects.toThrow(PathRejectedError);
    });
  });
});

describe('joinToRoot', () => {
  it('appends a validated relative path', () => {
    expect(joinToRoot('/srv/ws', 'a/b')).toBe(path.join('/srv/ws', 'a', 'b'));
  });

  it('returns the root for the empty path', () => {
    expect(joinToRoot('/srv/ws', '')).toBe('/srv/ws');
  });
});

describe('toRelativePath', () => {
  it('converts an absolute path inside the workspace', async () => {
    const relative = await toRelativePath(path.join(sandbox, 'a', 'b.txt'));
    expect(relative).toBe(path.relative(root, path.join(sandbox, 'a', 'b.txt')).split(path.sep).join('/'));
  });

  it('rejects a path outside the workspace', async () => {
    await expect(toRelativePath(path.join(outside, 'x.txt'))).rejects.toThrow(PathRejectedError);
  });
});
