import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { bridgeTunnel } from './port-bridge.service.js';

import type { TunnelTransport } from './agent-ports.service.js';

/**
 * The bridge is where a tunnel becomes something Node's HTTP client can talk
 * to, so it is tested the way it is used: a real request, over a real socket,
 * through a transport that only hands over bytes when asked.
 *
 * The transport below is deliberately not a socket stream. The agent answers a
 * read only when it has bytes or has waited long enough, and holds the socket
 * back in between — that is where this path's backpressure comes from, and a
 * test with a plain pipe would exercise none of it.
 */

const READ_WAIT_MS = 20;

function pullTransport(socket: net.Socket): TunnelTransport {
  const queue: Buffer[] = [];
  let waiting: (() => void) | null = null;
  let closed = false;

  socket.on('data', (chunk: Buffer) => {
    queue.push(chunk);
    const wake = waiting;
    waiting = null;
    wake?.();
  });
  socket.on('close', () => {
    closed = true;
    const wake = waiting;
    waiting = null;
    wake?.();
  });
  socket.on('error', () => {
    closed = true;
  });

  return {
    async read(maxBytes) {
      if (queue.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (waiting === wake) waiting = null;
            resolve();
          }, READ_WAIT_MS);
          const wake = (): void => {
            clearTimeout(timer);
            resolve();
          };
          waiting = wake;
        });
      }

      // A read takes what was asked for and leaves the rest queued, exactly as
      // the agent does — a transport that dropped the remainder would make the
      // large-response test pass for the wrong reason.
      const all = Buffer.concat(queue.splice(0));
      if (all.length > maxBytes) {
        queue.push(all.subarray(maxBytes));
        return { data: all.subarray(0, maxBytes), closed };
      }
      return { data: all, closed };
    },
    write(data) {
      socket.write(data);
      // The contract is asynchronous even though a socket write is not: a real
      // transport waits for the agent to acknowledge the chunk, and the bridge's
      // backpressure handling depends on a write not resolving instantly.
      return Promise.resolve();
    },
    close() {
      closed = true;
      socket.destroy();
      return Promise.resolve();
    },
  };
}

const servers: http.Server[] = [];
const bridges: Array<{ close(): void }> = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const server of servers.splice(0)) server.close();
});

interface Harness {
  /** Port the origin server listens on, for assertions about the target. */
  port: number;
  /** Performs one request, over a fresh bridge — one bridge is one connection. */
  request(options?: {
    method?: string;
    path?: string;
    body?: string;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
}

async function startHarness(handler: http.RequestListener): Promise<Harness> {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no origin address');

  return {
    port: address.port,
    async request(options = {}) {
      const target = net.connect({ host: '127.0.0.1', port: address.port });
      await new Promise<void>((resolve, reject) => {
        target.once('connect', resolve);
        target.once('error', reject);
      });

      const bridge = await bridgeTunnel(pullTransport(target));
      bridges.push(bridge);

      return requestThrough(bridge.port, options);
    },
  };
}

function requestThrough(
  bridgePort: number,
  options: { method?: string; path?: string; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: bridgePort,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { connection: 'close' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );

    request.on('error', reject);
    if (options.body !== undefined) request.end(options.body);
    else request.end();
  });
}

describe('bridging a tunnel to an HTTP client', () => {
  it('carries a request and its response', async () => {
    const origin = await startHarness((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello from the dev server');
    });

    const result = await origin.request();
    expect(result.status).toBe(200);
    expect(result.body).toBe('hello from the dev server');
  });

  it('passes the path and the method through', async () => {
    const origin = await startHarness((request, response) => {
      response.writeHead(200);
      response.end(`${request.method} ${request.url}`);
    });

    expect((await origin.request({ path: '/assets/app.js' })).body).toBe('GET /assets/app.js');
    expect((await origin.request({ method: 'POST', body: 'x=1' })).body).toBe('POST /');
  });

  it('sends a request body', async () => {
    const origin = await startHarness((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200);
        response.end(Buffer.concat(chunks));
      });
    });

    const result = await origin.request({ method: 'POST', body: 'name=aether' });
    expect(result.body).toBe('name=aether');
  });

  it('carries a response larger than one read', async () => {
    // The payload is many times a read, so this only passes if the pull loop
    // keeps asking until the response ends.
    const payload = 'x'.repeat(256 * 1024);

    const origin = await startHarness((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(payload);
    });

    const result = await origin.request();
    expect(result.body.length).toBe(payload.length);
  });

  it('passes the dev server response headers through', async () => {
    const origin = await startHarness((_request, response) => {
      response.writeHead(201, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end('{}');
    });

    const result = await origin.request();
    expect(result.status).toBe(201);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
