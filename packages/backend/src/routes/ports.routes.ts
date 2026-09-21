import { Buffer } from 'node:buffer';
import http from 'node:http';

import {
  portsQuerySchema,
  previewBodySchema,
  releasePreviewQuerySchema,
  type PortsResponse,
} from '@aether/shared';

import { config } from '../config.js';
import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { desktopOrigin, previewCapability, previewPortForHost } from '../security/preview.js';
import { hostListPorts, openHostTunnel } from '../services/agent-ports.service.js';
import { isAgentRpcConnected } from '../services/agent-rpc.service.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { bridgeTunnel } from '../services/port-bridge.service.js';
import {
  authorizePreviewRequest,
  clearPreviewCookie,
  issuePreviewToken,
  listPreviewsForUser,
  previewCookie,
  releasePreview,
  reservePreview,
} from '../services/preview.service.js';
import { AppError, ServiceUnavailableError } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Ports API: what the host is listening on, and how one of those becomes a page
 * in the desktop.
 *
 * The list is a straight proxy to the host agent — this backend runs in a
 * container and cannot see the machine's sockets at all. Opening a preview
 * reserves one of the instance's preview addresses for that port and answers
 * with the URL; the page then loads from that address, on an origin of its own,
 * and every request it makes arrives back here tagged with the address it came
 * in on.
 *
 * That last part is why previews are served from a hook rather than a route. A
 * preview answers whatever paths the app asks for — `/`, `/assets/app.js`,
 * `/api/session` — so there is no path pattern to register. The address the
 * request arrived on *is* the route.
 */

/** Headers that describe one hop and must not be passed along. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * How long a dev server may take to start answering before the preview gives up.
 *
 * Generous on purpose: the first request to a fresh Vite or webpack server
 * triggers dependency pre-bundling, which on a small VPS is the slowest thing
 * that will ever happen on this path. It is a floor on patience, not a claim
 * about how fast a server should be.
 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Intercepts requests that arrive on a preview address.
 *
 * Registered before the API routes, because a preview request must never reach
 * them: its paths are the previewed app's, and one of them will sooner or later
 * collide with an API path by accident.
 */
export function registerPreviewGateway(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const slot = previewPortForHost(request.headers.host);
    if (slot === null) return;
    await servePreview(request, reply, slot);
  });
}

export function registerPortsRoutes(app: FastifyInstance): void {
  const readGuards = [authenticate, requirePermission('ports:read')];
  const forwardGuards = [authenticate, requirePermission('ports:forward')];

  app.get('/api/ports', { preHandler: readGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const query = parseOrThrow(portsQuerySchema, request.query, 'ports query');
    const agentId = requireConnectedAgent(query.agentId);

    const list = await hostListPorts(agentId, principal.user.id);
    const previews = await listPreviewsForUser(principal.user.id);

    const body: PortsResponse = { ...list, preview: previewCapability(), previews };
    return { data: body };
  });

  app.post('/api/ports/preview', { preHandler: forwardGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseOrThrow(previewBodySchema, request.body, 'preview request');
    const agentId = requireConnectedAgent(body.agentId);

    // Refused before anything is reserved, and in the same words the Ports app
    // shows. A reservation made for an address that cannot work would be worse
    // than none: it would occupy one of the slots and hand back a URL that loads
    // nothing, with nothing on screen to say why.
    const capability = previewCapability();
    if (!capability.enabled) {
      throw new ServiceUnavailableError(capability.reason ?? 'Port previews are unavailable');
    }

    // The port is proved reachable before anything is reserved for it. Opening
    // the tunnel is the connection, so a server that is not listening — or that
    // is listening somewhere the agent cannot reach — is reported here, where
    // the answer can say so, rather than as a blank window a minute later.
    const probe = await openHostTunnel(agentId, principal.user.id, {
      port: body.port,
      ...(body.host !== undefined ? { host: body.host } : {}),
    });
    await probe.close();

    const { slot, preview } = await reservePreview(principal.user.id, agentId, body.port);
    const token = issuePreviewToken(principal.user.id, slot);

    await recordAuditEvent({
      action: 'port.preview.opened',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: `${agentId}:${body.port}`,
      metadata: { origin: preview.origin },
    });

    return reply
      .header('set-cookie', previewCookie(slot, token.token, token.expiresInSeconds))
      .send({ data: preview });
  });

  app.delete('/api/ports/preview', { preHandler: forwardGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseOrThrow(releasePreviewQuerySchema, request.query, 'preview query');
    const agentId = requireConnectedAgent(query.agentId);

    const slot = await releasePreview(principal.user.id, agentId, query.port);

    // No reservation belongs to this user for this port, so there is nothing to
    // close and nothing to clear: the cookie from an expired preview names an
    // address that no longer resolves to anything, which is already the state
    // the caller asked for.
    if (slot === null) return { data: { released: false } };

    await recordAuditEvent({
      action: 'port.preview.closed',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: `${agentId}:${query.port}`,
      metadata: {},
    });

    // The reservation is gone, so its cookie is cleared rather than left to
    // expire: a preview the user has stopped must not keep working because some
    // tab still holds it open.
    return reply.header('set-cookie', clearPreviewCookie(slot)).send({
      data: { released: true, port: query.port },
    });
  });
}

/**
 * Resolves an agent id, insisting it names an agent this replica can reach.
 */
function requireConnectedAgent(agentId: string): string {
  if (!isAgentRpcConnected(agentId)) {
    throw new ServiceUnavailableError('The selected host agent is not connected');
  }
  return agentId;
}

/**
 * Serves one request from a preview address.
 *
 * The response is written by hand from here on. Fastify's usual path stamps its
 * own headers onto everything it sends, and two of them are wrong for a
 * proxied page: a content security policy of `frame-ancestors 'none'` would stop
 * the desktop framing it, and the reply helpers have no way to pass a dev
 * server's status line and headers through unchanged. So the reply is hijacked
 * and the bytes are relayed directly.
 */
async function servePreview(
  request: FastifyRequest,
  reply: FastifyReply,
  slot: number
): Promise<void> {
  // `hijack()` returns the reply, and a reply is thenable — that is what lets a
  // handler `return reply` and have Fastify await the response. Nothing is
  // awaited here: the reply is taken over and every byte is written by hand
  // below, so the value is discarded deliberately.
  void reply.hijack();

  let reservation;
  try {
    reservation = await authorizePreviewRequest(slot, request.headers.cookie);
  } catch (error) {
    writeMessage(reply, errorStatus(error), errorText(error));
    return;
  }

  let transport;
  try {
    transport = await openHostTunnel(reservation.agentId, reservation.userId, {
      port: reservation.port,
    });
  } catch (error) {
    writeMessage(
      reply,
      502,
      `Aether could not connect to port ${reservation.port} on the host. ${errorText(error)}`
    );
    return;
  }

  let bridge;
  try {
    bridge = await bridgeTunnel(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    writeMessage(reply, 503, errorText(error));
    return;
  }

  try {
    await relay(request, reply, bridge.port, reservation.port);
  } finally {
    bridge.close();
  }
}

/**
 * Pipes one request to the dev server and its answer back.
 *
 * The body is forwarded only for methods that carry one, and by piping the
 * request stream rather than buffering it: nothing here needs to look at the
 * bytes, and buffering would put an upload into this process's memory.
 */
function relay(
  request: FastifyRequest,
  reply: FastifyReply,
  bridgePort: number,
  targetPort: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    // A WebSocket handshake is an HTTP request that ends in a change of
    // protocol: after the 101 the connection carries opaque bytes, which is
    // exactly what a preview is — a pipe to a server on the host. Relaying it is
    // what makes a dev server's hot reload work, and hot reload is most of the
    // reason to run a project here rather than in an editor.
    const upgrading = request.headers.upgrade !== undefined;

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'host') continue;
      headers[lower] = value;
    }

    // A dev server checks the host it is asked for and refuses anything but
    // localhost unless it has been told otherwise — Vite and webpack both do,
    // and with the preview address it would refuse every request. So the
    // upstream sees localhost, and the address the request really arrived on
    // travels beside it for anything that needs to build an absolute URL.
    headers.host = `localhost:${targetPort}`;
    headers['x-forwarded-host'] = request.headers.host ?? headers.host;
    headers['x-forwarded-proto'] = config.isHttps ? 'https' : 'http';
    headers['x-forwarded-for'] = request.ip;

    if (upgrading) {
      // The handshake's own headers have to survive the hop-by-hop filter
      // above: Node's HTTP client reports a protocol switch only when the
      // request it sent asked for one.
      headers.connection = 'upgrade';
      headers.upgrade = request.headers.upgrade ?? 'websocket';
    } else {
      // One request, one connection. The tunnel carries a single connection to
      // the dev server, and leaving it open after the response would keep a
      // socket and a tunnel slot per idle browser tab.
      headers.connection = 'close';
    }

    const upstream = http.request({
      host: '127.0.0.1',
      port: bridgePort,
      method: request.method,
      path: request.raw.url ?? '/',
      headers,
      // The bridge listens on loopback; there is no proxy to traverse and no
      // pool worth keeping.
      agent: false,
    });

    let settled = false;
    /** True once the connection has stopped being HTTP and become a byte pipe. */
    let switched = false;
    /** True once the dev server's response has been handed to the client socket. */
    let responded = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`the server on port ${targetPort} did not answer in time`));
    });

    upstream.on('upgrade', (response, socket, head) => {
      switched = true;

      // The socket now belongs to the relayed protocol. The response timeout was
      // set for an HTTP answer and would kill a session that is simply idle
      // between frames, which is the normal state of a socket.
      socket.setTimeout(0);

      const client = request.raw.socket;
      if (client === undefined || client.destroyed) {
        socket.destroy();
        finish();
        return;
      }

      // Written by hand, because a 101 is not a response this process composes:
      // it is the dev server's status line and headers, passed through as they
      // arrived — and the `Connection: Upgrade` that makes it a handshake is
      // one of the headers the usual path strips.
      const status = response.statusCode ?? 101;
      const lines = [
        `HTTP/1.1 ${status} ${response.statusMessage ?? 'Switching Protocols'}`,
        ...headerLines(relayedHeaders(response.headers, true)),
        '',
        '',
      ];
      client.write(lines.join('\r\n'));

      // Whatever the dev server sent in the same packet as its handshake.
      if (head.length > 0) client.write(head);

      client.pipe(socket);
      socket.pipe(client);

      // Either end closing ends the other, and only then is the relay over.
      // Resolving earlier would have `servePreview` close the bridge — and the
      // tunnel with it — under a connection that is still carrying traffic, and
      // a hot-reload socket is idle between frames far more often than it is
      // busy. `finish` is idempotent, so whichever side goes first wins.
      client.on('close', () => {
        socket.destroy();
        finish();
      });
      client.on('error', () => {
        socket.destroy();
        finish();
      });
      socket.on('close', () => {
        client.destroy();
        finish();
      });
      socket.on('error', () => {
        client.destroy();
        finish();
      });
    });

    upstream.on('response', (response) => {
      const out = reply.raw;
      if (out.headersSent || out.destroyed) {
        response.destroy();
        finish();
        return;
      }

      // From here the client is committed to this response, and nothing may
      // write a second one over it — see the error handler below.
      responded = true;

      out.writeHead(response.statusCode ?? 502, relayedHeaders(response.headers));
      response.pipe(out);
      response.on('end', finish);
      response.on('error', finish);
      out.on('close', () => {
        response.destroy();
        finish();
      });
    });

    upstream.on('error', (error: Error) => {
      // Only while the client has been told nothing. After a switch the
      // connection is a byte pipe, and an HTTP error status written into it
      // would be read as protocol data by the other end. After a response has
      // begun, the body is already streaming to the browser and `writeMessage`
      // could only cut the connection mid-flush — which is a truncated page
      // rather than an error, and a worse answer than finishing what was
      // started. The likeliest error of all is this one: the bridge and its
      // tunnel are closed as soon as the response ends, so the last few bytes
      // routinely arrive over a socket that is already going away.
      if (!switched && !responded) {
        writeMessage(
          reply,
          502,
          `The preview could not reach port ${targetPort} on the host: ${error.message}`
        );
      }
      finish();
    });

    if (request.method === 'GET' || request.method === 'HEAD') {
      // A handshake leaves a question about the bytes a client sends in the same
      // packet as its upgrade request: Node hands those to the server's upgrade
      // event rather than to the request stream, so what can be read here is
      // whatever also made it into the stream and nothing more. A client that
      // waits for the 101 before sending its first frame — every browser — has
      // none to lose.
      if (upgrading) {
        const buffered: unknown = request.raw.read();
        if (Buffer.isBuffer(buffered)) upstream.write(buffered);
      }
      upstream.end();
    } else {
      request.raw.pipe(upstream);
    }
  });
}

/**
 * The dev server's headers, as far as they can be passed through untouched.
 *
 * Three are not. The hop-by-hop set describes the connection being closed here,
 * not the response. `X-Frame-Options` and a `frame-ancestors` directive are
 * written for an app that owns its own tab, and both would refuse the frame the
 * desktop is about to present — so the app's policy is kept and the
 * frame-ancestors directive is rewritten to name the desktop, which preserves
 * every protection the app asked for except clickjacking by Aether itself.
 *
 * `keepUpgrade` is for a 101, where the hop-by-hop headers are not describing a
 * connection that is about to be closed — they are the handshake, and dropping
 * `Connection: Upgrade` would leave the client with a switched protocol it was
 * never told about.
 */
function relayedHeaders(
  headers: http.IncomingHttpHeaders,
  keepUpgrade = false
): Record<string, string | string[]> {
  // Deliberately not `OutgoingHttpHeaders`: that type declares a narrower type
  // for the headers it knows by name, which would refuse the array forms a
  // `set-cookie` and a repeated header legitimately take.
  const out: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') continue;

    // The handshake headers are the exception, and only for a 101: there they
    // describe the protocol being switched to rather than a connection that is
    // about to close.
    const handshake = keepUpgrade && (lower === 'connection' || lower === 'upgrade');
    if (HOP_BY_HOP.has(lower) && !handshake) continue;

    if (lower === 'set-cookie') {
      // A preview credential must not be overwritable by the page it unlocks.
      const kept = (Array.isArray(value) ? value : [value]).filter(
        (cookie) => !cookie.startsWith('aether_preview_')
      );
      if (kept.length > 0) out['set-cookie'] = kept;
      continue;
    }

    if (lower === 'content-security-policy') {
      out[lower] = Array.isArray(value) ? value.map(withFrameAncestors) : withFrameAncestors(value);
      continue;
    }

    out[lower] = value;
  }

  return out;
}

/** Headers as wire lines, one per value so a repeated header stays repeated. */
function headerLines(headers: Record<string, string | string[]>): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const one of value) lines.push(`${name}: ${one}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return lines;
}

/** `frame-ancestors` naming this desktop, replacing whatever the app declared. */
function withFrameAncestors(policy: string): string {
  const without = policy.replace(/(^|;)\s*frame-ancestors[^;]*/gi, '').replace(/^;+/, '');
  const trimmed = without.trim();
  const directive = `frame-ancestors ${desktopOrigin()}`;
  if (trimmed.length === 0) return directive;
  return `${trimmed.replace(/;+$/, '')}; ${directive}`;
}

function errorStatus(error: unknown): number {
  return error instanceof AppError ? error.statusCode : 502;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The preview failed';
}

/**
 * Writes a short plain-text body.
 *
 * Plain text rather than a page: this is shown inside the desktop's own window,
 * next to the Ports app that explains the same thing, and a dressed-up error
 * page from the proxy would only be a second voice saying it.
 */
function writeMessage(reply: FastifyReply, status: number, message: string): void {
  const out = reply.raw;

  if (out.headersSent || out.destroyed) {
    // The response had already started, so there is no status line left to
    // correct. Cutting the connection is the honest signal that the rest of the
    // body is not coming.
    out.destroy();
    return;
  }

  const body = `${message}\n`;
  out.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  out.end(body);
}
