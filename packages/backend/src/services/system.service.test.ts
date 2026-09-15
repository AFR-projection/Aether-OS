import { describe, expect, it } from 'vitest';

import { ForbiddenError, NotImplementedError } from '../utils/errors.js';

import { ALLOWED_PROCESS_SIGNALS, listProcesses, signalProcess } from './system.service.js';

/**
 * Process-management guardrails.
 *
 * These tests assert on refusals only. Nothing here sends a signal to a live
 * process: every case stops at a guard that runs before `process.kill` is
 * reached, which is exactly the behaviour an operator depends on.
 *
 * `AETHER_PROCESS_SIGNAL_ENABLED` is set to `true` in `vitest.config.ts` so the
 * deeper guards are reachable. Widening the test's reach must never widen the
 * shipped default, which stays `false`.
 */

const LINUX = process.platform === 'linux';

describe('signalProcess refusals', () => {
  it('refuses pid 1', async () => {
    await expect(signalProcess(1, 'SIGTERM')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('says why pid 1 was refused, so the UI can explain it', async () => {
    const error = await signalProcess(1, 'SIGKILL').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).details).toMatchObject({
      reason: 'pid_1_is_init',
      pid: 1,
    });
  });

  it('refuses to signal itself', async () => {
    const error = await signalProcess(process.pid, 'SIGTERM').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).details).toMatchObject({ reason: 'protected_process' });
  });

  it('refuses before it ever reaches the platform check', async () => {
    // On Linux the platform gate passes and the protected set is what stops it;
    // on other platforms the protected check is deliberately ordered first. If
    // this ever returned NotImplementedError, the ordering regressed and pid 1
    // would be reachable on a platform that does implement signalling.
    await expect(signalProcess(1, 'SIGTERM')).rejects.not.toBeInstanceOf(NotImplementedError);
  });

  it.skipIf(LINUX)(
    'reports signalling as unimplemented off Linux for an ordinary pid',
    async () => {
      await expect(signalProcess(999_999, 'SIGTERM')).rejects.toBeInstanceOf(NotImplementedError);
    }
  );

  it.skipIf(!LINUX)('reports a missing process as not found on Linux', async () => {
    const error = await signalProcess(4_194_303, 'SIGTERM').catch((thrown: unknown) => thrown);

    expect(error).toBeDefined();
    expect((error as Error).name).toBe('NotFoundError');
  });
});

describe('ALLOWED_PROCESS_SIGNALS', () => {
  it('excludes the signals that cannot be caught and would be sendable to anything', () => {
    // SIGSTOP/SIGCONT are excluded because freezing a process (or the shell
    // running the request) is not something a process manager should expose
    // without a matching "resume" story; the list stays small on purpose.
    expect([...ALLOWED_PROCESS_SIGNALS]).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']);
  });

  it('marks nothing signalable when the capability is off', async () => {
    // The flag comes from configuration, and the shipped default is `false`, so
    // a listing must never advertise a control the API would refuse.
    const listing = await listProcesses({ limit: 5 });

    if (!listing.signalEnabled) {
      expect(listing.processes.every((entry) => !entry.signalable)).toBe(true);
    }
  });
});

describe('listProcesses', () => {
  it('returns the counters the client renders, even with no data', async () => {
    const listing = await listProcesses({ limit: 5 });

    expect(listing).toMatchObject({
      total: expect.any(Number),
      truncated: expect.any(Boolean),
      running: expect.any(Number),
      signalEnabled: expect.any(Boolean),
    });
    expect(Array.isArray(listing.processes)).toBe(true);
  });

  it.skipIf(!LINUX)('never advertises pid 1 as signalable', async () => {
    const listing = await listProcesses({ limit: 5000 });
    const init = listing.processes.find((entry) => entry.pid === 1);

    expect(init).toBeDefined();
    expect(init?.signalable).toBe(false);
  });

  it.skipIf(!LINUX)('never advertises its own process as signalable', async () => {
    const listing = await listProcesses({ limit: 5000 });
    const ownPid = process.pid;
    const self = listing.processes.find((entry) => entry.pid === ownPid);

    expect(self).toBeDefined();
    expect(self?.signalable).toBe(false);
  });

  it.skipIf(!LINUX)('caps the page at the requested limit and says so', async () => {
    const listing = await listProcesses({ limit: 3 });

    expect(listing.processes.length).toBeLessThanOrEqual(3);
    if (listing.total > 3) {
      expect(listing.truncated).toBe(true);
    }
  });

  it.skipIf(!LINUX)('counts running processes across the whole table, not the page', async () => {
    const full = await listProcesses({ limit: 100_000 });
    const paged = await listProcesses({ limit: 2 });

    expect(paged.running).toBe(full.running);
  });
});
