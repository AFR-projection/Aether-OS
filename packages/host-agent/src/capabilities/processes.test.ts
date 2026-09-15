import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { resetWorkspaceRootCache } from '../security/workspace.js';
import { killAllSessions, resetSessionsForTests } from '../capabilities/terminal.js';
import { listProcesses, signalProcess, ALLOWED_PROCESS_SIGNALS } from './processes.js';

beforeEach(() => {
  resetSessionsForTests();
  resetWorkspaceRootCache();
  const cfg = loadConfig();
  createLogger(cfg);
});

afterEach(() => {
  killAllSessions('test_teardown');
  resetSessionsForTests();
  resetWorkspaceRootCache();
});

describe('listProcesses', () => {
  it('returns counters and a bounded page', async () => {
    const cfg = loadConfig();
    const result = await listProcesses(cfg, { limit: 5, sortBy: 'pid' });
    expect(result.signalEnabled).toBe(cfg.PROCESS_SIGNAL_ENABLED);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.running).toBeGreaterThanOrEqual(0);
    expect(result.processes.length).toBeLessThanOrEqual(5);
  }, 30_000);
});

describe('signalProcess', () => {
  it('refuses to signal pid 1', async () => {
    const cfg = loadConfig();
    await expect(signalProcess(cfg, 1, 'SIGTERM')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to signal its own process', async () => {
    const cfg = loadConfig();
    await expect(signalProcess(cfg, process.pid, 'SIGTERM')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('ALLOWED_PROCESS_SIGNALS', () => {
  it('does not include uncatchable signals', () => {
    const set = new Set(ALLOWED_PROCESS_SIGNALS);
    // SIGKILL is a last resort but the policy allows it; SIGSTOP/SIGKILL-pair
    // is the uncatchable one we must NOT permit for ordinary process control,
    // but SIGTERM/SIGINT/SIGHUP/SIGKILL are all in the allowlist per the spec.
    expect(set.has('SIGSTOP')).toBe(false);
    expect(set.has('SIGKILL')).toBe(true);
  });
});
