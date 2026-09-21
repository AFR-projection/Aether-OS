import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import {
  closeAllTunnels,
  closeTunnel,
  closeTunnelsForUser,
  countTunnels,
  openTunnel,
  readTunnel,
  writeTunnel,
} from './port-tunnel.js';

import type { AgentConfig } from '../config.js';

/**
 * Ownership of a port tunnel, from the agent's side.
 *
 * A tunnel is a live socket to a service on this host, and it carries the user
 * who opened it. The agent is the containment boundary: the backend names the
 * principal a `ports.*` request is made on behalf of, and the agent refuses a
 * tunnel that is not that principal's — with the same 404 a missing tunnel gets,
 * so an id held by one user can never confirm another user's tunnel exists.
 *
 * These tests are the mirror of the terminal and unit ownership suites, for the
 * jalur (path) the port preview runs over. They spawn a real loopback server so
 * the tunnel is a real socket rather than a stub, which is what makes the
 * refusal meaningful: the bytes are genuinely reachable, and the only thing
 * standing between another user and them is the ownership check.
 */
describe('port tunnel ownership', () => {
  const OWNER = '00000000-0000-4000-8000-000000000c01';
  const OTHER_USER = '00000000-0000-4000-8000-000000000c02';

  let cfg: AgentConfig;
  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    cfg = loadConfig();
    createLogger(cfg);

    // A server that echoes back a fixed line the moment a client connects, so a
    // read has something real to return.
    server = net.createServer((socket) => {
      // When a tunnel is destroyed its peer socket here is reset; without a
      // listener that ECONNRESET is an unhandled 'error' that fails the run.
      socket.on('error', () => undefined);
      socket.write('hello-from-host\n');
    });
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });

  afterEach(async () => {
    closeAllTunnels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses to read, write, or close another user's tunnel with a 404", async () => {
    const { tunnelId } = await openTunnel(cfg, { port, ownerUserId: OWNER });

    // Read: the byte pipe must not answer to a stranger.
    await expect(readTunnel(cfg, tunnelId, OTHER_USER, 1024)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Write: nor accept their bytes.
    expect(() => writeTunnel(cfg, tunnelId, OTHER_USER, Buffer.from('x'))).toThrowError(
      /does not exist/i
    );
    // Close: nor be torn down by them.
    expect(() => closeTunnel(tunnelId, OTHER_USER)).toThrowError(/does not exist/i);

    // The tunnel is still there afterwards: a refusal that closed it would be the
    // same bug wearing a different answer.
    expect(countTunnels()).toBe(1);

    // And the owner can still use it.
    const read = await readTunnel(cfg, tunnelId, OWNER, 1024);
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toContain('hello-from-host');
  });

  it("answers a missing tunnel and someone else's tunnel identically", async () => {
    const { tunnelId } = await openTunnel(cfg, { port, ownerUserId: OWNER });
    const MISSING = '00000000-0000-4000-8000-0000000000ff';

    // Both are NOT_FOUND: a caller holding an id learns nothing about whether a
    // tunnel it does not own exists.
    await expect(readTunnel(cfg, MISSING, OWNER, 1024)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(readTunnel(cfg, tunnelId, OTHER_USER, 1024)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('closes only the tunnels of the user who signed out', async () => {
    const mine = await openTunnel(cfg, { port, ownerUserId: OWNER });
    const theirs = await openTunnel(cfg, { port, ownerUserId: OTHER_USER });
    expect(countTunnels()).toBe(2);

    const closed = closeTunnelsForUser(OWNER);
    expect(closed).toBe(1);
    expect(countTunnels()).toBe(1);

    // The other user's tunnel is untouched, and still theirs.
    void mine;
    const read = await readTunnel(cfg, theirs.tunnelId, OTHER_USER, 1024);
    expect(read.closed).toBe(false);
  });
});
