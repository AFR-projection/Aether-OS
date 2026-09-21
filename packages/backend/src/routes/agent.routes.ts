import { WS_CLOSE, type HostAgent } from '@aether/shared';
import { type FastifyInstance } from 'fastify';

import { authenticate, requirePrincipal, requirePermission } from '../middleware/auth.js';
import { agentConnectedAt, isAgentConnected } from '../services/agent-connections.js';
import { pairAgent, listAgents, revokeAgent } from '../services/agent-pairing.service.js';
import { closeAgentSocket } from '../services/agent-rpc.service.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('agent-routes');

/**
 * Agent management routes.
 *
 * `/api/agents` — list, pair (issue a token), and revoke paired agents.
 * Tokens are shown exactly once at pairing time; the backend stores only the
 * SHA-256 hash.
 */
export function registerAgentRoutes(app: FastifyInstance): void {
  /**
   * List paired agents (no secrets), with live connection state.
   *
   * Readable by every role, not just the ones that may pair a host. This is what
   * the Terminal, Files and Ports apps ask to find out which machine they are
   * working on, so gating it on `settings:manage` gave an operator a shell that
   * could not be pointed at anything. Pairing and revoking stay administrative:
   * the list carries no secret, and it is scoped to the caller's own agents.
   */
  app.get('/api/agents', {
    preHandler: [authenticate, requirePermission('agents:read')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const agents = await listAgents(principal.user.id);

      const data: HostAgent[] = agents.map((agent) => ({
        ...agent,
        connected: isAgentConnected(agent.agentId),
        connectedAt: agentConnectedAt(agent.agentId),
      }));

      return reply.send({ data });
    },
  });

  /** Pair a new agent — returns the token exactly once. */
  app.post('/api/agents/pair', {
    preHandler: [authenticate, requirePermission('settings:manage')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = request.body as { label?: string } | undefined;
      const label = body?.label?.trim() || `agent-${Date.now()}`;

      const result = await pairAgent({ label, ownerUserId: principal.user.id });

      void recordAuditEvent({
        action: 'agent.paired',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        target: result.agentId,
        metadata: { label },
      });

      log.info({ agentId: result.agentId }, 'agent paired via API');

      // The token is returned here and NEVER again. The client must save it.
      return reply.status(201).send({
        data: {
          agentId: result.agentId,
          token: result.token,
          label,
          message: 'Save this token now — it will not be shown again.',
        },
      });
    },
  });

  /** Revoke an agent. */
  app.delete('/api/agents/:agentId', {
    preHandler: [authenticate, requirePermission('settings:manage')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const { agentId } = request.params as { agentId?: string };
      if (!agentId)
        return reply
          .status(400)
          .send({ error: { code: 'VALIDATION_FAILED', message: 'agentId is required' } });

      const revoked = await revokeAgent(agentId, principal.user.id);
      if (!revoked) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }

      // Revocation is not just a database flag. The row now carries `revoked_at`,
      // so the agent's *next* handshake is refused — but a socket that is already
      // registered would keep serving until it happened to drop. Closing it here
      // makes the revocation take effect on the live connection: in-flight
      // requests fail, terminal streams bridged through this agent stop, and any
      // later request is refused because the channel is gone. Keyed by agent id,
      // so no other agent's socket is touched.
      const socketClosed = closeAgentSocket(
        agentId,
        WS_CLOSE.FORBIDDEN,
        'Agent has been revoked'
      );

      void recordAuditEvent({
        action: 'agent.revoked',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        target: agentId,
        metadata: { socketClosed },
      });

      log.warn({ agentId, socketClosed }, 'agent revoked via API');
      return reply.status(200).send({ data: { revoked: true } });
    },
  });
}
