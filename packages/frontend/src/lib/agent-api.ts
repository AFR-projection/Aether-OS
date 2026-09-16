/**
 * Typed wrappers for the host-agent endpoints.
 *
 * The pairing token is returned exactly once, by `pairAgent`. Nothing in this
 * module caches or persists it.
 */

import { apiRequest } from './api-client.js';

import type { AgentPairResult, HostAgent } from '@aether/shared';

/**
 * Lists the paired agents owned by the signed-in user.
 *
 * `connected` describes an open `/ws/agent` socket held by the backend replica
 * that answered this request, so it is a live view rather than stored state.
 */
export function fetchAgents(): Promise<HostAgent[]> {
  return apiRequest<HostAgent[]>('/api/agents');
}

/**
 * Pairs a new agent and returns its token.
 *
 * The token is shown once and never retrievable again — the backend keeps only
 * a SHA-256 hash — so the caller must surface it for copying immediately.
 */
export function pairAgent(label: string): Promise<AgentPairResult> {
  return apiRequest<AgentPairResult>('/api/agents/pair', {
    method: 'POST',
    body: { label },
  });
}

/** Revokes an agent; its token stops authenticating on the next handshake. */
export function revokeAgent(agentId: string): Promise<{ revoked: boolean }> {
  return apiRequest<{ revoked: boolean }>(`/api/agents/${agentId}`, { method: 'DELETE' });
}
