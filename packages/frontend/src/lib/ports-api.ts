/**
 * Typed wrappers for the ports endpoints.
 *
 * Opening a preview is a write, not a read: the backend reserves one of the
 * instance's preview addresses for the port and sets the cookie that the
 * previewed page will be authorised with. There is no credential in the response
 * body to hold on to — the browser holds it.
 */

import { apiRequest } from './api-client.js';

import type { PortPreview, PortsResponse } from '@aether/shared';

/** The host's listening sockets, the preview capability, and this user's previews. */
export function fetchPorts(agentId: string): Promise<PortsResponse> {
  return apiRequest<PortsResponse>(`/api/ports?agentId=${encodeURIComponent(agentId)}`);
}

/** Reserves a preview address for a port and returns the URL to open. */
export function openPreview(agentId: string, port: number): Promise<PortPreview> {
  return apiRequest<PortPreview>('/api/ports/preview', {
    method: 'POST',
    body: { agentId, port },
  });
}

/** Ends a preview and frees its address. */
export function closePreview(
  agentId: string,
  port: number
): Promise<{ released: boolean; port?: number }> {
  return apiRequest<{ released: boolean; port?: number }>(
    `/api/ports/preview?agentId=${encodeURIComponent(agentId)}&port=${port}`,
    { method: 'DELETE' }
  );
}
