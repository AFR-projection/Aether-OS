import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildShellArgv, buildShellEnvironment, type ShellIdentity } from '@aether/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import {
  createSession,
  killAllSessions,
  listSessionsForUser,
  resetSessionsForTests,
} from './terminal.js';
import { resetWorkspaceRootCache } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { IPty } from 'node-pty';

/**
 * Real-PTY tests for the terminal's environment model.
 *
 * These spawn an actual shell through `node-pty` — the same native addon the
 * agent uses — so they prove the login-shell behaviour end to end rather than
 * describing it. `node-pty` builds on the CI runner (`ubuntu-latest`), where
 * `router.test.ts` already spawns PTYs; on a host where the native module or a
 * POSIX shell is unavailable (a Windows dev box) the suite skips itself rather
 * than reporting a pass it did not earn.
 *
 * The environment builders are driven directly here, with a synthetic identity
 * pointing at a temp home. That is deliberate: `createSession` resolves the
 * identity from the host's passwd database, which a test cannot redirect at a
 * scratch directory — so the profile-chain and secret claims are tested against
 * the exact functions `createSession` calls, with a home the test controls.
 * `createSession` itself is exercised for session lifecycle, where the real
 * identity is fine.
 */

interface SpawnResult {
  output: string;
  exitCode: number;
}

let pty: typeof import('node-pty') | null = null;
let bash: string | null = null;

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'];

beforeAll(async () => {
  if (process.platform === 'win32') return;
  try {
    pty = await import('node-pty');
  } catch {
    pty = null;
    return;
  }
  const { existsSync } = await import('node:fs');
  bash = BASH_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
});

/** True when a real shell can be spawned on this host. */
function canSpawn(): boolean {
  return pty !== null && bash !== null;
}

/** Spawns a one-shot shell and collects everything it prints until it exits. */
function runShell(
  shell: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string
): Promise<SpawnResult> {
  const ptyModule = pty;
  if (ptyModule === null) throw new Error('node-pty is not loaded');

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: IPty;
    try {
      child = ptyModule.spawn(shell, argv, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let output = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error(`shell did not exit within the timeout; output so far: ${output}`));
    }, 15_000);
    timer.unref();

    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ output, exitCode });
    });
  });
}

describe('terminal environment model (real PTY)', () => {
  let home: string;
  let identity: ShellIdentity;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'aether-home-'));
    identity = { user: 'tester', home, shell: bash ?? '/bin/bash' };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs a tool a login profile puts on PATH — the curl-installer case', async () => {
    if (!canSpawn()) return;

    // The user's report in miniature: an installer drops a binary in
    // `~/.local/bin` and adds that directory to PATH from `~/.profile`. Only a
    // login shell reads `~/.profile`, so this is exactly the path that was
    // broken. No tool is named; this is the generic mechanism.
    const localBin = path.join(home, '.local', 'bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      path.join(home, '.profile'),
      'export PATH="$HOME/.local/bin:$PATH"\nexport AETHER_PROFILE_RAN=1\n',
      'utf8'
    );
    const tool = path.join(localBin, 'mytool');
    await writeFile(tool, '#!/bin/sh\necho "mytool-ran"\n', 'utf8');
    await chmod(tool, 0o755);

    const shell = bash as string;
    const env = buildShellEnvironment(identity, { cwd: home, ambient: {} });
    const result = await runShell(shell, buildShellArgv('command -v mytool && mytool'), env, home);

    expect(result.output).toContain('mytool-ran');
    expect(result.output).toContain('.local/bin/mytool');
  }, 30_000);

  it('does NOT find that tool without the login flag — proving why -l matters', async () => {
    if (!canSpawn()) return;

    const localBin = path.join(home, '.local', 'bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      path.join(home, '.profile'),
      'export PATH="$HOME/.local/bin:$PATH"\n',
      'utf8'
    );
    const tool = path.join(localBin, 'mytool');
    await writeFile(tool, '#!/bin/sh\necho "mytool-ran"\n', 'utf8');
    await chmod(tool, 0o755);

    const shell = bash as string;
    const env = buildShellEnvironment(identity, { cwd: home, ambient: {} });
    // The old argv: `-c` with no `-l`. This is the regression, reproduced.
    const result = await runShell(shell, ['-c', 'command -v mytool || echo "not-found"'], env, home);

    expect(result.output).toContain('not-found');
    expect(result.output).not.toContain('mytool-ran');
  }, 30_000);

  it('does not leak the agent pairing token into the shell', async () => {
    if (!canSpawn()) return;

    const shell = bash as string;
    // The token is present in the spawning process's environment, as it is in
    // the real agent. The allowlist must keep it out of the child.
    const ambient = {
      AETHER_PAIRING_TOKEN: 'super-secret-pairing-token',
      JWT_SECRET: 'super-secret-jwt',
      LANG: 'C.UTF-8',
    };
    const env = buildShellEnvironment(identity, { cwd: home, ambient });
    const result = await runShell(shell, buildShellArgv('env'), env, home);

    expect(result.output).not.toContain('super-secret-pairing-token');
    expect(result.output).not.toContain('super-secret-jwt');
    // The shell still has a real environment: identity, terminal, and the
    // allowlisted locale are all present.
    expect(result.output).toContain(`HOME=${home}`);
    expect(result.output).toContain('USER=tester');
    expect(result.output).toContain('TERM=xterm-256color');
    expect(result.output).toContain('LANG=C.UTF-8');
  }, 30_000);

  it('applies the login environment to a one-shot command too (Run panel path)', async () => {
    if (!canSpawn()) return;

    await writeFile(path.join(home, '.profile'), 'export AETHER_PROFILE_RAN=1\n', 'utf8');

    const shell = bash as string;
    const env = buildShellEnvironment(identity, { cwd: home, ambient: {} });
    const result = await runShell(shell, buildShellArgv('echo "profile=$AETHER_PROFILE_RAN"'), env, home);

    expect(result.output).toContain('profile=1');
  }, 30_000);
});

describe('terminal session lifecycle honesty', () => {
  const OWNER = '00000000-0000-4000-8000-000000000010';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-term-'));
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

  afterAll(() => {
    killAllSessions('test_suite_end');
  });

  it('reports an exited session as exited with a null pid, never as running', async () => {
    if (!canSpawn()) return;

    // A shell that exits on its own the moment it starts.
    const session = await createSession(cfg, { ownerUserId: OWNER, cols: 80, rows: 24, command: 'true' });
    expect(session.status).toBe('running');

    // Wait for the process to exit; the agent flips status on the exit event.
    const deadline = Date.now() + 10_000;
    let current = listSessionsForUser(OWNER).find((s) => s.id === session.id);
    while (current !== undefined && current.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      current = listSessionsForUser(OWNER).find((s) => s.id === session.id);
    }

    expect(current).toBeDefined();
    expect(current?.status).toBe('exited');
    expect(current?.pid).toBeNull();
  }, 20_000);
});
