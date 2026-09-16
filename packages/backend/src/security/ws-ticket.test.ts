import { describe, expect, it, vi } from 'vitest';

import { WS_TICKET_TTL_MS, issueTicket, redeemTicket } from './ws-ticket.js';
import { UnauthenticatedError } from '../utils/errors.js';

/**
 * Single-use WebSocket tickets.
 *
 * The security properties that matter are: a ticket is unguessable, expires,
 * can only be redeemed once, and only by the session it was issued for.
 */

describe('ws tickets', () => {
  it('issues a high-entropy ticket', async () => {
    const { ticket, expiresIn } = await issueTicket('session-1', 'user-1');

    // 32 random bytes base64url-encoded is 43 characters, i.e. 256 bits.
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresIn).toBe(Math.floor(WS_TICKET_TTL_MS / 1000));
  });

  it('issues a distinct ticket every time', async () => {
    const tickets = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      tickets.add((await issueTicket('session-1', 'user-1')).ticket);
    }
    expect(tickets.size).toBe(50);
  });

  it('redeems a ticket for the session it was issued to', async () => {
    const { ticket } = await issueTicket('session-1', 'user-1');
    await expect(redeemTicket(ticket, 'session-1')).resolves.toEqual({ userId: 'user-1' });
  });

  it('refuses to redeem a ticket twice', async () => {
    const { ticket } = await issueTicket('session-1', 'user-1');
    await redeemTicket(ticket, 'session-1');

    // Replay is the attack a leaked ticket would enable, so the second attempt
    // must fail even though the TTL has not elapsed.
    await expect(redeemTicket(ticket, 'session-1')).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects a ticket presented for a different session', async () => {
    const { ticket } = await issueTicket('session-1', 'user-1');
    await expect(redeemTicket(ticket, 'session-2')).rejects.toThrow(UnauthenticatedError);
  });

  it('consumes a mismatched ticket rather than allowing a probe', async () => {
    const { ticket } = await issueTicket('session-1', 'user-1');

    await expect(redeemTicket(ticket, 'session-2')).rejects.toThrow(UnauthenticatedError);
    // The correct session must not be able to use the ticket afterwards.
    await expect(redeemTicket(ticket, 'session-1')).rejects.toThrow(UnauthenticatedError);
  });

  it('rejects an unknown ticket', async () => {
    await expect(redeemTicket('not-a-real-ticket', 'session-1')).rejects.toThrow(
      UnauthenticatedError
    );
  });

  it('expires a ticket after its TTL', async () => {
    vi.useFakeTimers();
    try {
      const { ticket } = await issueTicket('session-1', 'user-1');

      vi.advanceTimersByTime(WS_TICKET_TTL_MS + 1);

      await expect(redeemTicket(ticket, 'session-1')).rejects.toThrow(UnauthenticatedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still redeems a ticket just before it expires', async () => {
    vi.useFakeTimers();
    try {
      const { ticket } = await issueTicket('session-1', 'user-1');

      vi.advanceTimersByTime(WS_TICKET_TTL_MS - 1);

      await expect(redeemTicket(ticket, 'session-1')).resolves.toEqual({ userId: 'user-1' });
    } finally {
      vi.useRealTimers();
    }
  });
});
