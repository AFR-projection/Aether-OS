import { Buffer } from 'node:buffer';

import { LIMITS, type ListeningPort, type PortListResponse } from '@aether/shared';

import { sendAgentRequest } from './agent-rpc.service.js';
import { NotFoundError, ServiceUnavailableError } from '../utils/errors.js';

/**
 * Host-scope port operations.
 *
 * Both of these answer a question the backend cannot answer about itself. It
 * runs in a container whose only route out is the reverse proxy, so it can
 * neither see which ports the machine is listening on nor connect to a server
 * bound to that machine's loopback — which is where most frameworks put a dev
 * server by default. The agent runs on the machine, so it can do both.
 */

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ServiceUnavailableError(`The host agent returned an unexpected ${context} reply`);
  }
  return value as Record<string, unknown>;
}

/**
 * Keeps a listing entry only if it names a port.
 *
 * The reply is adapted rather than trusted: a malformed row would otherwise
 * reach the Ports app as a row that cannot be acted on, and every row here is
 * something the user is invited to open.
 */
function toListeningPort(value: unknown): ListeningPort | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const port = record.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  return {
    port,
    address: typeof record.address === 'string' ? record.address : '0.0.0.0',
    family: record.family === 'ipv6' ? 'ipv6' : 'ipv4',
    pid: typeof record.pid === 'number' ? record.pid : null,
    process: typeof record.process === 'string' ? record.process : null,
    command: typeof record.command === 'string' ? record.command : null,
    loopbackOnly: record.loopbackOnly === true,
  };
}

export async function hostListPorts(agentId: string): Promise<PortListResponse> {
  const reply = expectRecord(await sendAgentRequest(agentId, 'ports.list', {}), 'port list');

  const raw = Array.isArray(reply.ports) ? reply.ports : [];
  const ports: ListeningPort[] = [];
  for (const entry of raw) {
    const port = toListeningPort(entry);
    if (port !== null) ports.push(port);
  }

  return {
    ports,
    total: typeof reply.total === 'number' ? reply.total : ports.length,
    truncated: reply.truncated === true,
    forwardEnabled: reply.forwardEnabled !== false,
  };
}

/**
 * One open connection to a port on the host, as a byte pipe.
 *
 * The agent owns a real TCP socket to the previewed server. This is the
 * backend's end of it: `read` asks for whatever has arrived, `write` sends, and
 * `close` hangs up. Nothing here buffers beyond a single call, because the
 * agent only lets the socket produce bytes while a read is outstanding — the
 * kernel's TCP window is the buffer, which is what makes a slow reader slow the
 * dev server instead of the agent.
 */
export interface TunnelTransport {
  read(maxBytes: number): Promise<{ data: Buffer; closed: boolean }>;
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface OpenTunnelOptions {
  port: number;
  /** Defaults to loopback on the agent: the point is reaching a local server. */
  host?: string;
}

export async function openHostTunnel(
  agentId: string,
  options: OpenTunnelOptions
): Promise<TunnelTransport> {
  const opened = expectRecord(
    await sendAgentRequest(agentId, 'ports.open', {
      port: options.port,
      ...(options.host !== undefined ? { host: options.host } : {}),
    }),
    'open tunnel'
  );

  const tunnelId = opened.tunnelId;
  if (typeof tunnelId !== 'string' || tunnelId.length === 0) {
    throw new ServiceUnavailableError('The host agent opened no tunnel');
  }

  let released = false;

  const releaseOnce = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await sendAgentRequest(agentId, 'ports.close', { tunnelId });
    } catch (error) {
      // The goal state is "closed", and an agent that has already reaped the
      // tunnel — an idle timeout, a disconnect — has reached it. Only an
      // unexpected failure is worth reporting, and there is no caller left to
      // report it to by the time this runs.
      if (!(error instanceof NotFoundError)) throw error;
    }
  };

  return {
    async read(maxBytes: number) {
      let reply: Record<string, unknown>;
      try {
        reply = expectRecord(
          await sendAgentRequest(agentId, 'ports.read', {
            tunnelId,
            maxBytes: Math.min(maxBytes, LIMITS.PORT_TUNNEL_CHUNK_BYTES),
          }),
          'tunnel read'
        );
      } catch (error) {
        // The agent retires a tunnel as soon as its socket closes. A read that
        // arrives after that is being told the same thing the socket close
        // meant, so it is reported as an end rather than as a failure.
        if (error instanceof NotFoundError) {
          released = true;
          return { data: Buffer.alloc(0), closed: true };
        }
        throw error;
      }

      return {
        data:
          typeof reply.contentBase64 === 'string'
            ? Buffer.from(reply.contentBase64, 'base64')
            : Buffer.alloc(0),
        closed: reply.closed === true,
      };
    },

    async write(data: Buffer) {
      if (released) return;
      try {
        await sendAgentRequest(agentId, 'ports.write', {
          tunnelId,
          contentBase64: data.toString('base64'),
        });
      } catch (error) {
        // A refused write means the tunnel is gone, and every later write would
        // fail the same way. Marking it released stops the retry loop that would
        // otherwise repeat this failure once per chunk of a request body.
        if (error instanceof NotFoundError) {
          released = true;
          return;
        }
        throw error;
      }
    },

    close: releaseOnce,
  };
}
