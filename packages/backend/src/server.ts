import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';

import { config } from './config.js';
import { registerAgentRoutes } from './routes/agent.routes.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import { registerAuthRoutes, registerUserRoutes } from './routes/auth.routes.js';
import { registerDesktopRoutes } from './routes/desktop.routes.js';
import { registerFilesRoutes } from './routes/files.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerPortsRoutes, registerPreviewGateway } from './routes/ports.routes.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerTerminalRoutes } from './routes/terminal.routes.js';
import { previewOrigins, previewPortForHost } from './security/preview.js';
import { isAppError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { registerAgentWebSocket } from './ws/agent.ws.js';
import { registerTerminalWebSocket } from './ws/terminal.ws.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Maximum size of a JSON request body. File uploads stream and are limited separately. */
const JSON_BODY_LIMIT_BYTES = 6 * 1024 * 1024;

export async function buildServer(): Promise<FastifyInstance> {
  // The logger type parameter is pinned to `FastifyBaseLogger` so the instance
  // built here has exactly the same type as the `FastifyInstance` that every
  // route module declares. Leaving it inferred would make the instance carry
  // the concrete pino generic and every `registerXRoutes(app)` call fail to
  // type-check against the default.
  const app = Fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    logger,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    // Only the configured number of proxies may set `X-Forwarded-*`. Trusting
    // this unconditionally would let a direct client spoof its own IP address
    // and evade the per-IP rate limits.
    trustProxy: config.TRUST_PROXY_HOPS,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The frontend is bundled; `unsafe-inline` is limited to styles because
        // xterm.js injects a style element for the terminal renderer.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...config.ALLOWED_ORIGINS],
        // A port preview is a different origin — same host, its own port — so
        // framing one is a cross-origin frame and has to be named here. The
        // origins are exactly the ones this instance serves previews from, not a
        // wildcard: nothing else may be framed into the desktop.
        frameSrc: ["'self'", ...previewOrigins()],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        // Only force HTTPS upgrade in HTTPS mode. In HTTP-only deployments
        // (--no-https or IP-only), this directive would break the frontend by
        // forcing browsers to request assets over HTTPS when the server only
        // listens on HTTP.
        ...(config.isHttps ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Bootstrap-Token'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      max: config.RATE_LIMIT_MAX_REQUESTS,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      // Per-IP buckets are capped so a distributed source cannot exhaust memory.
      cache: 20_000,
      // A preview is exempt, and has to be: one page load fetches a document and
      // every asset it references, which is exactly the burst this limit exists
      // to stop. The limit protects the API, not a dev server the user started
      // on their own machine and is the only one able to reach.
      allowList: (request) => previewPortForHost(request.headers.host) !== null,
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: () => ({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down.',
          statusCode: 429,
          timestamp: new Date().toISOString(),
        },
      }),
    });
  }

  // WebSocket support must be registered before any `{ websocket: true }` route.
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  /**
   * Raw passthrough for uploads.
   *
   * Registering this content type tells Fastify to hand the body stream to the
   * route untouched. The size limit is enforced by the upload handler while
   * writing, not by `bodyLimit`, because the body is never buffered.
   */
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  /**
   * Echo the request id back on every response.
   *
   * Fastify reads `x-request-id` from the incoming request but does not send it
   * back. Without this hook a client that supplies an id (as the installer and
   * the frontend do) has no way to correlate a successful response with the
   * server-side log line — only error bodies carry the id.
   */
  app.addHook('onSend', (request, reply, payload) => {
    void reply.header('x-request-id', request.id);
    return Promise.resolve(payload);
  });

  // Before any route: a request on a preview address is answered by the preview
  // gateway, whatever path it asks for, and must never reach the API router —
  // a previewed app's paths are its own, and one of them will eventually look
  // like an API path by accident.
  registerPreviewGateway(app);

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerFilesRoutes(app);
  registerTerminalRoutes(app);
  registerSystemRoutes(app);
  registerDesktopRoutes(app);
  registerAuditRoutes(app);
  registerPortsRoutes(app);
  registerAgentRoutes(app);
  registerTerminalWebSocket(app);
  registerAgentWebSocket(app);

  const servingFrontend = await registerStaticFrontend(app);

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      // Expected, already-classified failures: a 4xx is logged at warn level
      // without a stack trace, because it is a client problem, not a defect.
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'request failed');
      } else {
        request.log.warn({ code: error.code, path: request.url }, 'request rejected');
      }

      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          statusCode: error.statusCode,
          timestamp: new Date().toISOString(),
          requestId: request.id,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down.',
          statusCode: 429,
          timestamp: new Date().toISOString(),
          requestId: request.id,
        },
      });
    }

    if (statusCode >= 500) {
      // Unexpected: log everything, tell the client nothing.
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.warn({ err: error }, 'request error');
    }

    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: statusCode >= 500 ? 'Internal Server Error' : error.message,
        statusCode,
        timestamp: new Date().toISOString(),
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler(async (request, reply) => {
    // A request on a preview address was answered by the preview gateway on the
    // way in — it has no route, because the paths belong to the previewed app
    // rather than to this server. Sending a 404 body now would be an attempt to
    // write over a reply that is already on the wire, which Fastify reports as a
    // warning per request; a single page load would produce dozens.
    if (previewPortForHost(request.headers.host) !== null) return reply;

    // `reply.sendFile` only exists once `@fastify/static` is registered. Without
    // this guard an API-only deployment (no built frontend) would answer a
    // browser navigating to `/desktop` with a 500 instead of a 404.
    if (
      servingFrontend &&
      isSpaRoute(request.url) &&
      request.headers.accept?.includes('text/html')
    ) {
      return reply.type('text/html').sendFile('index.html');
    }

    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        statusCode: 404,
        timestamp: new Date().toISOString(),
        requestId: request.id,
        details: { path: request.url },
      },
    });
  });

  return app;
}

function isSpaRoute(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return (
    !pathname.startsWith('/api') && !pathname.startsWith('/ws') && !pathname.startsWith('/health')
  );
}

/**
 * Serves the built frontend when it is present.
 *
 * In development the Vite dev server serves the UI and proxies to this process,
 * so a missing directory is normal rather than an error.
 *
 * Returns whether the SPA fallback is available, so the not-found handler can
 * avoid calling `reply.sendFile` when `@fastify/static` was never registered.
 */
async function registerStaticFrontend(app: FastifyInstance): Promise<boolean> {
  if (!config.AETHER_STATIC_DIR) return false;

  const root = path.resolve(config.AETHER_STATIC_DIR);
  const indexFile = path.join(root, 'index.html');

  try {
    await access(indexFile);
    const stats = await stat(indexFile);
    if (!stats.isFile()) throw new Error('index.html is not a file');
  } catch {
    app.log.warn(
      { staticDir: root },
      'AETHER_STATIC_DIR is set but does not contain index.html; the API will run without serving the UI'
    );
    return false;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
    // Hashed asset filenames are immutable; `index.html` must never be cached
    // or a deploy would keep serving the previous bundle.
    setHeaders: (response, filePath) => {
      if (filePath.endsWith('index.html')) {
        void response.setHeader('Cache-Control', 'no-cache');
      } else {
        void response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.log.info({ staticDir: root }, 'serving frontend build');
  return true;
}
