import {
  LIMITS,
  terminalClientMessageSchema,
  WS_CLOSE,
  type TerminalServerMessage,
} from '@aether/shared';

import { config } from '../config.js';
import { redeemTicket } from '../security/ws-ticket.js';
import {
  attach,
  isTerminalAvailable,
  resizeSession,
  sendSignal,
  writeInput,
} from '../services/terminal.service.js';
import { subsystemLogger } from '../utils/logger.js';

import type { FastifyInstance } from 'fastify';

const log = subsystemLogger('terminal-ws');

/**
 * Per-connection rate limit for inbound terminal frames.
 *
 * A shell can legitimately generate a lot of input (paste, `yes`, arrow-key
 * repeats), so the ceiling is generous — it exists to stop a runaway client
 * from saturating the event loop, not to shape normal use.
 */
const MAX_FRAMES_PER_SECOND = 200;

export function registerTerminalWebSocket(app: FastifyInstance): void {
  app.get('/ws/terminal/:id', { websocket: true }, (socket, request) => {
    const params = request.params as { id?: string };
    const sessionId = params.id;

    if (!sessionId) {
      socket.close(WS_CLOSE.POLICY_VIOLATION, 'Missing session id');
      return;
    }

    if (!isTerminalAvailable()) {
      send(socket, {
        type: 'error',
        code: 'TERMINAL_UNAVAILABLE',
        message: 'Terminal support is not available on this host',
      });
      socket.close(WS_CLOSE.INTERNAL_ERROR, 'Terminal unavailable');
      return;
    }

    const query = request.query as { ticket?: string };
    const ticket = query.ticket;

    if (!ticket) {
      socket.close(WS_CLOSE.UNAUTHENTICATED, 'Missing ticket');
      return;
    }

    // The handshake is completed before the ticket is redeemed because
    // `@fastify/websocket` gives no pre-upgrade hook here. The socket stays
    // silent and is closed immediately if the ticket does not check out, so an
    // unauthenticated client learns nothing and can send no input.
    void (async () => {
      let userId: string;
      try {
        ({ userId } = await redeemTicket(ticket, sessionId));
      } catch (error) {
        log.warn({ err: error, sessionId }, 'websocket ticket rejected');
        socket.close(WS_CLOSE.UNAUTHENTICATED, 'Invalid ticket');
        return;
      }

      const frameBudget = { count: 0, windowStart: Date.now() };

      let unsubscribe: (() => void) | null = null;

      try {
        const attached = attach(sessionId, userId, (message) => send(socket, message));
        unsubscribe = attached.unsubscribe;

        send(socket, {
          type: 'ready',
          sessionId: attached.session.id,
          pid: attached.session.pid ?? 0,
          shell: attached.session.shell,
          cwd: attached.session.cwd,
        });

        // Rebuild the client's screen with output produced before it attached.
        for (const chunk of attached.replay) {
          send(socket, { type: 'output', data: chunk });
        }
      } catch (error) {
        log.warn({ err: error, sessionId }, 'websocket attach failed');
        send(socket, {
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Terminal session does not exist or has already exited',
        });
        socket.close(WS_CLOSE.SESSION_NOT_FOUND, 'Session not found');
        return;
      }

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const now = Date.now();
        if (now - frameBudget.windowStart >= 1_000) {
          frameBudget.windowStart = now;
          frameBudget.count = 0;
        }
        frameBudget.count += 1;

        if (frameBudget.count > MAX_FRAMES_PER_SECOND) {
          send(socket, {
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many terminal messages',
          });
          socket.close(WS_CLOSE.RATE_LIMITED, 'Rate limited');
          return;
        }

        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');

        if (Buffer.byteLength(text, 'utf8') > LIMITS.WS_MESSAGE_MAX_BYTES) {
          send(socket, { type: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Message too large' });
          socket.close(WS_CLOSE.POLICY_VIOLATION, 'Message too large');
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Malformed frames are dropped, never forwarded to the PTY.
          return;
        }

        const result = terminalClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          send(socket, {
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Unsupported terminal message',
          });
          return;
        }

        try {
          switch (result.data.type) {
            case 'input':
              writeInput(sessionId, userId, result.data.data);
              break;
            case 'resize':
              resizeSession(sessionId, userId, result.data.cols, result.data.rows);
              break;
            case 'signal':
              sendSignal(sessionId, userId, result.data.signal);
              break;
            case 'ping':
              send(socket, { type: 'pong', at: new Date().toISOString() });
              break;
          }
        } catch (error) {
          log.warn({ err: error, sessionId, type: result.data.type }, 'terminal frame rejected');
        }
      });

      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        send(socket, { type: 'pong', at: new Date().toISOString() });
      }, 30_000);
      heartbeat.unref();

      socket.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      socket.on('error', (error: Error) => {
        log.warn({ err: error, sessionId }, 'terminal websocket error');
        unsubscribe?.();
      });

      // Detaching does not kill the shell: a page reload should reconnect to a
      // live session, and the idle timer reclaims abandoned ones.
      log.debug(
        { sessionId, userId, idleTimeoutMs: config.TERMINAL_IDLE_TIMEOUT },
        'terminal websocket attached'
      );
    })();
  });

  /** Short-lived ticket endpoint used by the browser before opening a socket. */
}

function send(
  socket: { readyState: number; OPEN: number; send(data: string): void },
  message: TerminalServerMessage
): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    log.debug({ err: error }, 'failed to send websocket frame');
  }
}
