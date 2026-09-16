import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { killAllSessions, resetSessionsForTests } from '../capabilities/terminal.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getSystemInfo } from './system.js';
import { resetWorkspaceRootCache } from '../security/workspace.js';

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

describe('getSystemInfo', () => {
  it('returns system information', async () => {
    const cfg = loadConfig();
    const info = await getSystemInfo(cfg);
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.platform).toBe(process.platform);
    expect(info.distro.length).toBeGreaterThan(0);
    expect(info.release.length).toBeGreaterThan(0);
    expect(info.kernel.length).toBeGreaterThan(0);
    expect(info.arch.length).toBeGreaterThan(0);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.bootTime.length).toBeGreaterThan(0);
    expect(info.cpu.model.length).toBeGreaterThan(0);
    expect(info.cpu.cores).toBeGreaterThan(0);
    expect(info.cpu.speedMhz).toBeGreaterThan(0);
    expect(info.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(info.cpu.loadAverage.length).toBe(3);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(info.memory.freeBytes).toBeGreaterThanOrEqual(0);
    expect(info.memory.usedBytes).toBeGreaterThanOrEqual(0);
    expect(info.memory.usagePercent).toBeGreaterThanOrEqual(0);
    expect(info.disks.length).toBeGreaterThanOrEqual(0);
    expect(info.network.length).toBeGreaterThanOrEqual(0);
    expect(info.nodeVersion.length).toBeGreaterThan(0);
    expect(info.instanceId).toBe(cfg.AETHER_AGENT_ID);
    expect(info.aetherVersion.length).toBeGreaterThan(0);
    expect(info.processUptimeMs).toBeGreaterThanOrEqual(0);
  });
});
