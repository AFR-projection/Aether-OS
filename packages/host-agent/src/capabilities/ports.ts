import { readdir, readFile, readlink } from 'node:fs/promises';

import { LIMITS, type ListeningPort, type PortListResponse } from '@aether/shared';

import { NotImplementedError } from '../errors.js';
import { subsystemLogger } from '../logger.js';

import type { AgentConfig } from '../config.js';

const LINUX = process.platform === 'linux';

const log = subsystemLogger('ports');

/**
 * Listening TCP sockets, and the processes behind them.
 *
 * `/proc/net/tcp` is the kernel's own table: one row per socket, with the local
 * address and port in hex and — the useful part — the socket's inode. The table
 * says nothing about which process owns a socket, so the inode is joined against
 * `/proc/<pid>/fd/*`, whose symlinks read `socket:[<inode>]` for exactly this
 * purpose. That join is why listing ports costs a walk of the process table
 * rather than a single file read.
 *
 * Only TCP and only the LISTEN state: a server a browser can open. UDP has no
 * listen state and nothing to connect to, and an established TCP socket is
 * somebody's open connection rather than a service.
 */

/** `st` value for a listening socket in `/proc/net/tcp`. */
const TCP_LISTEN = '0A';

interface RawSocket {
  address: string;
  port: number;
  inode: string;
  family: 'ipv4' | 'ipv6';
}

/**
 * Reverses the byte order of each 32-bit word in a hex string.
 *
 * The kernel stores socket addresses in host byte order per word, so both the
 * IPv4 and the IPv6 form need this before the bytes mean anything. Output is
 * lowercased as it is produced: `/proc` prints its hex in upper case, and every
 * comparison downstream — the IPv4-mapped check, the loopback test — would
 * otherwise have to remember that.
 */
function bytesInHostOrder(raw: string): string[] {
  const bytes: string[] = [];
  for (let offset = 0; offset + 8 <= raw.length; offset += 8) {
    const word = raw.slice(offset, offset + 8);
    bytes.push(...[6, 4, 2, 0].map((position) => word.slice(position, position + 2).toLowerCase()));
  }
  return bytes;
}

function dottedQuad(bytes: string[]): string {
  return bytes.map((byte) => Number.parseInt(byte, 16)).join('.');
}

/**
 * Decodes the address field of one `/proc/net/tcp` row.
 *
 * The kernel prints it as hex and in host byte order, so `0100007F` is
 * `127.0.0.1` and `00000000` is every interface. IPv6 is the same reversal
 * applied per 32-bit word across 16 bytes, giving
 * `00000000000000000000000001000000` for `::1`.
 *
 * An IPv4-mapped address is rendered as `::ffff:127.0.0.1` rather than as the
 * equivalent `::ffff:7f00:1`. Both name the same socket, but only the first is
 * recognisable at a glance, and a dual-stack listener on loopback is common
 * enough that it would otherwise look like an address nobody can connect to.
 */
export function decodeAddress(raw: string, family: 'ipv4' | 'ipv6'): string {
  const bytes = bytesInHostOrder(raw);
  const expected = family === 'ipv4' ? 4 : 16;
  if (bytes.length !== expected) return raw;

  if (family === 'ipv4') return dottedQuad(bytes);

  const mapped = bytes.slice(0, 10).every((byte) => byte === '00');
  if (mapped && bytes[10] === 'ff' && bytes[11] === 'ff') {
    return `::ffff:${dottedQuad(bytes.slice(12))}`;
  }

  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(`${bytes[index] ?? ''}${bytes[index + 1] ?? ''}`.toLowerCase());
  }
  return compressIpv6(groups);
}

/**
 * Writes eight 16-bit hex groups the way a person would type them.
 *
 * `::` stands in for the longest run of two or more zero groups, which is what
 * turns sixteen zeros into `::` and `0000:…:0000:0001` into `::1`.
 */
export function compressIpv6(groups: string[]): string {
  const trimmed = groups.map((group) => group.replace(/^0{1,3}/, '') || '0');

  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  for (let index = 0; index <= trimmed.length; index += 1) {
    if (index < trimmed.length && trimmed[index] === '0') {
      if (start === -1) start = index;
      length += 1;
    } else if (start !== -1) {
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
      length = 0;
    }
  }

  if (bestLength < 2) return trimmed.join(':');
  const before = trimmed.slice(0, bestStart).join(':');
  const after = trimmed.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

/** Parses one `/proc/net/tcp{,6}` table. */
async function readSocketTable(filePath: string, family: 'ipv4' | 'ipv6'): Promise<RawSocket[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    log.debug({ err: error, filePath }, 'socket table is not readable');
    return [];
  }

  const sockets: RawSocket[] = [];

  for (const line of content.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;

    // sl, local_address, rem_address, st, ..., inode (index 9).
    const local = fields[1];
    const state = fields[3];
    const inode = fields[9];
    if (local === undefined || state !== TCP_LISTEN || inode === undefined) continue;

    const [rawAddress, rawPort] = local.split(':');
    if (rawAddress === undefined || rawPort === undefined) continue;

    const port = Number.parseInt(rawPort, 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;

    sockets.push({ address: decodeAddress(rawAddress, family), port, inode, family });
  }

  return sockets;
}

/**
 * Maps socket inode to owning process.
 *
 * Every process's file descriptors are checked, which is the only way the kernel
 * exposes this: there is no reverse index. Unreadable directories are skipped
 * rather than failing the listing — the agent runs as root and normally sees
 * everything, but a process in another namespace or already exited must not be
 * able to break the whole table.
 */
async function mapInodesToProcesses(): Promise<
  Map<string, { pid: number; process: string; command: string }>
> {
  const owners = new Map<string, { pid: number; process: string; command: string }>();

  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch (error) {
    log.debug({ err: error }, 'process table is not readable');
    return owners;
  }

  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      // Exited, or not ours to read. Either way there is nothing to learn here.
      continue;
    }

    const inodes: string[] = [];
    for (const fd of fds) {
      let target: string;
      try {
        target = await readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1] !== undefined) inodes.push(match[1]);
    }

    if (inodes.length === 0) continue;

    // Read the identifying files only for processes that hold a socket, which
    // keeps this to the handful of processes that matter instead of the whole
    // table.
    const [statusContent, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
      readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    ]);

    const name = /^Name:\s+(.*)$/m.exec(statusContent)?.[1]?.trim() ?? entry;
    const command = cmdline.replace(/\0/g, ' ').trim();
    const record = { pid, process: name, command };

    for (const inode of inodes) {
      // First writer wins: the oldest process holding a descriptor is the one
      // that opened the socket, and a forked worker inherits a copy.
      if (!owners.has(inode)) owners.set(inode, record);
    }
  }

  return owners;
}

/**
 * Whether a socket bound to `address` is reachable only from this machine.
 *
 * A dual-stack listener on loopback appears as `::ffff:127.0.0.1`, so the
 * mapped form has to count as loopback too — otherwise the flag that exists to
 * explain why a URL works in one place and not another would be wrong for one of
 * the most common ways to bind a dev server.
 */
export function isLoopbackBound(address: string): boolean {
  return address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.');
}

export async function listListeningPorts(cfg: AgentConfig): Promise<PortListResponse> {
  if (!LINUX) {
    throw new NotImplementedError('Listing listening ports is only supported on Linux');
  }

  const [v4, v6, owners] = await Promise.all([
    readSocketTable('/proc/net/tcp', 'ipv4'),
    readSocketTable('/proc/net/tcp6', 'ipv6'),
    mapInodesToProcesses(),
  ]);

  // A dual-stack server listens on both tables for the same port. Reporting it
  // twice would look like two servers, so the IPv4 row wins and the IPv6 one is
  // kept only when it is the sole claim on that port.
  const byPort = new Map<number, RawSocket>();
  for (const socket of [...v4, ...v6]) {
    const existing = byPort.get(socket.port);
    if (existing === undefined || (existing.family === 'ipv6' && socket.family === 'ipv4')) {
      byPort.set(socket.port, socket);
    }
  }

  const ports: ListeningPort[] = [];
  for (const socket of byPort.values()) {
    const owner = owners.get(socket.inode) ?? null;
    ports.push({
      port: socket.port,
      address: socket.address,
      family: socket.family,
      pid: owner?.pid ?? null,
      process: owner?.process ?? null,
      command: owner?.command && owner.command.length > 0 ? owner.command : null,
      loopbackOnly: isLoopbackBound(socket.address),
    });
  }

  ports.sort((a, b) => a.port - b.port);

  return {
    ports: ports.slice(0, LIMITS.MAX_LISTENING_PORTS),
    total: ports.length,
    truncated: ports.length > LIMITS.MAX_LISTENING_PORTS,
    forwardEnabled: cfg.PORT_FORWARD_ENABLED,
  };
}
