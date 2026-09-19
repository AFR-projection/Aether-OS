import {
  deleteBodySchema,
  downloadQuerySchema,
  listDirectoryQuerySchema,
  mkdirBodySchema,
  readFileQuerySchema,
  renameBodySchema,
  searchQuerySchema,
  uploadQuerySchema,
  writeFileBodySchema,
} from '@aether/shared';

import { config } from '../config.js';
import { authenticate, requirePermission, requirePrincipal } from '../middleware/auth.js';
import {
  hostCreateDirectory,
  hostDeletePath,
  hostListDirectory,
  hostReadFile,
  hostWriteFile,
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
import { parseOrThrow } from '../utils/validate.js';

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
    if (scope.scope === 'host') {
      throw new NotImplementedError('Downloading from a host agent is not available yet');
    }
    const query = parseOrThrow(downloadQuerySchema, rest, 'download query');
    const { stream, size, name } = await openReadStream(query.path);

    await recordAuditEvent({
      action: 'file.downloaded',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: query.path,
      metadata: { size },
    });

    // `filename` is passed through encodeURIComponent so a name containing a
    // quote or newline cannot break out of the header value.
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(size))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(stream);
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
    if (scope.scope === 'host') {
      throw new NotImplementedError('Renaming on a host agent is not available yet');
    }
    const body = parseOrThrow(renameBodySchema, rest, 'rename request');

    const entry = await renamePath({ from: body.from, to: body.to, overwrite: body.overwrite });

    await recordAuditEvent({
      action: 'file.renamed',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.from,
      metadata: { to: body.to, overwrite: body.overwrite },
    });

    return { data: entry };
  });

  app.post('/api/files/delete', { preHandler: deleteGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { scope, rest } = readScope(request.body);
    const body = parseOrThrow(deleteBodySchema, rest, 'delete request');

    if (scope.scope === 'host') {
      await hostDeletePath(requireAgent(scope), body.path);
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
    if (scope.scope === 'host') {
      throw new NotImplementedError('Uploading to a host agent is not available yet');
    }
    const query = parseOrThrow(uploadQuerySchema, rest, 'upload query');

    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') {
      throw new PathRejectedError('Uploads must use Content-Type: application/octet-stream');
    }

    if (!request.raw.readable) {
      throw new PayloadTooLargeError('Request body could not be read');
    }

    const entry = await streamToFile(query.path, query.name, request.raw, config.MAX_FILE_SIZE);

    await recordAuditEvent({
      action: 'file.uploaded',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: entry.path,
      metadata: { size: entry.size },
    });

    return reply.status(201).send({ data: entry });
  });
}
