import { LIMITS, WS_CLOSE } from '@aether/shared';

import { markAgentConnected, markAgentDisconnected } from '../services/agent-connections.js';
import { dispatchAgentMessage } from '../services/agent-gateway.service.js';
import { authenticateAgent } from '../services/agent-pairing.service.js';
import {
  handleAgentFrame,
  registerAgentSocket,
  unregisterAgentSocket,
} from '../services/agent-rpc.service.js';
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
export function registerAgentWebSocket(app: FastifyInstance): void {
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
      markAgentConnected(record.agentId);

      // Answer the handshake. The agent refuses to dispatch any request until
      // it has seen `hello_ack` (it would answer UNAUTHENTICATED and give up
      // after 15s), and the owner id it receives is the principal its terminal
      // sessions are keyed on. Nothing else in the backend sends this frame —
      // the gateway deliberately drops `hello` — so without it the agent
      // reconnects forever and every capability call fails.
      // The agent validates `ownerUserId` as a UUID, so a local (instance-scoped)
      // agent is given its own agent id — also a UUID, and stable across
      // reconnects. The gateway's `agent:<id>` form is a backend-side principal
      // for terminal ownership and must not be sent here.
      const ownerUserId = record.ownerUserId ?? record.agentId;
      try {
        socket.send(
          JSON.stringify({
            id: '__hello__',
            type: 'hello_ack',
            ok: true,
            agentId: record.agentId,
            ownerUserId,
          })
        );
      } catch (error) {
        log.warn({ err: error, agentId: record.agentId }, 'failed to send hello acknowledgement');
        socket.close(WS_CLOSE.INTERNAL_ERROR, 'Handshake failed');
        return;
      }

      // The agent is now reachable for backend-originated RPC (host-scope files
      // and terminals). This makes the socket addressable by agent id.
      registerAgentSocket(record.agentId, socket);

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

        // Replies to backend-originated requests and streamed terminal events are
        // consumed by the RPC client; only genuine agent→backend frames continue
        // on to the gateway that runs them against this backend's own resources.
        let frame: Record<string, unknown> | null = null;
        try {
          frame = JSON.parse(text) as Record<string, unknown>;
        } catch {
          frame = null;
        }
        if (frame !== null && handleAgentFrame(record.agentId, frame)) {
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
        markAgentDisconnected(record.agentId);
        unregisterAgentSocket(record.agentId, socket);
        log.info({ agentId: record.agentId }, 'agent disconnected');
      });

      socket.on('error', (error: Error) => {
        log.warn({ err: error, agentId: record.agentId }, 'agent websocket error');
      });

      log.debug({ agentId: record.agentId }, 'agent websocket attached');
    })();
  });
}
