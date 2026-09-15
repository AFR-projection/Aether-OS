export interface CpuInfo {
  model: string;
  cores: number;
  speedMhz: number;
  /** 0-100, averaged across cores over the sampling window. */
  usagePercent: number;
  loadAverage: [number, number, number];
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usagePercent: number;
}

export interface DiskInfo {
  filesystem: string;
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  mac: string;
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  distro: string;
  release: string;
  kernel: string;
  arch: string;
  uptimeSeconds: number;
  bootTime: string;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetworkInterfaceInfo[];
  nodeVersion: string;
  /** Identity of this Aether instance, generated at install time. */
  instanceId: string;
  aetherVersion: string;
  /** Monotonic milliseconds since the backend process started. */
  processUptimeMs: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  /** CPU usage percentage over the sampling window. */
  cpuPercent: number;
  /** Resident set size in bytes. */
  memoryBytes: number;
  state: string;
  startedAt: string | null;
  command: string;
}

export interface ProcessListResponse {
  processes: ProcessInfo[];
  total: number;
  /** True when the process table was larger than the returned page. */
  truncated: boolean;
}
