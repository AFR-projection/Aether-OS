import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

import {
  type CpuInfo,
  type DiskInfo,
  type MemoryInfo,
  type NetworkInterfaceInfo,
  type SystemInfo,
} from '@aether/shared';

import { subsystemLogger } from '../logger.js';
import { AETHER_VERSION } from '../version.js';

import type { AgentConfig } from '../config.js';

const log = subsystemLogger('system');

/**
 * Host metrics.
 *
 * Linux is the supported production platform, so `/proc` is read directly —
 * it is exact, requires no subprocess, and needs no privileges for the fields
 * used here. On other platforms the module degrades gracefully: Node's `os`
 * module covers CPU/memory, and the process list reports itself as unavailable
 * rather than inventing data.
 */

const LINUX = process.platform === 'linux';

interface CpuSample {
  idle: number;
  total: number;
  at: number;
}

let lastCpuSample: CpuSample | null = null;

async function readProcFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Parses the aggregate `cpu` line of `/proc/stat` into jiffies. */
function parseProcStat(content: string): CpuSample | null {
  const line = content.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) return null;

  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number.parseInt(value, 10));

  if (values.length < 4 || values.some((value) => Number.isNaN(value))) return null;

  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);

  return { idle, total, at: Date.now() };
}

async function sampleCpu(): Promise<CpuSample | null> {
  if (!LINUX) return null;
  const content = await readProcFile('/proc/stat');
  return content ? parseProcStat(content) : null;
}

/**
 * CPU utilisation since the previous call.
 *
 * The first call has no baseline, so a short second sample is taken instead of
 * reporting a misleading 0%.
 */
async function cpuUsagePercent(): Promise<number> {
  if (LINUX) {
    const current = await sampleCpu();
    if (current) {
      let previous = lastCpuSample;
      lastCpuSample = current;

      if (!previous || current.total <= previous.total) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        previous = current;
        const second = await sampleCpu();
        if (!second) return 0;
        lastCpuSample = second;
        return computeUsage(previous, second);
      }

      return computeUsage(previous, current);
    }
  }

  // Non-Linux fallback: load average normalised by core count.
  const [oneMinute] = os.loadavg();
  const cores = os.cpus().length || 1;
  return Math.min(100, Math.max(0, ((oneMinute ?? 0) / cores) * 100));
}

function computeUsage(previous: CpuSample, current: CpuSample): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Number(usage.toFixed(2))));
}

async function readDistro(): Promise<{ distro: string; release: string }> {
  const content = await readProcFile('/etc/os-release');
  if (!content) {
    return { distro: os.type(), release: os.release() };
  }

  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    values.set(key, rawValue.replace(/^"|"$/g, ''));
  }

  return {
    distro: values.get('PRETTY_NAME') ?? values.get('NAME') ?? os.type(),
    release: values.get('VERSION_ID') ?? os.release(),
  };
}

async function readMemory(): Promise<MemoryInfo> {
  const total = os.totalmem();
  const free = os.freemem();

  if (LINUX) {
    const content = await readProcFile('/proc/meminfo');
    if (content) {
      const values = new Map<string, number>();
      for (const line of content.split('\n')) {
        const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
        if (!match) continue;
        const [, key, amount] = match;
        if (!key || amount === undefined) continue;
        values.set(key, Number.parseInt(amount, 10) * 1024);
      }

      const memTotal = values.get('MemTotal');
      // MemAvailable is the kernel's own estimate of what a new workload could
      // claim; MemFree alone overstates pressure because of page cache.
      const memAvailable = values.get('MemAvailable') ?? values.get('MemFree');

      if (memTotal && memAvailable !== undefined) {
        const used = memTotal - memAvailable;
        return {
          totalBytes: memTotal,
          freeBytes: memAvailable,
          usedBytes: used,
          usagePercent: Number(((used / memTotal) * 100).toFixed(2)),
        };
      }
    }
  }

  const used = total - free;
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    usagePercent: total > 0 ? Number(((used / total) * 100).toFixed(2)) : 0,
  };
}

async function readCpuInfo(): Promise<CpuInfo> {
  const cpus = os.cpus();
  const [first] = cpus;

  return {
    model: first?.model.trim() ?? 'unknown',
    cores: cpus.length,
    speedMhz: first?.speed ?? 0,
    usagePercent: await cpuUsagePercent(),
    loadAverage: [
      Number((os.loadavg()[0] ?? 0).toFixed(2)),
      Number((os.loadavg()[1] ?? 0).toFixed(2)),
      Number((os.loadavg()[2] ?? 0).toFixed(2)),
    ],
  };
}

/**
 * Disk usage for the workspace and root filesystems.
 *
 * `statfs` reports the filesystem backing a path, so this reflects the volume
 * the user's data actually lives on rather than a guessed device name.
 */
async function readDisks(cfg: AgentConfig): Promise<DiskInfo[]> {
  const mounts = LINUX ? ['/', cfg.AETHER_WORKSPACE_ROOT] : [cfg.AETHER_WORKSPACE_ROOT];
  const seen = new Set<string>();
  const disks: DiskInfo[] = [];

  for (const mount of mounts) {
    try {
      const stats = await statfs(mount);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedBytes = totalBytes - stats.bfree * stats.bsize;

      const key = `${stats.bsize}:${stats.blocks}`;
      if (seen.has(key)) continue;
      seen.add(key);

      disks.push({
        filesystem: mount,
        mountPoint: mount,
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0,
      });
    } catch (error) {
      log.debug({ err: error, mount }, 'statfs failed for mount');
    }
  }

  return disks;
}

function readNetwork(): NetworkInterfaceInfo[] {
  const result: NetworkInterfaceInfo[] = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      result.push({
        name,
        address: address.address,
        family: address.family === 'IPv4' ? 'IPv4' : 'IPv6',
        internal: address.internal,
        mac: address.mac,
      });
    }
  }

  return result;
}

export async function getSystemInfo(cfg: AgentConfig): Promise<SystemInfo> {
  const [distro, memory, cpu, disks] = await Promise.all([
    readDistro(),
    readMemory(),
    readCpuInfo(),
    readDisks(cfg),
  ]);

  const bootTime = new Date(Date.now() - os.uptime() * 1000);

  return {
    hostname: os.hostname(),
    platform: process.platform,
    distro: distro.distro,
    release: distro.release,
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    bootTime: bootTime.toISOString(),
    cpu,
    memory,
    disks,
    network: readNetwork(),
    nodeVersion: process.version,
    instanceId: cfg.AETHER_AGENT_ID,
    aetherVersion: AETHER_VERSION,
    processUptimeMs: Math.floor(process.uptime() * 1000),
  };
}
