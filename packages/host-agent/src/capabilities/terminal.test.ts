import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildShellArgv, buildShellEnvironment, type ShellIdentity } from '@aether/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { dispatchRequest } from '../router.js';
import {
  createSession,
  killAllSessions,
  killOwnedSession,
  listSessionsForUser,
  resetSessionsForTests,
  seedSessionForTests,
} from './terminal.js';
import { resetWorkspaceRootCache } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { ParsedRequest, RequestType } from '../protocol.js';
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

/**
 * Ownership of a session, from the agent's side.
 *
 * The backend sends the principal a request is made on behalf of, and the agent
 * is the last line of defence: it holds the PTYs, and it is the only party that
 * can refuse to act on one. An instance-scoped local agent pairs as *itself* —
 * one identity shared by every user of the instance — so a request that named no
 * principal would be answered as that shared identity, and every user's sessions
 * would answer to every user. These tests pin the check that stops that.
 */
describe('terminal session ownership', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000b2';
  const OTHER_USER = '00000000-0000-4000-8000-0000000000b3';
  const MISSING = '00000000-0000-4000-8000-00000000dead';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-owner-'));
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

  function request(type: RequestType, params: unknown): ParsedRequest {
    return { id: `own-${type}`, type, params };
  }

  it('refuses to kill another user\'s session, and leaves it running', async () => {
    const session = seedSessionForTests(OWNER);

    const reply = await dispatchRequest(
      cfg,
      OTHER_USER,
      request('terminal.kill', { id: session.id })
    );

    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ killed: false });
    // The point of the refusal: the session is still there afterwards. A kill
    // that reported `false` while ending the session would be the same bug
    // wearing a different answer.
    expect(listSessionsForUser(OWNER).map((s) => s.id)).toContain(session.id);
  });

  it('kills the owner\'s own session', async () => {
    // The mirror of the test above: the ownership check must not be a refusal to
    // kill anything at all.
    const session = seedSessionForTests(OWNER);

    const reply = await dispatchRequest(cfg, OWNER, request('terminal.kill', { id: session.id }));

    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ killed: true });
    expect(listSessionsForUser(OWNER)).toEqual([]);
  });

  it('treats a session owned by someone else and one that never existed alike', () => {
    const session = seedSessionForTests(OWNER);

    // Both answer `false`, so a caller holding an id cannot use the answer to
    // learn that someone else's session exists — the same 404-not-403 rule the
    // capability functions apply.
    expect(killOwnedSession(session.id, OTHER_USER, 'test')).toBe(false);
    expect(killOwnedSession(MISSING, OWNER, 'test')).toBe(false);
    expect(listSessionsForUser(OWNER).map((s) => s.id)).toContain(session.id);
  });

  it('does not list, drive, or resize another user\'s session', async () => {
    const session = seedSessionForTests(OWNER);

    const listed = await dispatchRequest(cfg, OTHER_USER, request('terminal.list', {}));
    expect(listed.ok).toBe(true);
    if (listed.ok) expect((listed.result as { sessions: unknown[] }).sessions).toEqual([]);

    const wrote = await dispatchRequest(
      cfg,
      OTHER_USER,
      request('terminal.input', { id: session.id, data: 'echo pwned\n' })
    );
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) expect(wrote.error.code).toBe('NOT_FOUND');

    const resized = await dispatchRequest(
      cfg,
      OTHER_USER,
      request('terminal.resize', { id: session.id, cols: 200, rows: 50 })
    );
    expect(resized.ok).toBe(false);
    if (!resized.ok) expect(resized.error.code).toBe('NOT_FOUND');

    // Nothing the other user did reached the session.
    const mine = listSessionsForUser(OWNER).find((s) => s.id === session.id);
    expect(mine?.cols).toBe(80);
    expect(mine?.rows).toBe(24);
  });

  it('keys a spawned session on the principal that asked for it', async () => {
    if (!canSpawn()) return;

    const session = await createSession(cfg, { ownerUserId: OWNER, cols: 80, rows: 24 });

    expect(listSessionsForUser(OWNER).map((s) => s.id)).toContain(session.id);
    expect(listSessionsForUser(OTHER_USER)).toEqual([]);
  }, 20_000);

  it('leaves a real shell running when another user asks for it to be killed', async () => {
    if (!canSpawn()) return;

    // The same refusal as above, but with a process behind the session: the check
    // is asserted on the shell's own liveness, not only on the session table.
    const session = await createSession(cfg, { ownerUserId: OWNER, cols: 80, rows: 24 });
    const pid = session.pid;
    expect(pid).not.toBeNull();

    const reply = await dispatchRequest(
      cfg,
      OTHER_USER,
      request('terminal.kill', { id: session.id })
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ killed: false });

    expect(listSessionsForUser(OWNER).map((s) => s.id)).toContain(session.id);
    // Signal 0 asks the kernel whether the process is there without touching it.
    expect(() => process.kill(pid as number, 0)).not.toThrow();
  }, 20_000);
});

/**
 * The one-model enforcement, made a fact about the code.
 *
 * docs/architecture/EXECUTION-MODEL.md states the rule: every shell Aether
 * spawns builds its argv and its environment through the shared
 * `buildShellArgv`/`buildShellEnvironment`, and nowhere builds a child
 * environment by hand. This test is what the doc points at — it scans the
 * production source for every `pty.spawn(` call and asserts each one is
 * constructed through those builders. A future spawn path that improvises its
 * own environment fails here rather than quietly diverging.
 *
 * It is a static scan, not a spawn, so it runs everywhere — including the
 * Windows dev box where node-pty may not load — and needs no shell.
 */
describe('the one-model rule: every pty.spawn goes through the shared builders', () => {
  // capabilities → src → host-agent → packages → repo root.
  const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
  const PACKAGES = path.join(REPO_ROOT, 'packages');

  // Directories that are outputs or dependencies, never authored source.
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

  async function collectSourceFiles(dir: string, out: string[]): Promise<void> {
    // A package without the directory is not an error; treat it as empty.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // `entry.name` widens to Buffer under one readdir overload; normalise it.
      const name = String(entry.name);
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(name)) await collectSourceFiles(full, out);
        continue;
      }
      // Production TypeScript only: tests (this file included) legitimately
      // reference `.spawn` for other reasons and are not spawn sites to police.
      if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  }

  /**
   * Extracts the argument text of a call whose opening `(` is at `open`, by
   * matching parentheses to their close. String and template literals are
   * skipped so a `)` inside a string does not end the call early. Good enough
   * for the call shapes this repo writes; it is not a full parser.
   */
  function callArguments(source: string, open: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      const prev = source[i - 1];
      if (quote) {
        if (ch === quote && prev !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
    throw new Error('unbalanced parentheses while extracting a pty.spawn call');
  }

  it('finds every pty.spawn call site and each builds argv and env through the shared functions', async () => {
    const files: string[] = [];
    await collectSourceFiles(PACKAGES, files);
    expect(files.length).toBeGreaterThan(0); // the scan reached real source

    // A spawn call on the pty module. Both current sites write `pty.spawn(`;
    // the pattern also catches an aliased-but-still-pty `.spawn(` on a variable
    // whose name ends in `pty`, which is the idiom this repo uses.
    const spawnCall = /\bpty\.spawn\s*\(/gi;
    const sites: { file: string; args: string }[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      spawnCall.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = spawnCall.exec(source)) !== null) {
        const open = source.indexOf('(', match.index);
        sites.push({ file: path.relative(REPO_ROOT, file), args: callArguments(source, open) });
      }
    }

    // The scan must actually see the known spawn sites — a zero-match scan
    // (a moved file, a renamed call) must fail rather than pass vacuously.
    // Today there are exactly two: the host agent and the backend workspace terminal.
    expect(sites.length).toBeGreaterThanOrEqual(2);

    for (const site of sites) {
      expect(
        site.args.includes('buildShellArgv('),
        `${site.file}: a pty.spawn must take its argv from buildShellArgv() (see docs/architecture/EXECUTION-MODEL.md)`
      ).toBe(true);
      expect(
        site.args.includes('buildShellEnvironment('),
        `${site.file}: a pty.spawn must take its env from buildShellEnvironment() (see docs/architecture/EXECUTION-MODEL.md)`
      ).toBe(true);
    }
  });
});
