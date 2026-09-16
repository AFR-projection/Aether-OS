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
import { PayloadTooLargeError, PathRejectedError } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance } from 'fastify';

/**
 * Filesystem API.
 *
 * Every path in this module is workspace-relative. The route layer validates
 * the *shape*; `security/workspace` performs the authoritative containment
 * check against the realpath of the workspace root before anything touches
 * disk.
 */
export function registerFilesRoutes(app: FastifyInstance): void {
  const readGuards = [authenticate, requirePermission('files:read')];
  const writeGuards = [authenticate, requirePermission('files:write')];
  const deleteGuards = [authenticate, requirePermission('files:delete')];

  app.get('/api/files/list', { preHandler: readGuards }, async (request) => {
    const query = parseOrThrow(listDirectoryQuerySchema, request.query, 'directory query');
    const listing = await listDirectory({ relative: query.path, showHidden: query.showHidden });
    return { data: listing };
  });

  app.get('/api/files/stat', { preHandler: readGuards }, async (request) => {
    const query = parseOrThrow(
      readFileQuerySchema.pick({ path: true }),
      request.query,
      'stat query'
    );
    return { data: await statPath(query.path) };
  });

  app.get('/api/files/read', { preHandler: readGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const query = parseOrThrow(readFileQuerySchema, request.query, 'read query');
    const result = await readFile(query.path, query.encoding);

    await recordAuditEvent({
      action: 'file.read',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: query.path,
      metadata: { size: result.size, truncated: result.truncated },
    });

    return { data: result };
  });

  app.get('/api/files/download', { preHandler: readGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseOrThrow(downloadQuerySchema, request.query, 'download query');
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
    const body = parseOrThrow(writeFileBodySchema, request.body, 'write request');

    const entry = await writeFile({
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
      metadata: { bytes: Buffer.byteLength(body.content, 'utf8') },
    });

    return { data: entry };
  });

  app.post('/api/files/mkdir', { preHandler: writeGuards }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseOrThrow(mkdirBodySchema, request.body, 'mkdir request');

    const entry = await createDirectory(body.path, body.recursive);

    await recordAuditEvent({
      action: 'file.written',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.path,
      metadata: { operation: 'mkdir', recursive: body.recursive },
    });

    return reply.status(201).send({ data: entry });
  });

  app.post('/api/files/rename', { preHandler: writeGuards }, async (request) => {
    const principal = requirePrincipal(request);
    const body = parseOrThrow(renameBodySchema, request.body, 'rename request');

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
    const body = parseOrThrow(deleteBodySchema, request.body, 'delete request');

    await deletePath(body.path, body.recursive);

    await recordAuditEvent({
      action: 'file.deleted',
      outcome: 'success',
      actorUserId: principal.user.id,
      actorUsername: principal.user.username,
      sessionId: principal.sessionId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      target: body.path,
      metadata: { recursive: body.recursive },
    });

    return reply.status(204).send();
  });

  app.get('/api/files/search', { preHandler: readGuards }, async (request) => {
    const query = parseOrThrow(searchQuerySchema, request.query, 'search query');
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
    const query = parseOrThrow(uploadQuerySchema, request.query, 'upload query');

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
