import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { killAllSessions, resetSessionsForTests } from './capabilities/terminal.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { dispatchRequest } from './router.js';
import { resetWorkspaceRootCache } from './security/workspace.js';

import type { AgentConfig } from './config.js';

const OWNER = '00000000-0000-4000-8000-000000000010';

let cfg: AgentConfig;
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-router-'));
  process.env.AETHER_WORKSPACE_ROOT = workspace;
  resetWorkspaceRootCache();
  resetSessionsForTests();
  cfg = loadConfig();
  createLogger(cfg);
});

afterEach(async () => {
  killAllSessions('test_teardown');
  resetSessionsForTests();
  resetWorkspaceRootCache();
  await rm(workspace, { recursive: true, force: true });
  delete process.env.AETHER_WORKSPACE_ROOT;
});

function request(
  id: string,
  type:
    | 'system.info'
    | 'processes.list'
    | 'processes.signal'
    | 'files.list'
    | 'files.read'
    | 'files.readChunk'
    | 'files.write'
    | 'files.writeChunk'
    | 'files.rename'
    | 'files.delete'
    | 'files.mkdir',
  params: unknown = {}
) {
  return { id, type, params };
}

describe('router', () => {
  it('serves system.info', async () => {
    const reply = await dispatchRequest(cfg, OWNER, request('r1', 'system.info'));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const result = reply.result as { hostname: string; instanceId: string };
      expect(result.hostname.length).toBeGreaterThan(0);
      expect(result.instanceId).toBe(cfg.AETHER_AGENT_ID);
    }
  });

  it('lists processes with guarded signal flags', async () => {
    const reply = await dispatchRequest(cfg, OWNER, request('r2', 'processes.list', { limit: 10 }));
    expect(reply.ok).toBe(true);
  }, 30_000);

  it('refuses to signal pid 1', async () => {
    const reply = await dispatchRequest(
      cfg,
      OWNER,
      request('r3', 'processes.signal', { pid: 1, signal: 'SIGTERM' })
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('FORBIDDEN');
  });

  it('refuses to signal its own process', async () => {
    const reply = await dispatchRequest(
      cfg,
      OWNER,
      request('r4', 'processes.signal', { pid: process.pid, signal: 'SIGTERM' })
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('FORBIDDEN');
  });

  it('writes, reads, lists, and deletes a file', async () => {
    const content = Buffer.from('hello agent').toString('base64');

    const written = await dispatchRequest(
      cfg,
      OWNER,
      request('r5', 'files.write', { path: 'note.txt', contentBase64: content })
    );
    expect(written.ok).toBe(true);

    const read = await dispatchRequest(
      cfg,
      OWNER,
      request('r6', 'files.read', { path: 'note.txt' })
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect((read.result as { contentBase64: string }).contentBase64).toBe(content);
    }

    const listed = await dispatchRequest(cfg, OWNER, request('r7', 'files.list', { path: '' }));
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const entries = (listed.result as { entries: { name: string }[] }).entries;
      expect(entries.map((e) => e.name)).toContain('note.txt');
    }

    const deleted = await dispatchRequest(
      cfg,
      OWNER,
      request('r8', 'files.delete', { path: 'note.txt' })
    );
    expect(deleted.ok).toBe(true);
  });

  it('rejects reads through a symlink escape when symlink creation is permitted', async () => {
    if (process.platform === 'win32') {
      return; // Creating symlinks requires privileges on Windows CI; skip rather than fail.
    }
    const outside = await mkdtemp(path.join(tmpdir(), 'aether-agent-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      await symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'escape'));

      const reply = await dispatchRequest(
        cfg,
        OWNER,
        request('r9', 'files.read', { path: 'escape' })
      );
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe('PATH_REJECTED');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates a directory and refuses to delete it while non-empty', async () => {
    const created = await dispatchRequest(
      cfg,
      OWNER,
      request('r10', 'files.mkdir', { path: 'sub' })
    );
    expect(created.ok).toBe(true);

    const content = Buffer.from('x').toString('base64');
    await dispatchRequest(
      cfg,
      OWNER,
      request('r11', 'files.write', { path: 'sub/file.txt', contentBase64: content })
    );

    const refused = await dispatchRequest(
      cfg,
      OWNER,
      request('r12', 'files.delete', { path: 'sub' })
    );
    // A refusal because the directory still has contents is a conflict, not a
    // missing path: the resource is right there, and saying NOT_FOUND would
    // send a caller looking for the wrong problem.
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('CONFLICT');
  });

  it('deletes a non-empty directory when recursive is set', async () => {
    await dispatchRequest(cfg, OWNER, request('r20', 'files.mkdir', { path: 'tree' }));
    await dispatchRequest(cfg, OWNER, request('r21', 'files.mkdir', { path: 'tree/deep' }));

    const content = Buffer.from('x').toString('base64');
    await dispatchRequest(
      cfg,
      OWNER,
      request('r22', 'files.write', { path: 'tree/deep/file.txt', contentBase64: content })
    );

    const removed = await dispatchRequest(
      cfg,
      OWNER,
      request('r23', 'files.delete', { path: 'tree', recursive: true })
    );
    expect(removed.ok).toBe(true);

    const listing = await dispatchRequest(cfg, OWNER, request('r24', 'files.list', { path: '' }));
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      const names = (listing.result as { entries: { name: string }[] }).entries.map((e) => e.name);
      expect(names).not.toContain('tree');
    }
  });

  it('reads a byte range without pulling the whole file', async () => {
    const payload = Buffer.from('0123456789');
    await dispatchRequest(
      cfg,
      OWNER,
      request('r30', 'files.write', {
        path: 'range.txt',
        contentBase64: payload.toString('base64'),
      })
    );

    const slice = await dispatchRequest(
      cfg,
      OWNER,
      request('r31', 'files.readChunk', { path: 'range.txt', offset: 2, length: 4 })
    );

    expect(slice.ok).toBe(true);
    if (slice.ok) {
      const result = slice.result as { contentBase64: string; size: number; offset: number };
      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('2345');
      // The whole-file size comes back with the slice, which is what lets a
      // ranged reader answer `Content-Range` without a second request.
      expect(result.size).toBe(10);
      expect(result.offset).toBe(2);
    }
  });

  it('returns an empty slice past the end rather than failing', async () => {
    // Each test gets a fresh workspace, so this one writes its own file rather
    // than leaning on the test above it.
    await dispatchRequest(
      cfg,
      OWNER,
      request('r33', 'files.write', {
        path: 'range.txt',
        contentBase64: Buffer.from('0123456789').toString('base64'),
      })
    );

    const reply = await dispatchRequest(
      cfg,
      OWNER,
      request('r32', 'files.readChunk', { path: 'range.txt', offset: 99, length: 4 })
    );

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const result = reply.result as { contentBase64: string; size: number };
      expect(result.contentBase64).toBe('');
      expect(result.size).toBe(10);
    }
  });

  it('renames a file and refuses to clobber without overwrite', async () => {
    const content = Buffer.from('a').toString('base64');
    await dispatchRequest(
      cfg,
      OWNER,
      request('r40', 'files.write', { path: 'from.txt', contentBase64: content })
    );
    await dispatchRequest(
      cfg,
      OWNER,
      request('r41', 'files.write', { path: 'to.txt', contentBase64: content })
    );

    const refused = await dispatchRequest(
      cfg,
      OWNER,
      request('r42', 'files.rename', { from: 'from.txt', to: 'to.txt' })
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('CONFLICT');

    const moved = await dispatchRequest(
      cfg,
      OWNER,
      request('r43', 'files.rename', { from: 'from.txt', to: 'moved.txt' })
    );
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect((moved.result as { entry: { name: string } }).entry.name).toBe('moved.txt');
    }
  });

  it('rejects listing a missing directory as not found', async () => {
    const reply = await dispatchRequest(
      cfg,
      OWNER,
      request('r13', 'files.list', { path: 'missing' })
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('NOT_FOUND');
  });
});
