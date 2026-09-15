import { type FastifyInstance } from 'fastify';

import { authenticate, requirePrincipal, requirePermission } from '../middleware/auth.js';
import { pairAgent, listAgents, revokeAgent } from '../services/agent-pairing.service.js';
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
export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  /** List paired agents (no secrets). */
  app.get('/api/agents', {
    preHandler: [authenticate, requirePermission('settings:manage')],
    handler: async (request, reply) => {
      const principal = requirePrincipal(request);
      const agents = await listAgents(principal.user.id);
      return reply.send({ data: agents });
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
      if (!agentId) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'agentId is required' } });

      const revoked = await revokeAgent(agentId, principal.user.id);
      if (!revoked) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }

      void recordAuditEvent({
        action: 'agent.revoked',
        outcome: 'success',
        actorUserId: principal.user.id,
        actorUsername: principal.user.username,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        target: agentId,
      });

      log.warn({ agentId }, 'agent revoked via API');
      return reply.status(200).send({ data: { revoked: true } });
    },
  });
}
