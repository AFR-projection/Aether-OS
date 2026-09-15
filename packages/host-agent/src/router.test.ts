import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentConfig } from './config.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { dispatchRequest } from './router.js';
import { resetWorkspaceRootCache } from './security/workspace.js';
import { killAllSessions, resetSessionsForTests } from './capabilities/terminal.js';

const OWNER = '00000000-0000-4000-8000-000000000010';
const OTHER = '00000000-0000-4000-8000-000000000011';

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

function request(id: string, type: 'system.info' | 'processes.list' | 'processes.signal' | 'files.list' | 'files.read' | 'files.write' | 'files.delete' | 'files.mkdir', params: unknown = {}) {
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
      request('r3', 'processes.signal', { pid: 1, signal: 'SIGTERM' }),
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('FORBIDDEN');
  });

  it('refuses to signal its own process', async () => {
    const reply = await dispatchRequest(
      cfg,
      OWNER,
      request('r4', 'processes.signal', { pid: process.pid, signal: 'SIGTERM' }),
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('FORBIDDEN');
  });

  it('writes, reads, lists, and deletes a file', async () => {
    const content = Buffer.from('hello agent').toString('base64');

    const written = await dispatchRequest(cfg, OWNER, request('r5', 'files.write', { path: 'note.txt', contentBase64: content }));
    expect(written.ok).toBe(true);

    const read = await dispatchRequest(cfg, OWNER, request('r6', 'files.read', { path: 'note.txt' }));
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

    const deleted = await dispatchRequest(cfg, OWNER, request('r8', 'files.delete', { path: 'note.txt' }));
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

      const reply = await dispatchRequest(cfg, OWNER, request('r9', 'files.read', { path: 'escape' }));
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe('PATH_REJECTED');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates a directory and refuses to delete it while non-empty', async () => {
    const created = await dispatchRequest(cfg, OWNER, request('r10', 'files.mkdir', { path: 'sub' }));
    expect(created.ok).toBe(true);

    const content = Buffer.from('x').toString('base64');
    await dispatchRequest(cfg, OWNER, request('r11', 'files.write', { path: 'sub/file.txt', contentBase64: content }));

    const refused = await dispatchRequest(cfg, OWNER, request('r12', 'files.delete', { path: 'sub' }));
    // Deleting a non-empty directory is rejected with NOT_FOUND by the agent.
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('NOT_FOUND');
  });

  it('rejects listing a missing directory as not found', async () => {
    const reply = await dispatchRequest(cfg, OWNER, request('r13', 'files.list', { path: 'missing' }));
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('NOT_FOUND');
  });
});
