import { desktopLayoutSchema } from '@aether/shared';

import { authenticate, requirePrincipal } from '../middleware/auth.js';
import { getDesktopLayout, saveDesktopLayout } from '../services/desktop-layout.service.js';
import { parseOrThrow } from '../utils/validate.js';

import type { FastifyInstance } from 'fastify';

/**
 * Per-user desktop window layout.
 *
 * Authentication is the only gate: every signed-in user persists their own
 * desktop, whatever their role. There is deliberately no permission check — a
 * `settings:manage`-style gate would stop an operator or viewer from keeping
 * their own window arrangement, which is not an administrative act. Isolation
 * comes from the key being derived from the authenticated principal, so the body
 * a client sends can only ever be stored as *its own* layout.
 */
export function registerDesktopRoutes(app: FastifyInstance): void {
  app.get('/api/desktop/layout', { preHandler: [authenticate] }, async (request) => {
    const principal = requirePrincipal(request);
    return { data: { layout: await getDesktopLayout(principal.user.id) } };
  });

  app.put('/api/desktop/layout', { preHandler: [authenticate] }, async (request) => {
    const principal = requirePrincipal(request);
    const layout = parseOrThrow(desktopLayoutSchema, request.body, 'desktop layout');
    await saveDesktopLayout(principal.user.id, layout);
    return { data: { saved: true } };
  });
}
