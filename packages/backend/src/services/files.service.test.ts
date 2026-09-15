import { mkdtemp, rm, mkdir as mkdirFs } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError, PathRejectedError, PayloadTooLargeError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../security/workspace.js';

import {
  createDirectory,
  deletePath,
  listDirectory,
  readFile,
  renamePath,
  searchEntries,
  statPath,
  streamToFile,
  writeFile,
} from './files.service.js';

/**
 * Filesystem service tests against the real filesystem.
 *
 * The service's entire value is correct behaviour on disk — path resolution,
 * symlink handling, error mapping — so these run against a real temporary
 * directory tree rather than a mock.
 */

let sandboxRelative: string;

/** Converts an absolute path under the workspace root into the relative form the API uses. */
async function relative(absolute: string): Promise<string> {
  const root = await getWorkspaceRoot();
  return path.relative(root, absolute).split(path.sep).join('/');
}

beforeAll(async () => {
  const root = await getWorkspaceRoot();
  const sandbox = await mkdtemp(path.join(root, 'files-service-test-'));
  sandboxRelative = path.relative(root, sandbox).split(path.sep).join('/');
});

afterAll(async () => {
  const root = await getWorkspaceRoot();
  await rm(path.join(root, sandboxRelative), { recursive: true, force: true });
});

describe('writeFile / readFile', () => {
  it('round-trips UTF-8 content', async () => {
    const target = `${sandboxRelative}/hello.txt`;

    const written = await writeFile({ relative: target, content: 'hello world', encoding: 'utf8', createOnly: false });
    expect(written.type).toBe('file');
    expect(written.size).toBe(Buffer.byteLength('hello world'));

    const read = await readFile(target);
    expect(read.content).toBe('hello world');
    expect(read.encoding).toBe('utf8');
    expect(read.truncated).toBe(false);
  });

  it('round-trips base64 content', async () => {
    const target = `${sandboxRelative}/binary.bin`;
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64');

    await writeFile({ relative: target, content: payload, encoding: 'base64', createOnly: false });

    const read = await readFile(target, 'base64');
    expect(read.content).toBe(payload);
    expect(read.encoding).toBe('base64');
  });

  it('refuses to overwrite when createOnly is set', async () => {
    const target = `${sandboxRelative}/exclusive.txt`;
    await writeFile({ relative: target, content: 'first', encoding: 'utf8', createOnly: false });

    await expect(
      writeFile({ relative: target, content: 'second', encoding: 'utf8', createOnly: true }),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects a traversal path', async () => {
    await expect(
      writeFile({ relative: '../escape.txt', content: 'x', encoding: 'utf8', createOnly: false }),
    ).rejects.toThrow(PathRejectedError);
  });

  it('reports a missing file as not found', async () => {
    await expect(readFile(`${sandboxRelative}/absent.txt`)).rejects.toThrow(NotFoundError);
  });
});

describe('createDirectory', () => {
  it('creates a directory', async () => {
    const entry = await createDirectory(`${sandboxRelative}/created`, false);
    expect(entry.type).toBe('directory');
    expect(entry.size).toBe(0);
  });

  it('reports an existing path as a conflict', async () => {
    await createDirectory(`${sandboxRelative}/duplicate`, false);
    await expect(createDirectory(`${sandboxRelative}/duplicate`, false)).rejects.toThrow(ConflictError);
  });

  it('creates intermediate directories when recursive', async () => {
    const entry = await createDirectory(`${sandboxRelative}/nested/deep/tree`, true);
    expect(entry.type).toBe('directory');
  });
});

describe('listDirectory', () => {
  it('lists directories before files, each alphabetically', async () => {
    const dir = await mkdtemp(path.join(await getWorkspaceRoot(), sandboxRelative, 'listing-'));
    await mkdirFs(path.join(dir, 'zebra-dir'));
    await writeFile({ relative: await relative(path.join(dir, 'beta.txt')), content: 'b', encoding: 'utf8', createOnly: false });
    await writeFile({ relative: await relative(path.join(dir, 'alpha.txt')), content: 'a', encoding: 'utf8', createOnly: false });

    const listing = await listDirectory({ relative: await relative(dir), showHidden: true });
    const names = listing.entries.map((entry) => entry.name);

    expect(names[0]).toBe('zebra-dir');
    expect(names.slice(1)).toEqual(['alpha.txt', 'beta.txt']);
  });

  it('hides dotfiles when asked', async () => {
    const dir = await mkdtemp(path.join(await getWorkspaceRoot(), sandboxRelative, 'hidden-'));
    await writeFile({ relative: await relative(path.join(dir, '.env')), content: 'x', encoding: 'utf8', createOnly: false });
    await writeFile({ relative: await relative(path.join(dir, 'visible.txt')), content: 'x', encoding: 'utf8', createOnly: false });

    const withHidden = await listDirectory({ relative: await relative(dir), showHidden: true });
    const withoutHidden = await listDirectory({ relative: await relative(dir), showHidden: false });

    expect(withHidden.entries.map((entry) => entry.name)).toContain('.env');
    expect(withoutHidden.entries.map((entry) => entry.name)).not.toContain('.env');
  });

  it('reports the parent path, and null at the workspace root', async () => {
    const listing = await listDirectory({ relative: '', showHidden: true });
    expect(listing.parent).toBeNull();

    const nested = await listDirectory({ relative: sandboxRelative, showHidden: true });
    expect(nested.parent).toBe('');
  });

  it('rejects a file passed where a directory is expected', async () => {
    const target = `${sandboxRelative}/not-a-dir.txt`;
    await writeFile({ relative: target, content: 'x', encoding: 'utf8', createOnly: false });
    await expect(listDirectory({ relative: target, showHidden: true })).rejects.toThrow(PathRejectedError);
  });

  it('rejects a traversal path', async () => {
    await expect(listDirectory({ relative: '../../etc', showHidden: true })).rejects.toThrow(PathRejectedError);
  });
});

describe('statPath', () => {
  it('returns metadata for a file', async () => {
    const target = `${sandboxRelative}/stat-me.txt`;
    await writeFile({ relative: target, content: 'twelve bytes', encoding: 'utf8', createOnly: false });

    const entry = await statPath(target);
    expect(entry.name).toBe('stat-me.txt');
    expect(entry.size).toBe(12);
    expect(entry.mode).toMatch(/^[0-7]{3}$/);
  });
});

describe('renamePath', () => {
  it('renames a file', async () => {
    const from = `${sandboxRelative}/before.txt`;
    const to = `${sandboxRelative}/after.txt`;
    await writeFile({ relative: from, content: 'x', encoding: 'utf8', createOnly: false });

    const entry = await renamePath({ from, to, overwrite: false });
    expect(entry.name).toBe('after.txt');

    await expect(readFile(from)).rejects.toThrow(NotFoundError);
    expect((await readFile(to)).content).toBe('x');
  });

  it('refuses to clobber an existing file without overwrite', async () => {
    const from = `${sandboxRelative}/move-source.txt`;
    const to = `${sandboxRelative}/move-target.txt`;
    await writeFile({ relative: from, content: 'a', encoding: 'utf8', createOnly: false });
    await writeFile({ relative: to, content: 'b', encoding: 'utf8', createOnly: false });

    await expect(renamePath({ from, to, overwrite: false })).rejects.toThrow(ConflictError);
  });

  it('overwrites when asked', async () => {
    const from = `${sandboxRelative}/ow-source.txt`;
    const to = `${sandboxRelative}/ow-target.txt`;
    await writeFile({ relative: from, content: 'new', encoding: 'utf8', createOnly: false });
    await writeFile({ relative: to, content: 'old', encoding: 'utf8', createOnly: false });

    await renamePath({ from, to, overwrite: true });
    expect((await readFile(to)).content).toBe('new');
  });

  it('refuses to move a directory inside itself', async () => {
    await createDirectory(`${sandboxRelative}/self`, true);
    await expect(
      renamePath({ from: `${sandboxRelative}/self`, to: `${sandboxRelative}/self/inner`, overwrite: false }),
    ).rejects.toThrow(PathRejectedError);
  });
});

describe('deletePath', () => {
  it('deletes a file', async () => {
    const target = `${sandboxRelative}/delete-me.txt`;
    await writeFile({ relative: target, content: 'x', encoding: 'utf8', createOnly: false });

    await deletePath(target, false);
    await expect(statPath(target)).rejects.toThrow(NotFoundError);
  });

  it('refuses to delete a non-empty directory without recursive', async () => {
    const dir = `${sandboxRelative}/not-empty`;
    await createDirectory(dir, true);
    await writeFile({ relative: `${dir}/child.txt`, content: 'x', encoding: 'utf8', createOnly: false });

    await expect(deletePath(dir, false)).rejects.toThrow(ConflictError);
  });

  it('deletes a non-empty directory when recursive', async () => {
    const dir = `${sandboxRelative}/tree-to-remove`;
    await createDirectory(`${dir}/deep`, true);
    await writeFile({ relative: `${dir}/deep/child.txt`, content: 'x', encoding: 'utf8', createOnly: false });

    await deletePath(dir, true);
    await expect(statPath(dir)).rejects.toThrow(NotFoundError);
  });

  it('refuses to delete the workspace root', async () => {
    await expect(deletePath('', true)).rejects.toThrow(PathRejectedError);
  });
});

describe('searchEntries', () => {
  it('finds entries by case-insensitive name substring', async () => {
    const dir = `${sandboxRelative}/search-me`;
    await createDirectory(dir, true);
    await writeFile({ relative: `${dir}/Report-Q3.txt`, content: 'x', encoding: 'utf8', createOnly: false });
    await writeFile({ relative: `${dir}/notes.md`, content: 'x', encoding: 'utf8', createOnly: false });

    const results = await searchEntries({ relative: dir, query: 'report', limit: 50 });
    expect(results.map((entry) => entry.name)).toEqual(['Report-Q3.txt']);
  });

  it('descends into subdirectories', async () => {
    const dir = `${sandboxRelative}/search-deep`;
    await createDirectory(`${dir}/a/b`, true);
    await writeFile({ relative: `${dir}/a/b/deep-target.txt`, content: 'x', encoding: 'utf8', createOnly: false });

    const results = await searchEntries({ relative: dir, query: 'deep-target', limit: 50 });
    expect(results).toHaveLength(1);
  });

  it('honours the result limit', async () => {
    const dir = `${sandboxRelative}/search-limit`;
    await createDirectory(dir, true);
    for (let index = 0; index < 10; index += 1) {
      await writeFile({ relative: `${dir}/match-${index}.txt`, content: 'x', encoding: 'utf8', createOnly: false });
    }

    const results = await searchEntries({ relative: dir, query: 'match', limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe('streamToFile', () => {
  it('writes a stream to disk', async () => {
    const entry = await streamToFile(
      sandboxRelative,
      'streamed.txt',
      Readable.from(['chunk-one', 'chunk-two']),
      1024,
    );

    expect(entry.size).toBe(Buffer.byteLength('chunk-onechunk-two'));
    expect((await readFile(`${sandboxRelative}/streamed.txt`)).content).toBe('chunk-onechunk-two');
  });

  it('aborts and removes the partial file when the limit is exceeded', async () => {
    await expect(
      streamToFile(sandboxRelative, 'too-big.txt', Readable.from(['x'.repeat(5000)]), 100),
    ).rejects.toThrow(PayloadTooLargeError);

    // A rejected upload must not leave a truncated file behind.
    await expect(statPath(`${sandboxRelative}/too-big.txt`)).rejects.toThrow(NotFoundError);
  });

  it('rejects a file name containing a path separator', async () => {
    await expect(streamToFile(sandboxRelative, '../escape.txt', Readable.from(['x']), 1024)).rejects.toThrow();
  });
});
