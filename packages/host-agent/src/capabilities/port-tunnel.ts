import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { LIMITS } from '@aether/shared';

import { ConflictError, NotFoundError, ServiceUnavailableError } from '../errors.js';
import { subsystemLogger } from '../logger.js';

import type { AgentConfig } from '../config.js';

const log = subsystemLogger('port-tunnel');

/**
 * A TCP tunnel to a port on this host, carried over the agent's own WebSocket.
 *
 * The point of the tunnel rather than a direct connection: the backend runs in a
 * container, and a dev server bound to `127.0.0.1` on this machine is on no
 * network the container can reach. The agent is on the machine, so it can
 * connect to loopback — and once the bytes are on the WebSocket, where they came
 * from stops mattering.
 *
 * The direction that needs care is host → backend. The obvious design has the
 * socket push frames as data arrives, which makes the agent an unbounded buffer:
 * a server that writes faster than the WebSocket drains would be held in the
 * agent's memory until it died, and there is no way to push back on a kernel
 * socket through a message channel. So the backend *pulls* instead. A
 * `ports.read` request is answered as soon as there is anything to send, and the
 * socket is paused in the meantime, which leaves the kernel's own TCP window as
 * the only buffer in the path and applies backpressure all the way back to the
 * server being previewed.
 */

/** Longest a `ports.read` waits before answering with nothing. Must fit well inside the backend's request timeout. */
const READ_WAIT_MS = 5_000;

interface TunnelRuntime {
  id: string;
  socket: net.Socket;
  ownerUserId: string;
  /** Bytes received from the socket and not yet taken by a reader. */
  buffered: Buffer[];
  bufferedBytes: number;
  closed: boolean;
  closeReason: string | null;
  /** Resolves the outstanding read, if one is waiting. */
  wake: (() => void) | null;
  idleTimer: NodeJS.Timeout | null;
}

const tunnels = new Map<string, TunnelRuntime>();

export function countTunnels(): number {
  return tunnels.size;
}

function touch(runtime: TunnelRuntime, cfg: AgentConfig): void {
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  runtime.idleTimer = setTimeout(() => {
    log.info({ tunnelId: runtime.id, port: runtime.socket.remotePort }, 'tunnel idle timeout');
    destroyTunnel(runtime.id, 'idle_timeout');
  }, cfg.PORT_TUNNEL_IDLE_TIMEOUT);
  runtime.idleTimer.unref();
}

function buildBuffered(runtime: TunnelRuntime, maxBytes: number): Buffer | null {
  if (runtime.bufferedBytes === 0) return null;

  let taken = 0;
  const parts: Buffer[] = [];
  while (runtime.buffered.length > 0 && taken < maxBytes) {
    const head = runtime.buffered[0] as Buffer;
    const remaining = maxBytes - taken;
    if (head.length <= remaining) {
      runtime.buffered.shift();
      parts.push(head);
      taken += head.length;
    } else {
      parts.push(head.subarray(0, remaining));
      runtime.buffered[0] = head.subarray(remaining);
      taken += remaining;
    }
  }

  runtime.bufferedBytes -= taken;

  // Only a reader that took everything gets the socket resumed. A reader that
  // stopped at `maxBytes` leaves data queued, and resuming would grow the queue
  // past the point the pull loop can drain it.
  if (runtime.bufferedBytes === 0 && !runtime.closed) runtime.socket.resume();

  return Buffer.concat(parts, taken);
}

function fail(runtime: TunnelRuntime, reason: string): void {
  runtime.closed = true;
  runtime.closeReason = reason;
  runtime.wake?.();
  runtime.wake = null;
}

/**
 * Frees a finished tunnel's slot.
 *
 * Separate from `destroyTunnel` because the socket can end on its own — the
 * server closed it, which is how every HTTP response ends — and the slot still
 * has to come back immediately. One page load opens a connection per asset, so
 * waiting for the idle timer to reap them would leave the tunnel limit spent
 * before the page had finished loading.
 */
function retireTunnel(runtime: TunnelRuntime): void {
  if (tunnels.get(runtime.id) === runtime) tunnels.delete(runtime.id);
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
  runtime.idleTimer = null;
}

function destroyTunnel(id: string, reason: string): void {
  const runtime = tunnels.get(id);
  if (!runtime) return;

  retireTunnel(runtime);
  runtime.closed = true;
  runtime.closeReason = runtime.closeReason ?? reason;
  runtime.wake?.();
  runtime.wake = null;

  // `destroy()` on an already-destroyed socket is a no-op, which is what makes
  // this safe to call from both the error handler and the close handler.
  runtime.socket.destroy();
}

export interface OpenTunnelOptions {
  port: number;
  /** Defaults to loopback: the tunnel exists for servers only this machine can reach. */
  host?: string;
  ownerUserId: string;
}

export async function openTunnel(
  cfg: AgentConfig,
  options: OpenTunnelOptions
): Promise<{ tunnelId: string }> {
  if (!cfg.PORT_FORWARD_ENABLED) {
    throw new ServiceUnavailableError('Port forwarding is disabled on this host');
  }
  if (countTunnels() >= cfg.PORT_TUNNEL_MAX) {
    throw new ConflictError('This host has reached its open tunnel limit', {
      limit: cfg.PORT_TUNNEL_MAX,
    });
  }

  const host = options.host ?? '127.0.0.1';
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const candidate = net.connect({ host, port: options.port });
    const onError = (error: Error): void => {
      candidate.destroy();
      reject(
        new ServiceUnavailableError(`Could not connect to ${host}:${options.port}`, {
          cause: error.message,
        })
      );
    };
    candidate.once('error', onError);
    candidate.once('connect', () => {
      candidate.off('error', onError);
      resolve(candidate);
    });
  });

  const id = randomUUID();
  const runtime: TunnelRuntime = {
    id,
    socket,
    ownerUserId: options.ownerUserId,
    buffered: [],
    bufferedBytes: 0,
    closed: false,
    closeReason: null,
    wake: null,
    idleTimer: null,
  };

  socket.setNoDelay(true);
  socket.pause();

  socket.on('data', (chunk: Buffer) => {
    runtime.buffered.push(chunk);
    runtime.bufferedBytes += chunk.length;

    // A reader that is behind does not get the socket resumed by `data`; the
    // pull loop resumes it once its queue is empty. This is the whole backpressure
    // story, so pausing here rather than in `buildBuffered` matters.
    socket.pause();

    const wake = runtime.wake;
    runtime.wake = null;
    wake?.();
  });
  socket.on('error', (error: Error) => {
    log.debug({ err: error, tunnelId: id }, 'tunnel socket error');
    fail(runtime, error.message);
  });
  socket.on('close', () => {
    fail(runtime, 'closed');
    // The socket is gone, so the tunnel is over. Retiring it here rather than
    // leaving it for the idle timer is what keeps the tunnel limit usable: a
    // single page load opens one connection per asset, and none of them outlive
    // the response they carried.
    retireTunnel(runtime);
  });

  tunnels.set(id, runtime);
  touch(runtime, cfg);
  log.info({ tunnelId: id, host, port: options.port }, 'tunnel opened');

  return { tunnelId: id };
}

export interface ReadResult {
  contentBase64: string;
  closed: boolean;
  reason: string | null;
}

export async function readTunnel(
  cfg: AgentConfig,
  tunnelId: string,
  ownerUserId: string,
  maxBytes: number
): Promise<ReadResult> {
  const runtime = requireOwnedTunnel(tunnelId, ownerUserId);
  touch(runtime, cfg);

  if (runtime.bufferedBytes === 0 && !runtime.closed) {
    runtime.socket.resume();
    await new Promise<void>((resolve) => {
      // One way to finish, whether data arrived, the socket closed, or the wait
      // ran out, so neither the timer nor the wake-up can be left dangling.
      // `done` is registered only after `timer` exists, so it can never be
      // called while `timer` is still uninitialised.
      const done = (): void => {
        clearTimeout(timer);
        if (runtime.wake === done) runtime.wake = null;
        resolve();
      };
      const timer = setTimeout(done, READ_WAIT_MS);
      timer.unref();
      runtime.wake = done;
    });
  }

  const chunk = buildBuffered(runtime, Math.min(maxBytes, LIMITS.PORT_TUNNEL_CHUNK_BYTES));

  return {
    contentBase64: chunk === null ? '' : chunk.toString('base64'),
    closed: runtime.closed,
    reason: runtime.closeReason,
  };
}

export function writeTunnel(
  cfg: AgentConfig,
  tunnelId: string,
  ownerUserId: string,
  content: Buffer
): { written: number } {
  const runtime = requireOwnedTunnel(tunnelId, ownerUserId);
  touch(runtime, cfg);

  if (runtime.closed) {
    throw new ConflictError('The tunnel is closed', { tunnelId });
  }

  // `write` returns false when the kernel buffer is full but still queues the
  // bytes, so the only way to bound what this process holds is to look at how
  // much is already queued and refuse to add to a queue that is already large.
  if (runtime.socket.writableLength > LIMITS.PORT_TUNNEL_MAX_BUFFER_BYTES) {
    destroyTunnel(tunnelId, 'write_buffer_exceeded');
    throw new ConflictError('The server is not reading fast enough; the tunnel was closed', {
      tunnelId,
    });
  }

  runtime.socket.write(content);
  return { written: content.length };
}

export function closeTunnel(tunnelId: string, ownerUserId: string): { closed: boolean } {
  requireOwnedTunnel(tunnelId, ownerUserId);
  destroyTunnel(tunnelId, 'closed_by_request');
  return { closed: true };
}

/**
 * Closes every tunnel owned by a user, for when their session ends.
 *
 * A tunnel is a live connection to a service on this host; leaving one open
 * after the person who opened it has gone is not something to do quietly.
 */
export function closeTunnelsForUser(userId: string): number {
  let closed = 0;
  for (const [id, runtime] of [...tunnels]) {
    if (runtime.ownerUserId !== userId) continue;
    destroyTunnel(id, 'owner_signed_out');
    closed += 1;
  }
  return closed;
}

function requireOwnedTunnel(tunnelId: string, ownerUserId: string): TunnelRuntime {
  const runtime = tunnels.get(tunnelId);
  if (!runtime) {
    throw new NotFoundError('Tunnel does not exist', { tunnelId });
  }
  if (runtime.ownerUserId !== ownerUserId) {
    // Same answer as a missing tunnel: whether someone else's tunnel exists is
    // not this caller's business.
    throw new NotFoundError('Tunnel does not exist', { tunnelId });
  }
  return runtime;
}

/** Closes every tunnel. Used on shutdown so no socket outlives the process. */
export function closeAllTunnels(): void {
  for (const id of [...tunnels.keys()]) destroyTunnel(id, 'agent_shutdown');
}
