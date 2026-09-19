import { PassThrough, type Readable } from 'node:stream';

import {
  deleteBodySchema,
  downloadQuerySchema,
  listDirectoryQuerySchema,
  mediaTicketBodySchema,
  mkdirBodySchema,
  rawQuerySchema,
  readFileQuerySchema,
  renameBodySchema,
  searchQuerySchema,
  uploadQuerySchema,
  writeFileBodySchema,
} from '@aether/shared';

import { config } from '../config.js';
import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import { issueMediaTicket, redeemMediaTicket } from '../security/media-ticket.js';
import {
  hostCreateDirectory,
  hostDeletePath,
  hostListDirectory,
  hostOpenRange,
  hostProbeFile,
  hostReadFile,
  hostRenamePath,
  hostWriteFile,
  hostWriteStream,
} from '../services/agent-files.service.js';
import { isAgentRpcConnected } from '../services/agent-rpc.service.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  createDirectory,
  deletePath,
  listDirectory,
  openReadStream,
  readFile,
  renamePath,
  searchEntries,
  statForServing,
  statPath,
  streamToFile,
  writeFile,
} from '../services/files.service.js';
import {
  NotImplementedError,
  PayloadTooLargeError,
  PathRejectedError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/errors.js';
import { parseRange } from '../utils/range.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FileEntry } from '@aether/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Filesystem API.
 *
 * Every request carries an optional scope. In the default *workspace* scope the
 * path is workspace-relative and served from this backend's own sandbox. In
 * *host* scope (`scope=host&agentId=…`) the operation is proxied to a connected
 * host agent and runs against the real machine the agent is on — this is what
 * lets the desktop manage the actual VPS filesystem, not the container's.
 *
 * The route layer validates the *shape*; `security/workspace` (workspace scope)
 * or the agent's own containment check (host scope) performs the authoritative
 * path check before anything touches disk. Host scope only exposes what the
 * agent protocol implements: list, read, write, mkdir, delete.
 */

interface RequestScope {
  scope: 'workspace' | 'host';
  agentId: string | null;
}

/** Splits `scope`/`agentId` off a query or body so the strict schema sees only its own fields. */
function readScope(source: unknown): { scope: RequestScope; rest: Record<string, unknown> } {
  const record = (typeof source === 'object' && source !== null ? source : {}) as Record<
    string,
    unknown
  >;
  const { scope: scopeRaw, agentId: agentIdRaw, ...rest } = record;
  const scope = scopeRaw === 'host' ? 'host' : 'workspace';
  const agentId = typeof agentIdRaw === 'string' && agentIdRaw.length > 0 ? agentIdRaw : null;
  return { scope: { scope, agentId }, rest };
}

/** Resolves the target agent id for a host-scope request, or fails with a clear reason. */
function requireAgent(scope: RequestScope): string {
  if (scope.scope !== 'host' || scope.agentId === null) {
    throw new ValidationError('A host agent id is required for host-scope operations');
  }
  if (!isAgentRpcConnected(scope.agentId)) {
    throw new ServiceUnavailableError('The selected host agent is not connected');
  }
  return scope.agentId;
}

export function registerFilesRoutes(app: FastifyInstance): void {
  const readGuards = [authenticate, requirePermission('files:read')];
  const writeGuards = [authenticate, requirePermission('files:write')];
  const deleteGuards = [authenticate, requirePermission('files:delete')];

  app.get('/api/files/list', { preHandler: readGuards }, async (request) => {
    const { scope, rest } = readScope(request.query);
    const query = parseOrThrow(listDirectoryQuerySchema, rest, 'directory query');
    const listing =
      scope.scope === 'host'
        ? await hostListDirectory(requireAgent(scope), query.path, query.showHidden)
        : await listDirectory({ relative: query.path, showHidden: query.showHidden });
    return { data: listing };
  });

  app.get('/api/files/stat', { preHandler: readGuards }, async (request) => {
    // Stat has no host-scope proxy yet; the field is stripped so a stray scope
    // parameter cannot break the strict schema, then workspace stat runs.
    const { rest } = readScope(request.query);
    const query = parseOrThrow(readFileQuerySchema.pick({ path: true }), rest, 'stat query');
    return { data: await statPath(query.path) };
  });

  app.get('/api/files/read', { preHandler: readGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.query);
    const query = parseOrThrow(readFileQuerySchema, rest, 'read query');
    const result =
      scope.scope === 'host'
        ? await hostReadFile(requireAgent(scope), query.path)
        : await readFile(query.path, query.encoding);

    await recordAuditEvent({
      action: 'file.read',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: query.path,
      metadata: { size: result.size, truncated: result.truncated, scope: scope.scope },
    });

    return { data: result };
  });

  app.get('/api/files/download', { preHandler: readGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.query);
    const query = parseOrThrow(downloadQuerySchema, rest, 'download query');

    const agentId = scope.scope === 'host' ? requireAgent(scope) : null;
    const probed =
      agentId === null
        ? await statForServing(query.path)
        : await hostProbeFile(agentId, query.path);

    await recordAuditEvent({
      action: 'file.downloaded',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: query.path,
      metadata: { size: probed.size, scope: scope.scope },
    });

    const body =
      agentId === null
        ? (await openReadStream(query.path)).stream
        : hostOpenRange(agentId, query.path, { start: 0, end: probed.size - 1 });

    // `filename` is passed through encodeURIComponent so a name containing a
    // quote or newline cannot break out of the header value.
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(probed.size))
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(probed.name)}`
      )
      .send(body);
  });

  app.post('/api/files/write', { preHandler: writeGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body);
    const body = parseOrThrow(writeFileBodySchema, rest, 'write request');

    const entry =
      scope.scope === 'host'
        ? await hostWriteFile(requireAgent(scope), {
            relative: body.path,
            content: body.content,
            encoding: body.encoding,
            createOnly: body.createOnly,
          })
        : await writeFile({
            relative: body.path,
            content: body.content,
            encoding: body.encoding,
            createOnly: body.createOnly,
          });

    await recordAuditEvent({
      action: 'file.written',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.path,
      metadata: { bytes: Buffer.byteLength(body.content, 'utf8'), scope: scope.scope },
    });

    return { data: entry };
  });

  app.post('/api/files/mkdir', { preHandler: writeGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body);
    const body = parseOrThrow(mkdirBodySchema, rest, 'mkdir request');

    const entry =
      scope.scope === 'host'
        ? await hostCreateDirectory(requireAgent(scope), body.path)
        : await createDirectory(body.path, body.recursive);

    await recordAuditEvent({
      action: 'file.written',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.path,
      metadata: { operation: 'mkdir', recursive: body.recursive, scope: scope.scope },
    });

    return reply.status(201).send({ data: entry });
  });

  app.post('/api/files/rename', { preHandler: writeGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body);
    const body = parseOrThrow(renameBodySchema, rest, 'rename request');

    const entry =
      scope.scope === 'host'
        ? await hostRenamePath(requireAgent(scope), {
            from: body.from,
            to: body.to,
            overwrite: body.overwrite,
          })
        : await renamePath({ from: body.from, to: body.to, overwrite: body.overwrite });

    await recordAuditEvent({
      action: 'file.renamed',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.from,
      metadata: { to: body.to, overwrite: body.overwrite, scope: scope.scope },
    });

    return { data: entry };
  });

  app.post('/api/files/delete', { preHandler: deleteGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body);
    const body = parseOrThrow(deleteBodySchema, rest, 'delete request');

    if (scope.scope === 'host') {
      await hostDeletePath(requireAgent(scope), body.path, body.recursive);
    } else {
      await deletePath(body.path, body.recursive);
    }

    await recordAuditEvent({
      action: 'file.deleted',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.path,
      metadata: { recursive: body.recursive, scope: scope.scope },
    });

    return reply.status(204).send();
  });

  app.get('/api/files/search', { preHandler: readGuards }, async (request) => {
    const { scope, rest } = readScope(request.query);
    if (scope.scope === 'host') {
      throw new NotImplementedError('Search is not available on host agents yet');
    }
    const query = parseOrThrow(searchQuerySchema, rest, 'search query');
    const results = await searchEntries({
      relative: query.path,
      query: query.query,
      limit: query.limit,
    });
    return { data: { results, total: results.length } };
  });

  /**
   * Streaming upload.
   *
   * The body is `application/octet-stream` and is piped straight to disk. A
   * multipart parser is deliberately not used: one file per request keeps the
   * dependency surface small and makes the size limit a single, auditable
   * check. The target directory and file name travel as query parameters.
   */
  app.post('/api/files/upload', { preHandler: writeGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.query);
    const query = parseOrThrow(uploadQuerySchema, rest, 'upload query');

    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') {
      throw new PathRejectedError('Uploads must use Content-Type: application/octet-stream');
    }

    if (!request.raw.readable) {
      throw new PayloadTooLargeError('Request body could not be read');
    }

    const relative = query.path === '' ? query.name : `${query.path}/${query.name}`;
    const entry =
      scope.scope === 'host'
        ? await uploadToHost(requireAgent(scope), relative, request.raw)
        : await streamToFile(query.path, query.name, request.raw, config.MAX_FILE_SIZE);

    await recordAuditEvent({
      action: 'file.uploaded',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: entry.path,
      metadata: { size: entry.size, scope: scope.scope },
    });

    return reply.status(201).send({ data: entry });
  });

  /**
   * Issues a ticket for the byte-serving endpoint.
   *
   * Requested over an authenticated call, then used as a plain query parameter
   * by an `<img>`/`<video>`/`<audio>` element that cannot set headers. The
   * ticket names the scope and the exact path, so it opens one file for ten
   * minutes and nothing else.
   */
  app.post('/api/files/media-ticket', { preHandler: readGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const body = parseOrThrow(mediaTicketBodySchema, request.body, 'media ticket request');

    const agentId =
      body.scope === 'host' ? requireAgent({ scope: 'host', agentId: body.agentId ?? null }) : null;

    return {
      data: await issueMediaTicket({
        userId: principal.user.id,
        scope: body.scope,
        agentId,
        path: body.path,
      }),
    };
  });

  /**
   * Serves file bytes, with `Range` support, for elements that fetch their own
   * source.
   *
   * The whole point is that a video element can open this URL directly and seek
   * inside it: the requested range is answered with `206` and exactly those
   * bytes, whether the file is on this container's disk or on a host agent
   * behind an RPC channel. The two scopes converge on one readable stream here,
   * so nothing downstream has to know which it got.
   */
  app.get('/api/files/raw', async (request, reply) => {
    // The scope fields are read off the query and re-derived from the validated
    // ticket binding below, so the raw `scope` here is intentionally unused.
    const { rest } = readScope(request.query);
    const query = parseOrThrow(rawQuerySchema, rest, 'raw query');

    const agentId =
      query.scope === 'host'
        ? requireAgent({ scope: 'host', agentId: query.agentId ?? null })
        : null;

    await redeemMediaTicket(query.ticket, {
      scope: query.scope,
      agentId,
      path: query.path,
    });

    const probed =
      agentId === null
        ? await statForServing(query.path)
        : await hostProbeFile(agentId, query.path);

    const disposition = query.download
      ? `attachment; filename*=UTF-8''${encodeURIComponent(probed.name)}`
      : 'inline';

    const headers = {
      'Content-Type': probed.mimeType,
      'Content-Disposition': disposition,
      // Advertised so a media element knows seeking is available before it
      // tries; without it some players will not offer a scrub bar at all.
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
    };

    if (request.method === 'HEAD') {
      return reply.headers({ ...headers, 'Content-Length': String(probed.size) }).send();
    }

    const parsed = parseRange(request.headers.range, probed.size);

    if (parsed.kind === 'unsatisfiable') {
      return reply.status(416).header('Content-Range', `bytes */${probed.size}`).send();
    }

    if (parsed.kind === 'full') {
      const body =
        agentId === null
          ? (await openReadStream(query.path)).stream
          : hostOpenRange(agentId, query.path, { start: 0, end: probed.size - 1 });

      return reply.headers({ ...headers, 'Content-Length': String(probed.size) }).send(body);
    }

    const { start, end } = parsed.range;
    const body =
      agentId === null
        ? (await openReadStream(query.path, { start, end })).stream
        : hostOpenRange(agentId, query.path, { start, end });

    return reply
      .status(206)
      .headers({
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${probed.size}`,
        'Content-Length': String(end - start + 1),
      })
      .send(body);
  });
}

/**
 * Streams an upload body to a host agent, enforcing the same ceiling the
 * workspace path does.
 *
 * The bytes are counted as they pass rather than trusted from a `Content-Length`
 * header, because that header is caller-controlled. When the limit is crossed
 * the source is destroyed and the partial file is deleted on the agent, so a
 * refused upload leaves nothing behind — the same guarantee `streamToFile`
 * gives in workspace scope, arrived at over RPC instead of on disk.
 */
async function uploadToHost(
  agentId: string,
  relative: string,
  source: Readable
): Promise<FileEntry> {
  let written = 0;
  let overflowed = false;

  const counted = new PassThrough();

  source.on('data', (chunk: Buffer) => {
    written += chunk.length;
    if (written > config.MAX_FILE_SIZE) {
      overflowed = true;
      source.destroy(
        new PayloadTooLargeError('Upload exceeds the maximum file size', {
          limit: config.MAX_FILE_SIZE,
        })
      );
    }
  });

  // An error on the source has to reach the awaiting writer; otherwise an
  // aborted upload would hang here instead of failing the request.
  source.on('error', (error) => counted.destroy(error));
  source.pipe(counted);

  let entry: FileEntry;
  try {
    entry = await hostWriteStream(agentId, relative, counted);
  } catch (error) {
    if (overflowed) {
      await hostDeletePath(agentId, relative, false).catch(() => undefined);
    }
    throw error;
  }

  if (overflowed) {
    await hostDeletePath(agentId, relative, false).catch(() => undefined);
    throw new PayloadTooLargeError('Upload exceeds the maximum file size', {
      limit: config.MAX_FILE_SIZE,
    });
  }

  return entry;
}
