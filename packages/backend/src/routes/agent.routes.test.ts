import { WS_CLOSE } from '@aether/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';

import type { FastifyInstance } from 'fastify';

/**
 * The revoke route's own job, at the route layer.
 *
 * DoD #14 asks that revocation close the live socket rather than only stamp the
 * database. `closeAgentSocket`'s mechanics are proven against the real channel
 * map in `agent-rpc.service.test.ts`; what this suite proves is that the route
 * *invokes* it, and only when the caller actually owns the agent:
 *
 * - a successful revoke closes the socket with the policy-violation code and
 *   records the outcome in the audit metadata;
 * - a revoke that the pairing service refuses (a 404 — the agent is not the
 *   caller's, or does not exist) never reaches for anyone's socket, so
 *   ownership isolation holds at the socket layer too;
 * - revocation still succeeds when there is no live socket to close.
 *
 * `revokeAgent` and `closeAgentSocket` are mocked so the route's control flow is
 * the only thing under test. The rest of `agent-rpc.service` is preserved with
 * `importOriginal`, because `buildServer` registers the units/terminal/ports
 * routes that import from it.
 */

const AGENT_ID = '00000000-0000-4000-8000-0000000000c7';

const { principal, revokeAgentMock, closeAgentSocketMock, recordAuditEventMock } = vi.hoisted(
  () => ({
    principal: {
      user: {
        id: '00000000-0000-4000-8000-0000000000b2',
        username: 'master',
        role: 'owner' as const,
        permissions: [] as string[],
      },
      sessionId: '00000000-0000-4000-8000-0000000000e5',
    },
    revokeAgentMock: vi.fn(),
    closeAgentSocketMock: vi.fn(),
    recordAuditEventMock: vi.fn(() => Promise.resolve()),
  })
);

vi.mock('../middleware/auth.js', () => ({
  authenticate: (): Promise<void> => Promise.resolve(),
  requirePermission: () => (): Promise<void> => Promise.resolve(),
  requirePrincipal: () => principal,
}));

vi.mock('../services/agent-pairing.service.js', () => ({
  revokeAgent: revokeAgentMock,
  pairAgent: vi.fn(),
  listAgents: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../services/agent-rpc.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agent-rpc.service.js')>()),
  closeAgentSocket: closeAgentSocketMock,
}));

vi.mock('../services/audit.service.js', () => ({
  recordAuditEvent: recordAuditEventMock,
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  revokeAgentMock.mockReset();
  closeAgentSocketMock.mockReset();
  recordAuditEventMock.mockReset();
  recordAuditEventMock.mockReturnValue(Promise.resolve());
});

describe('DELETE /api/agents/:agentId', () => {
  it('closes the live socket when the revoke succeeds, and audits the outcome', async () => {
    revokeAgentMock.mockResolvedValue(true);
    closeAgentSocketMock.mockReturnValue(true);

    const response = await app.inject({ method: 'DELETE', url: `/api/agents/${AGENT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { revoked: boolean } }>().data.revoked).toBe(true);

    // The socket is closed, keyed on the revoked agent, with the forbidden code.
    expect(closeAgentSocketMock).toHaveBeenCalledOnce();
    expect(closeAgentSocketMock).toHaveBeenCalledWith(
      AGENT_ID,
      WS_CLOSE.FORBIDDEN,
      expect.stringContaining('revoked')
    );

    // The audit trail records whether a live socket was actually torn down.
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.revoked',
        outcome: 'success',
        target: AGENT_ID,
        metadata: { socketClosed: true },
      })
    );
  });

  it("never touches a socket when the agent is not the caller's (404)", async () => {
    // `revokeAgent` returns false when the row is not the caller's or does not
    // exist. The route must stop there — closing a socket for an agent you were
    // just told you cannot revoke would be a cross-owner disconnect.
    revokeAgentMock.mockResolvedValue(false);

    const response = await app.inject({ method: 'DELETE', url: `/api/agents/${AGENT_ID}` });

    expect(response.statusCode).toBe(404);
    expect(closeAgentSocketMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
    // Ownership is checked in the query, with the caller's id.
    expect(revokeAgentMock).toHaveBeenCalledWith(AGENT_ID, principal.user.id);
  });

  it('still succeeds when the agent has no live socket on this replica', async () => {
    revokeAgentMock.mockResolvedValue(true);
    closeAgentSocketMock.mockReturnValue(false);

    const response = await app.inject({ method: 'DELETE', url: `/api/agents/${AGENT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { revoked: boolean } }>().data.revoked).toBe(true);
    expect(closeAgentSocketMock).toHaveBeenCalledOnce();
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { socketClosed: false } })
    );
  });
});
