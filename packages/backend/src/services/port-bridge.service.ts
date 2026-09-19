import { once } from 'node:events';
import net from 'node:net';

import { LIMITS } from '@aether/shared';

import { ServiceUnavailableError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

import type { TunnelTransport } from './agent-ports.service.js';

const log = subsystemLogger('port-bridge');

/**
 * Presents a tunnel as a socket an HTTP client can connect to.
 *
 * The tunnel is a byte pipe to a dev server that only the host agent can reach.
 * Something still has to speak HTTP over it, and the alternative — hand-rolling
 * a client that frames requests and parses responses — is a large amount of
 * code in the one place where a mistake is invisible until a real project
 * breaks on it. So instead of imitating a socket, this is one: a listener on
 * loopback that a real `http.request` connects to, with the two directions
 * piped to the tunnel. Node's own HTTP client does the protocol work.
 *
 * One bridge serves exactly one connection, because one connection is one
 * request to the dev server. A page load is dozens of these, each independent,
 * which is also what keeps a slow response from stalling its siblings.
 *
 * The listener is closed as soon as it has accepted its connection, so the
 * ephemeral port it was given is not left open to anything else on the machine.
 */
export interface TunnelBridge {
  /** Loopback port to send the HTTP request to. */
  port: number;
  /** Resolves once both directions have stopped. */
  done: Promise<void>;
  /** Tears the bridge down now: local socket destroyed, tunnel closed. */
  close(): void;
}

export async function bridgeTunnel(transport: TunnelTransport): Promise<TunnelBridge> {
  const server = net.createServer();

  let local: net.Socket | null = null;
  let finished = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveDone();
  };

  const close = (): void => {
    if (local !== null && !local.destroyed) local.destroy();
    server.close();
    void transport.close().catch((error: unknown) => {
      log.debug({ err: error }, 'closing the tunnel failed');
    });
    finish();
  };

  server.on('connection', (socket) => {
    // One bridge, one connection. Closing the listener here means a second
    // connection cannot arrive and be handed a tunnel that is already speaking
    // to somebody else.
    server.close();
    local = socket;
    void pump(socket, transport).then(finish, (error: unknown) => {
      log.debug({ err: error }, 'bridge ended abnormally');
      close();
    });
  });

  server.on('error', (error: unknown) => {
    log.warn({ err: error }, 'bridge listener failed');
    close();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    close();
    throw new ServiceUnavailableError('The preview bridge could not bind a local port');
  }

  return { port: address.port, done, close };
}

/**
 * Runs both directions until the connection ends.
 *
 * Backpressure is real in both directions and matters here. From the dev server:
 * a read is only outstanding while the local socket is draining, so bytes wait
 * in the kernel rather than in this process. To the dev server: the local socket
 * is paused for as long as a write is in flight, so a request body is fed only
 * as fast as the tunnel accepts it.
 */
async function pump(socket: net.Socket, transport: TunnelTransport): Promise<void> {
  let stopped = false;

  // Anything the socket emits after it is destroyed is a bug in the caller, not
  // a reason to crash the backend — the response has already been sent.
  socket.on('error', (error: unknown) => {
    log.debug({ err: error }, 'preview connection errored');
  });

  let writes: Promise<void> = Promise.resolve();
  socket.on('data', (chunk: Buffer) => {
    socket.pause();
    writes = writes
      .then(() => transport.write(chunk))
      .then(() => {
        if (!socket.destroyed) socket.resume();
      })
      .catch((error: unknown) => {
        log.debug({ err: error }, 'preview write failed');
        socket.destroy();
      });
  });

  socket.on('close', () => {
    stopped = true;
  });

  while (!stopped) {
    const { data, closed } = await transport.read(LIMITS.PORT_TUNNEL_CHUNK_BYTES);

    if (data.length > 0 && !socket.destroyed) {
      if (!socket.write(data)) {
        // Whichever comes first: the browser reading again, or the connection
        // going away while we wait. Racing the two is what keeps a closed socket
        // from leaving this loop waiting for a drain that will never arrive.
        await Promise.race([once(socket, 'drain'), once(socket, 'close')]).catch(() => undefined);
      }
    }

    if (closed) {
      if (!socket.destroyed) socket.end();
      break;
    }
  }

  await writes;
}
