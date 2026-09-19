import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizePreviewRequest,
  clearPreviewCookie,
  issuePreviewToken,
  listPreviewsForUser,
  previewCookie,
  previewTokenFromCookie,
  releasePreview,
  reservePreview,
  verifyPreviewToken,
} from './preview.service.js';
import { previewPorts } from '../security/preview.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '../utils/errors.js';

import type { PortPreview } from '@aether/shared';

/**
 * A preview's credential, and what it is allowed to open.
 *
 * The design being tested is that two independent things have to agree: a signed
 * cookie naming a user, and a reservation made on the address that cookie
 * arrived at. Either alone is refused. That is the whole of what stands between
 * a preview token and somebody else's dev server, so it is held to here.
 */

/** The cookie a browser would send back, for the address it was issued for. */
function cookieFor(slot: number, token: string): string {
  return previewCookie(slot, token, 3_600).split(';')[0] ?? '';
}

/** The first preview address, or a number that fails loudly if there are none. */
function firstAddress(): number {
  const address = previewPorts()[0];
  if (address === undefined) throw new Error('previews are disabled in this test run');
  return address;
}

/** The first two preview addresses. */
function twoAddresses(): [number, number] {
  const [first, second] = previewPorts();
  if (first === undefined || second === undefined) {
    throw new Error('this test needs at least two preview addresses');
  }
  return [first, second];
}

/**
 * Preview addresses are a fixed number, shared by every test in this file, and
 * the instance is asked for all of them by some of these tests. So every
 * reservation a test makes is given back: a test that kept one would change what
 * the next one sees, and the one that fills the instance would break every test
 * after it.
 */
const open: Array<{ userId: string; agentId: string; port: number }> = [];

async function hold(
  userId: string,
  agentId: string,
  port: number
): Promise<{ slot: number; preview: PortPreview }> {
  const reservation = await reservePreview(userId, agentId, port);
  open.push({ userId, agentId, port });
  return reservation;
}

afterEach(async () => {
  for (const reservation of open.splice(0)) {
    await releasePreview(reservation.userId, reservation.agentId, reservation.port);
  }
});

describe('preview tokens', () => {
  it('verifies a token it issued', () => {
    const address = firstAddress();
    const { token } = issuePreviewToken('user-a', address);
    expect(verifyPreviewToken(token, address)).toEqual({ userId: 'user-a' });
  });

  it('refuses a token on an address it was not issued for', () => {
    // The same user, a real token, an address it does not name. This is what
    // stops one preview address being a skeleton key for the others.
    const [first, second] = twoAddresses();
    const { token } = issuePreviewToken('user-a', first);
    expect(verifyPreviewToken(token, second)).toBeNull();
  });

  it('refuses a token with an edited payload', () => {
    const address = firstAddress();
    const { token } = issuePreviewToken('user-a', address);
    const [payload = '', signature = ''] = token.split('.');

    // A payload naming somebody else, under the signature of the real one: the
    // forgery a bearer credential invites.
    const forged = Buffer.from(
      JSON.stringify({ userId: 'user-b', slot: address, expiresAt: Date.now() + 60_000 })
    ).toString('base64url');

    expect(verifyPreviewToken(`${forged}.${signature}`, address)).toBeNull();
    expect(verifyPreviewToken(`${payload}.${signature}x`, address)).toBeNull();
    expect(verifyPreviewToken('nonsense', address)).toBeNull();
    expect(verifyPreviewToken(undefined, address)).toBeNull();
  });

  it('finds its own cookie among others', () => {
    const [first, second] = twoAddresses();
    const header = ['other=1', cookieFor(first, 'the-token'), 'aether.noise=2'].join('; ');

    expect(previewTokenFromCookie(header, first)).toBe('the-token');
    // One address's cookie is not another address's credential.
    expect(previewTokenFromCookie(header, second)).toBeUndefined();
    expect(previewTokenFromCookie(undefined, first)).toBeUndefined();
  });

  it('clears a cookie by expiring it', () => {
    const address = firstAddress();
    expect(clearPreviewCookie(address)).toContain(`aether_preview_${address}=;`);
    expect(clearPreviewCookie(address)).toContain('Max-Age=0');
  });
});

describe('preview reservations', () => {
  it('gives the same address back for the same port', async () => {
    const first = await hold('user-same', 'agent-1', 5173);
    const second = await hold('user-same', 'agent-1', 5173);
    expect(second.slot).toBe(first.slot);
  });

  it('gives different ports different addresses', async () => {
    const a = await hold('user-many', 'agent-1', 3000);
    const b = await hold('user-many', 'agent-1', 3001);
    expect(b.slot).not.toBe(a.slot);
  });

  it('refuses when every address is taken', async () => {
    const addresses = previewPorts();

    // Distinct ports as well as distinct agents, so none of these reuse an
    // address already handed out above.
    for (const [index] of addresses.entries()) {
      await hold('user-full', `agent-${index}`, 10_000 + index);
    }

    await expect(reservePreview('user-full', 'agent-overflow', 20_000)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it('frees an address when the preview is stopped', async () => {
    const before = await hold('user-release', 'agent-1', 8080);
    expect(await releasePreview('user-release', 'agent-1', 8080)).toBe(before.slot);

    // A reservation that is gone is not released a second time.
    expect(await releasePreview('user-release', 'agent-1', 8080)).toBeNull();

    // And the address is offered again to whoever asks next.
    const after = await hold('user-release', 'agent-1', 8080);
    expect(after.slot).toBe(before.slot);
  });

  it('does not release an address belonging to another user', async () => {
    await hold('user-owner', 'agent-1', 9090);

    expect(await releasePreview('user-other', 'agent-1', 9090)).toBeNull();
    // Refused, and the address is still its owner's.
    expect(await listPreviewsForUser('user-owner')).toHaveLength(1);
  });
});

describe('authorising a request on a preview address', () => {
  it('refuses a request with no cookie', async () => {
    await expect(authorizePreviewRequest(firstAddress(), undefined)).rejects.toBeInstanceOf(
      UnauthenticatedError
    );
  });

  it('refuses a valid cookie for an address with no reservation', async () => {
    // Reserved and then released, so the address is one this instance really
    // serves and the reservation is genuinely gone rather than never made —
    // which is the state a stolen token arrives in once a preview is stopped.
    const { slot } = await hold('user-gone', 'agent-1', 6500);
    await releasePreview('user-gone', 'agent-1', 6500);

    const { token } = issuePreviewToken('user-gone', slot);
    await expect(authorizePreviewRequest(slot, cookieFor(slot, token))).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('refuses a cookie whose user does not own the reservation', async () => {
    const { slot } = await hold('user-real', 'agent-1', 6000);
    const { token } = issuePreviewToken('user-attacker', slot);

    await expect(authorizePreviewRequest(slot, cookieFor(slot, token))).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('allows the user who reserved it', async () => {
    const { slot, preview } = await hold('user-allowed', 'agent-1', 7000);
    const { token } = issuePreviewToken('user-allowed', slot);

    const reservation = await authorizePreviewRequest(slot, cookieFor(slot, token));
    expect(reservation.userId).toBe('user-allowed');
    expect(reservation.port).toBe(7000);
    expect(preview.url).toContain(`:${slot}`);
  });
});
