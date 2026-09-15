import { LIMITS, WS_CLOSE } from '@aether/shared';

import { authenticateAgent } from '../services/agent-pairing.service.js';
import { dispatchAgentMessage } from '../services/agent-gateway.service.js';
import { subsystemLogger } from '../utils/logger.js';

import type { FastifyInstance } from 'fastify';

const log = subsystemLogger('agent-ws');

const MAX_FRAMES_PER_SECOND = 200;

/**
 * WebSocket endpoint for host agents (`/ws/agent?agentId=…&token=…`).
 *
 * This is the pairing-aware sibling of the browser terminal socket. Agents
 * authenticate with the pre-shared pairing token issued at install time — not
 * with a user JWT — and then exchange the JSON request/reply protocol defined
 * in `@aether/host-agent` (`protocol.ts`). Every message is validated there
 * before it reaches a capability, so a compromised agent can only invoke the
 * capability surface, never raw shell.
 */
export async function registerAgentWebSocket(app: FastifyInstance): Promise<void> {
  app.get('/ws/agent', { websocket: true }, (socket, request) => {
    const query = request.query as { agentId?: string; token?: string };
    const agentId = query.agentId;
    const token = query.token;

    if (!agentId || !token) {
      socket.close(WS_CLOSE.UNAUTHENTICATED, 'Missing agent credentials');
      return;
    }

    void (async () => {
      let record;
      try {
        record = await authenticateAgent(agentId, token);
      } catch (error) {
        log.warn({ err: error, agentId }, 'agent authentication rejected');
        socket.close(WS_CLOSE.UNAUTHENTICATED, 'Invalid agent credentials');
        return;
      }

      log.info({ agentId: record.agentId }, 'agent connected');

      const frameBudget = { count: 0, windowStart: Date.now() };

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const now = Date.now();
        if (now - frameBudget.windowStart >= 1_000) {
          frameBudget.windowStart = now;
          frameBudget.count = 0;
        }
        frameBudget.count += 1;

        if (frameBudget.count > MAX_FRAMES_PER_SECOND) {
          socket.close(WS_CLOSE.RATE_LIMITED, 'Rate limited');
          return;
        }

        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');

        if (Buffer.byteLength(text, 'utf8') > LIMITS.WS_MESSAGE_MAX_BYTES) {
          socket.close(WS_CLOSE.POLICY_VIOLATION, 'Message too large');
          return;
        }

        void dispatchAgentMessage(record, text)
          .then((reply) => {
            if (reply !== null && socket.readyState === socket.OPEN) {
              try {
                socket.send(reply);
              } catch (error) {
                log.debug({ err: error }, 'failed to send agent reply');
              }
            }
          })
          .catch((error) => {
            log.warn({ err: error, agentId: record.agentId }, 'agent message rejected');
          });
      });

      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        try {
          socket.ping();
        } catch (error) {
          log.debug({ err: error }, 'agent heartbeat failed');
        }
      }, 30_000);
      heartbeat.unref();

      socket.on('close', () => {
        clearInterval(heartbeat);
        log.info({ agentId: record.agentId }, 'agent disconnected');
      });

      socket.on('error', (error: Error) => {
        log.warn({ err: error, agentId: record.agentId }, 'agent websocket error');
      });

      log.debug({ agentId: record.agentId }, 'agent websocket attached');
    })();
  });
}
