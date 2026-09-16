import { randomBytes } from 'node:crypto';

import { cache } from '../cache/index.js';
import { UnauthenticatedError } from '../utils/errors.js';

/**
 * Single-use WebSocket tickets.
 *
 * A browser cannot set an `Authorization` header on a WebSocket handshake. The
 * two usual workarounds are both poor: putting the access token in the query
 * string writes a long-lived credential into every reverse-proxy access log,
 * and putting it in a cookie makes it attachable by any page on the origin
 * (CSRF against the socket).
 *
 * Instead the client asks for a ticket over an authenticated HTTP request, then
 * presents it during the handshake. A ticket is:
 *   - random (256 bits),
 *   - valid for 30 seconds,
 *   - redeemable exactly once,
 *   - bound to one session id and one user id.
 *
 * A ticket that leaks through a log is therefore useless within seconds and
 * cannot be replayed.
 */

const TICKET_TTL_MS = 30_000;

interface TicketRecord {
  sessionId: string;
  userId: string;
}

function keyFor(ticket: string): string {
  return `ws-ticket:${ticket}`;
}

/** Issues a new ticket bound to a session and user. */
export async function issueTicket(
  sessionId: string,
  userId: string
): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = randomBytes(32).toString('base64url');
  await cache.set<TicketRecord>(keyFor(ticket), { sessionId, userId }, TICKET_TTL_MS);
  return { ticket, expiresIn: Math.floor(TICKET_TTL_MS / 1000) };
}

/**
 * Redeems a ticket. Always consumes it, whether or not the binding matches, so
 * a mismatched attempt cannot be used to probe.
 */
export async function redeemTicket(
  ticket: string,
  expectedSessionId: string
): Promise<{ userId: string }> {
  const record = await cache.get<TicketRecord>(keyFor(ticket));
  await cache.delete(keyFor(ticket));

  if (!record) {
    throw new UnauthenticatedError('WebSocket ticket is invalid or has expired', 'TOKEN_INVALID');
  }

  if (record.sessionId !== expectedSessionId) {
    throw new UnauthenticatedError(
      'WebSocket ticket was issued for a different session',
      'TOKEN_INVALID'
    );
  }

  return { userId: record.userId };
}

export const WS_TICKET_TTL_MS = TICKET_TTL_MS;
