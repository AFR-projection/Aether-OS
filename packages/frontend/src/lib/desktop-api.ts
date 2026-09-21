/**
 * Typed wrappers for the per-user desktop layout endpoint.
 *
 * The layout is stored server-side, keyed by the authenticated user, so it
 * follows the user to any browser and survives a reload, a fresh login, and an
 * Aether restart. It is not kept in `localStorage`: that would be per-device and
 * would not survive a different machine.
 */

import { apiRequest } from './api-client.js';

import type { DesktopLayout } from '@aether/shared';

/** The caller's saved layout, or null when they have none yet. */
export function fetchDesktopLayout(): Promise<{ layout: DesktopLayout | null }> {
  return apiRequest<{ layout: DesktopLayout | null }>('/api/desktop/layout');
}

export function saveDesktopLayout(layout: DesktopLayout): Promise<{ saved: boolean }> {
  return apiRequest<{ saved: boolean }>('/api/desktop/layout', {
    method: 'PUT',
    body: layout,
  });
}
