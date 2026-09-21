import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { dispatchRequest } from '../router.js';
import {
  appendOutputForTests,
  createUnit,
  endAllUnits,
  endOwnedUnit,
  finishUnitForTests,
  getUnit,
  listUnits,
  readUnitLog,
  resetUnitsForTests,
  setBootIdForTests,
  resizeUnit,
  seedUnitForTests,
  signalUnit,
  subscribeUnit,
  unitCountForTests,
  writeUnitInput,
  type UnitEvent,
} from './units.js';
import { resetWorkspaceRootCache } from '../security/workspace.js';

import type { AgentConfig } from '../config.js';
import type { ParsedRequest, RequestType } from '../protocol.js';

/**
 * Whether a real shell can be spawned on this host.
 *
 * The ownership and lifecycle rules are asserted against process-less seeded
 * units so they run on every platform. Only the handful of tests that need a
 * live process — idempotent create, keying a spawn on its principal — gate on
 * this, and skip on a Windows dev box where `node-pty` cannot spawn a POSIX
 * shell, exactly as `terminal.test.ts` does.
 */
let ptyAvailable = false;
const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'];

beforeAll(async () => {
  if (process.platform === 'win32') return;
  try {
    await import('node-pty');
  } catch {
    return;
  }
  ptyAvailable = BASH_CANDIDATES.some((candidate) => existsSync(candidate));
});

function canSpawn(): boolean {
  return ptyAvailable;
}

/**
 * Ownership of a unit, from the agent's side.
 *
 * The backend sends the principal a request is made on behalf of, and the agent
 * is the last line of defence: it holds the processes, and it is the only party
 * that can refuse to act on one. An instance-scoped local agent pairs as
 * *itself* — one identity shared by every user of the instance — so a request
 * that named no principal would be answered as that shared identity, and every
 * user's units would answer to every user. These tests pin the check that stops
 * that. They seed process-less units so the rules run on every platform, not
 * only where node-pty builds.
 */
describe('unit ownership', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000b2';
  const OTHER_USER = '00000000-0000-4000-8000-0000000000b3';
  const MISSING = '00000000-0000-4000-8000-00000000dead';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-owner-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  function request(type: RequestType, params: unknown): ParsedRequest {
    return { id: `own-${type}`, type, params };
  }

  it("refuses to kill another user's unit, and leaves it running", async () => {
    const unit = seedUnitForTests(OWNER);

    const reply = await dispatchRequest(cfg, OTHER_USER, request('units.kill', { id: unit.id }));

    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ killed: false });
    // The point of the refusal: the unit is still there afterwards. A kill that
    // reported `false` while ending the unit would be the same bug wearing a
    // different answer.
    expect(listUnits({ ownerUserId: OWNER }).map((u) => u.id)).toContain(unit.id);
  });

  it("kills the owner's own unit", async () => {
    // The mirror of the test above: the ownership check must not be a refusal to
    // kill anything at all.
    const unit = seedUnitForTests(OWNER);

    const reply = await dispatchRequest(cfg, OWNER, request('units.kill', { id: unit.id }));

    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ killed: true });
    // Seeded units have no process, so the kill ends them synchronously.
    expect(listUnits({ ownerUserId: OWNER }).map((u) => u.state)).toEqual(['killed']);
  });

  it('treats a unit owned by someone else and one that never existed alike', async () => {
    const unit = seedUnitForTests(OWNER);

    // Both answer `false`, so a caller holding an id cannot use the answer to
    // learn that someone else's unit exists — the same 404-not-403 rule.
    await expect(endOwnedUnit(unit.id, OTHER_USER, 'test')).resolves.toBe(false);
    await expect(endOwnedUnit(MISSING, OWNER, 'test')).resolves.toBe(false);
    expect(listUnits({ ownerUserId: OWNER }).map((u) => u.id)).toContain(unit.id);
  });

  it("raises the same 404 for another user's unit as for a missing one, on get", () => {
    const unit = seedUnitForTests(OWNER);

    expect(() => getUnit(unit.id, OTHER_USER)).toThrowError(/does not exist/i);
    expect(() => getUnit(MISSING, OWNER)).toThrowError(/does not exist/i);
    // The owner still reads it.
    expect(getUnit(unit.id, OWNER).id).toBe(unit.id);
  });

  it("does not list another user's unit", async () => {
    const unit = seedUnitForTests(OWNER);

    const listed = await dispatchRequest(cfg, OTHER_USER, request('units.list', { scope: 'mine' }));
    expect(listed.ok).toBe(true);
    if (listed.ok) expect((listed.result as { units: unknown[] }).units).toEqual([]);

    // The owner sees exactly their unit.
    const mine = await dispatchRequest(cfg, OWNER, request('units.list', { scope: 'mine' }));
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      const units = (mine.result as { units: { id: string }[] }).units;
      expect(units.map((u) => u.id)).toEqual([unit.id]);
    }
  });

  it("does not drive or resize another user's unit", () => {
    const unit = seedUnitForTests(OWNER);

    // A process-less unit would answer CONFLICT (nothing to write to) to its
    // owner, but a non-owner must be refused *before* that — with the same
    // NOT_FOUND a missing unit gets, so ownership is never leaked through the
    // error code.
    expect(() => writeUnitInput(unit.id, OTHER_USER, 'echo pwned\n')).toThrowError(
      /does not exist/i
    );
    expect(() => resizeUnit(unit.id, OTHER_USER, 200, 50)).toThrowError(/does not exist/i);
  });

  it("scope: 'all' drops the owner filter — the backend-only privileged path", async () => {
    seedUnitForTests(OWNER);
    seedUnitForTests(OTHER_USER);

    // The agent has no user database; `scope: 'all'` is trusted because only the
    // authenticated backend can send it, and the permission that makes it
    // legitimate is checked there. Here we only assert the filter behaviour.
    const all = await dispatchRequest(cfg, OWNER, request('units.list', { scope: 'all' }));
    expect(all.ok).toBe(true);
    if (all.ok) expect((all.result as { units: unknown[] }).units).toHaveLength(2);
  });
});

/**
 * The registry lifecycle: create, exit, and the honesty rules around a process
 * that is gone.
 */
describe('unit lifecycle and exit normalization', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000c1';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-life-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    setBootIdForTests('current-boot');
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    setBootIdForTests(null);
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  it('normalizes a clean exit to exited with code 0', () => {
    const unit = seedUnitForTests(OWNER);
    finishUnitForTests(unit.id, { code: 0, signal: null });

    const after = getUnit(unit.id, OWNER);
    expect(after.state).toBe('exited');
    expect(after.exit?.normalized).toBe(0);
    expect(after.process.pid).toBeNull();
    expect(after.endedAt).not.toBeNull();
  });

  it('normalizes a non-zero exit to failed', () => {
    const unit = seedUnitForTests(OWNER);
    finishUnitForTests(unit.id, { code: 3, signal: null });

    const after = getUnit(unit.id, OWNER);
    expect(after.state).toBe('failed');
    expect(after.exit?.normalized).toBe(3);
  });

  it('normalizes a signal death to 128 + signal', () => {
    const unit = seedUnitForTests(OWNER);
    // SIGKILL is 9; a process the kernel killed did not choose its exit.
    finishUnitForTests(unit.id, { code: null, signal: 9 });

    const after = getUnit(unit.id, OWNER);
    expect(after.state).toBe('failed');
    expect(after.exit?.normalized).toBe(137);
    expect(after.exit?.signal).toBe(9);
  });

  it('records killed, not failed, when Aether asked for the end', () => {
    const unit = seedUnitForTests(OWNER);
    finishUnitForTests(unit.id, { code: null, signal: 15 }, true);

    const after = getUnit(unit.id, OWNER);
    // A unit Aether killed is `killed` regardless of how the process exited: the
    // fact that matters is that it was asked to stop, not the signal that stopped
    // it.
    expect(after.state).toBe('killed');
  });

  it('is idempotent across a repeated exit event', () => {
    const unit = seedUnitForTests(OWNER);
    finishUnitForTests(unit.id, { code: 0, signal: null });
    // A second exit — a race between the exit event and a reconcile — must not
    // rewrite the recorded end.
    finishUnitForTests(unit.id, { code: 42, signal: null });

    const after = getUnit(unit.id, OWNER);
    expect(after.state).toBe('exited');
    expect(after.exit?.normalized).toBe(0);
  });

  it('reconciles a process that vanished without an exit to stale, never exited', () => {
    // The record believes it is running and names a pid that is not alive — an
    // external SIGKILL, an OOM kill. It must become `stale`: not `running`
    // (false), and not `exited` (it did not finish).
    const unit = seedUnitForTests(OWNER, {
      state: 'running',
      // A pid recorded against a *different* boot than the one now in force. A
      // pid is only meaningful within one boot, so a boot-id mismatch is decided
      // as `gone` on every platform, without depending on /proc — which is what
      // lets this run identically on a Windows dev box and a Linux runner.
      process: { pid: 2_147_483_600, pgid: 2_147_483_600, startTicks: '1', bootId: 'old-boot' },
    });

    const runtimeUnit = listUnits({ ownerUserId: OWNER }).find((u) => u.id === unit.id);
    expect(runtimeUnit).toBeDefined();
    // listUnits reconciles before returning.
    expect(runtimeUnit?.state).toBe('stale');
  });
});

/**
 * Idempotent creation and the capacity limits.
 */
describe('unit creation guards', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000d1';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-guard-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  it('returns the same unit for a repeated requestId, never a second process', async () => {
    if (!canSpawn()) return;
    const requestId = 'idem-request-000001';
    const first = await createUnit(cfg, OWNER, { kind: 'tty', cols: 80, rows: 24, requestId });
    const second = await createUnit(cfg, OWNER, { kind: 'tty', cols: 80, rows: 24, requestId });

    expect(second.id).toBe(first.id);
    // One live unit, not two.
    expect(listUnits({ ownerUserId: OWNER, kind: 'tty' })).toHaveLength(1);
  });

  it('refuses a kind it has no supervisor for as NOT_IMPLEMENTED, before starting anything', async () => {
    // 501, not 503: a service is not temporarily unavailable, it is not built
    // yet. The honest code is what stops a client retrying something that can
    // never succeed.
    await expect(
      createUnit(cfg, OWNER, { kind: 'service', command: 'nginx', cols: 80, rows: 24 })
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(
      createUnit(cfg, OWNER, { kind: 'worker', command: 'do-work', cols: 80, rows: 24 })
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    // Nothing was recorded for a refused kind.
    expect(unitCountForTests()).toBe(0);
  });

  it('requires a command for a command unit', async () => {
    await expect(
      createUnit(cfg, OWNER, { kind: 'command', cols: 80, rows: 24 })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a unit that names a rejected environment variable', async () => {
    await expect(
      createUnit(cfg, OWNER, {
        kind: 'command',
        command: 'echo hi',
        env: { LD_PRELOAD: '/tmp/evil.so' },
        cols: 80,
        rows: 24,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Refused, not filtered: a caller that asked for it and silently did not get
    // it would be running something other than what it described.
    expect(unitCountForTests()).toBe(0);
  });
});

/**
 * The log ring: absolute offsets, and the dropped-byte accounting that tells a
 * reader its stream is incomplete rather than showing a silent gap.
 */
describe('unit log ring', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000e1';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-log-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  it('reads output back from an absolute offset', () => {
    const unit = seedUnitForTests(OWNER);
    appendOutputForTests(unit.id, 'hello ');
    appendOutputForTests(unit.id, 'world');

    const all = readUnitLog(unit.id, OWNER, { offset: 0, limit: 1024, stream: 'combined' });
    expect(all.content).toBe('hello world');
    expect(all.totalBytes).toBe(11);

    const tail = readUnitLog(unit.id, OWNER, { offset: 6, limit: 1024, stream: 'combined' });
    expect(tail.content).toBe('world');
    // The read starts where it was asked to, because nothing was dropped.
    expect(tail.offset).toBe(6);
  });

  it('reports dropped bytes and reads the retained tail when the ring overflows', () => {
    const unit = seedUnitForTests(OWNER);
    // The seeded ring is the instance default (256 KiB). Driving more than that
    // through it forces the oldest bytes out, which is the case a reader must be
    // told about rather than shown a silent gap.
    const big = 'x'.repeat(300_000);
    appendOutputForTests(unit.id, big);

    const read = readUnitLog(unit.id, OWNER, { offset: 0, limit: 512 * 1024, stream: 'combined' });
    // Total counts everything ever produced.
    expect(read.totalBytes).toBe(300_000);
    // The window is bounded, so some bytes were dropped and the read starts past
    // the offset that was asked for.
    expect(read.droppedBytes).toBeGreaterThan(0);
    expect(read.offset).toBeGreaterThan(0);
    expect(read.retainedBytes).toBeLessThanOrEqual(read.totalBytes);
  });

  it('keeps stdout and stderr separable on a pipe unit', () => {
    const unit = seedUnitForTests(OWNER, {
      kind: 'command',
      spec: {
        kind: 'command',
        shell: '/bin/bash',
        cwd: '/',
        env: {},
        tty: false,
        cols: null,
        rows: null,
        term: null,
        logMode: 'pipe',
        command: 'run',
      },
    });
    appendOutputForTests(unit.id, 'out-line\n', 'stdout');
    appendOutputForTests(unit.id, 'err-line\n', 'stderr');

    const out = readUnitLog(unit.id, OWNER, { offset: 0, limit: 1024, stream: 'stdout' });
    const err = readUnitLog(unit.id, OWNER, { offset: 0, limit: 1024, stream: 'stderr' });
    const combined = readUnitLog(unit.id, OWNER, { offset: 0, limit: 1024, stream: 'combined' });

    expect(out.content).toBe('out-line\n');
    expect(err.content).toBe('err-line\n');
    expect(combined.content).toBe('out-line\nerr-line\n');
  });
});

/**
 * Subscription replay: a late subscriber sees what the ring holds, and a unit
 * that already ended replays and then says so.
 */
describe('unit subscription', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000f1';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-sub-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  it('replays retained output to a late subscriber, then streams live', () => {
    const unit = seedUnitForTests(OWNER);
    appendOutputForTests(unit.id, 'before-attach\n');

    const live: UnitEvent[] = [];
    const attached = subscribeUnit(cfg, unit.id, OWNER, (event) => {
      live.push(event);
    });

    const replayText = attached.replay
      .filter((e): e is Extract<UnitEvent, { type: 'output' }> => e.type === 'output')
      .map((e) => e.data)
      .join('');
    expect(replayText).toContain('before-attach');

    appendOutputForTests(unit.id, 'after-attach\n');
    const liveText = live
      .filter((e): e is Extract<UnitEvent, { type: 'output' }> => e.type === 'output')
      .map((e) => e.data)
      .join('');
    expect(liveText).toContain('after-attach');

    attached.unsubscribe();
  });

  it('hands an already-ended unit its exit in the replay and streams nothing further', () => {
    const unit = seedUnitForTests(OWNER);
    appendOutputForTests(unit.id, 'output-before-exit\n');
    finishUnitForTests(unit.id, { code: 0, signal: null });

    const live: UnitEvent[] = [];
    const attached = subscribeUnit(cfg, unit.id, OWNER, (event) => {
      live.push(event);
    });

    // The exit is delivered as part of the replay, so a client that attaches
    // after the unit finished is told it finished rather than left waiting.
    const exit = attached.replay.find((e) => e.type === 'exit');
    expect(exit).toBeDefined();
    // Nothing streams after — the unsubscribe is a no-op for an ended unit.
    expect(live).toEqual([]);
  });
});

/**
 * Signalling and the escalation contract.
 */
describe('unit signalling', () => {
  const OWNER = '00000000-0000-4000-8000-000000000a01';
  let cfg: AgentConfig;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'aether-agent-unit-sig-'));
    process.env.AETHER_WORKSPACE_ROOT = workspace;
    resetWorkspaceRootCache();
    resetUnitsForTests();
    cfg = loadConfig();
    createLogger(cfg);
  });

  afterEach(async () => {
    await endAllUnits('test_teardown');
    resetUnitsForTests();
    resetWorkspaceRootCache();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.AETHER_WORKSPACE_ROOT;
  });

  it('reports not-delivered when signalling an already-ended unit', async () => {
    const unit = seedUnitForTests(OWNER);
    finishUnitForTests(unit.id, { code: 0, signal: null });

    const result = await signalUnit(unit.id, OWNER, 'SIGTERM', null);
    // The goal state is already reached, so this is not an error — but it is not
    // "delivered" either.
    expect(result).toEqual({ delivered: false, escalated: false });
  });

  it('raises 404 when a non-owner signals a unit', async () => {
    const unit = seedUnitForTests(OWNER);
    await expect(
      signalUnit(unit.id, '00000000-0000-4000-8000-000000000a02', 'SIGTERM', null)
    ).rejects.toThrowError(/does not exist/i);
  });
});
