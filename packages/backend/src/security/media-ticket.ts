import { randomBytes } from 'node:crypto';

import { cache } from '../cache/index.js';
import { UnauthenticatedError } from '../utils/errors.js';

/**
 * Short-lived tickets for byte-serving URLs.
 *
 * `<img>`, `<video>` and `<audio>` fetch their `src` themselves. They cannot
 * carry an `Authorization` header, and they issue several requests per file — a
 * seek in a video is one HTTP range request, and a scrub is a burst of them. So
 * the WebSocket ticket next door is the wrong shape twice over: it is
 * single-use, and it names a session rather than a file.
 *
 * This is the same idea tuned for reads: random (256 bits), valid for ten
 * minutes, reusable within that window, and bound to one user *and* the exact
 * scope and path it was issued for. A leaked URL therefore grants read on one
 * file for ten minutes and nothing else — it cannot be pointed at another path,
 * because the binding is checked against the request rather than trusted from
 * it.
 *
 * Unlike a WebSocket ticket this is deliberately not consumed on use: a video
 * element would burn it on the first of dozens of range requests.
 */

const MEDIA_TICKET_TTL_MS = 10 * 60 * 1000;

export { MEDIA_TICKET_TTL_MS };

export interface MediaTicketBinding {
  userId: string;
  scope: 'workspace' | 'host';
  agentId: string | null;
  path: string;
}

function keyFor(ticket: string): string {
  return `media-ticket:${ticket}`;
}

export async function issueMediaTicket(
  binding: MediaTicketBinding
): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = randomBytes(32).toString('base64url');
  await cache.set<MediaTicketBinding>(keyFor(ticket), binding, MEDIA_TICKET_TTL_MS);
  return { ticket, expiresIn: Math.floor(MEDIA_TICKET_TTL_MS / 1000) };
}

/**
 * Resolves a ticket to its binding, or throws.
 *
 * The comparison is against the request's own scope and path, so a ticket for
 * one file presented for another is rejected — the ticket authorises a
 * (user, scope, path) tuple, not a session.
 */
export async function redeemMediaTicket(
  ticket: string,
  expected: Omit<MediaTicketBinding, 'userId'>
): Promise<{ userId: string }> {
  const record = await cache.get<MediaTicketBinding>(keyFor(ticket));

  if (!record) {
    throw new UnauthenticatedError('Media ticket is invalid or has expired', 'TOKEN_INVALID');
  }

  const matches =
    record.scope === expected.scope &&
    record.agentId === expected.agentId &&
    record.path === expected.path;

  if (!matches) {
    throw new UnauthenticatedError('Media ticket was issued for a different file', 'TOKEN_INVALID');
  }

  return { userId: record.userId };
}
