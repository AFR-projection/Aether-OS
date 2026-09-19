import { createHmac, timingSafeEqual } from 'node:crypto';

import { cache } from '../cache/index.js';
import { config } from '../config.js';
import { PREVIEW_COOKIE_PREFIX, previewOrigin, previewPorts } from '../security/preview.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from '../utils/errors.js';

import type { PortPreview } from '@aether/shared';

/**
 * Port previews: which port is showing on which preview address, and who is
 * allowed to look at it.
 *
 * A previewed page cannot present a bearer token. It is a document in an iframe,
 * and the browser fetches its images, scripts and stylesheets itself — none of
 * which can carry an `Authorization` header. So a preview is authorised the way
 * a page is: with a cookie.
 *
 * The cookie identifies the *user*, not the port. Which port a preview shows is
 * decided by the port the request arrived on, from a reservation made when the
 * user asked for the preview — so a cookie for one user cannot be pointed at
 * another user's preview by editing a URL, because the reservation carries its
 * own owner and the two are compared on every request.
 *
 * The cookie is host-scoped and cookies ignore ports, which is exactly what
 * makes this work: a cookie set by the desktop on `example.com` is sent to
 * `example.com:8443` as well. Previews are therefore limited to this instance's
 * own hostname, and the session token the desktop holds is untouched — it lives
 * in the desktop origin's storage, which a preview cannot read.
 */

/**
 * How long a preview stays open.
 *
 * Long enough for a working session, short enough that a reservation does not
 * outlive the work that needed it. The port was already reachable from the host
 * itself; this only decides how long Aether keeps offering it to a browser.
 */
const PREVIEW_TTL_MS = 12 * 60 * 60 * 1000;

interface Reservation {
  userId: string;
  agentId: string;
  port: number;
  expiresAt: string;
}

interface PreviewTokenPayload {
  userId: string;
  slot: number;
  expiresAt: number;
}

function slotKey(slot: number): string {
  return `preview-slot:${slot}`;
}

/**
 * Cookie name for one preview address.
 *
 * Named per address because a cookie cannot be scoped to a port: several
 * previews share this host, so a single shared name would have each new preview
 * overwrite the last one's credential. Naming them apart also means the token a
 * given preview carries opens that preview and no other, so handing it to the
 * dev server behind it — which is what forwarding the request does — gives that
 * server nothing beyond the page it is already serving.
 */
function cookieName(slot: number): string {
  return `${PREVIEW_COOKIE_PREFIX}${slot}`;
}

/**
 * Signs preview tokens with a key of their own.
 *
 * Derived from the session secret rather than used directly, so a token minted
 * here can never be mistaken for — or replayed as — an authentication token
 * somewhere else in the system.
 */
function signingKey(): Buffer {
  const secret = config.SESSION_SECRET ?? config.JWT_SECRET;
  return createHmac('sha256', secret).update('aether:preview:v1').digest();
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
}

export function issuePreviewToken(
  userId: string,
  slot: number
): { token: string; expiresAt: string; expiresInSeconds: number } {
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const payload: PreviewTokenPayload = { userId, slot, expiresAt };

  // Signed, not encrypted: the payload carries a user id, an address and an
  // expiry, none of which is a secret. What the signature buys is that none of
  // them can be edited — a preview token is a bearer credential for as long as
  // the port is open.
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return {
    token: `${encoded}.${sign(encoded)}`,
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSeconds: Math.floor(PREVIEW_TTL_MS / 1000),
  };
}

/**
 * Returns the user a preview token belongs to, or null.
 *
 * The signature is compared in constant time. A preview token is a bearer
 * credential for as long as the port is open, so a byte-at-a-time comparison
 * would be the only thing standing between a guess and somebody's dev server.
 */
export function verifyPreviewToken(
  token: string | undefined,
  slot: number
): { userId: string } | null {
  if (token === undefined || token.length === 0) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const encoded = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(encoded));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const payload = parsed as Partial<PreviewTokenPayload>;
  if (typeof payload.userId !== 'string' || typeof payload.expiresAt !== 'number') return null;
  if (payload.expiresAt <= Date.now()) return null;
  // A token issued for one preview address is refused on another, even though
  // both belong to the same user and would otherwise pass every other check.
  if (payload.slot !== slot) return null;

  return { userId: payload.userId };
}

/** The preview token on a request, if it carries one for this address. */
export function previewTokenFromCookie(
  cookieHeader: string | undefined,
  slot: number
): string | undefined {
  if (cookieHeader === undefined) return undefined;

  const wanted = cookieName(slot);
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === wanted) return rest.join('=');
  }
  return undefined;
}

/**
 * The `Set-Cookie` for a preview token.
 *
 * `SameSite=Strict` is safe here and stronger than it looks: the desktop and its
 * previews share a host, and a site ignores the port, so the cookie is sent to
 * the framed preview like any same-site request — while a third-party page
 * embedding the preview gets nothing, which is what stops a preview being
 * clickjacked or driven from another site.
 *
 * The port is deliberately absent from `Path`: a cookie's path is a URL path,
 * not a port, so there is no way to scope this to one preview by path and no
 * need to — the name does that instead.
 */
export function previewCookie(slot: number, token: string, maxAgeSeconds: number): string {
  const attributes = [
    `${cookieName(slot)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.isHttps) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearPreviewCookie(slot: number): string {
  return previewCookie(slot, '', 0);
}

function toPreview(slot: number, reservation: Reservation): PortPreview {
  const origin = previewOrigin(slot);
  return {
    port: reservation.port,
    agentId: reservation.agentId,
    origin,
    url: `${origin}/`,
    expiresAt: reservation.expiresAt,
  };
}

/** Every preview this user currently has open, newest reservations included. */
export async function listPreviewsForUser(userId: string): Promise<PortPreview[]> {
  const slots = previewPorts();
  const found = await Promise.all(
    slots.map(async (slot) => {
      const reservation = await cache.get<Reservation>(slotKey(slot));
      if (reservation === null || reservation.userId !== userId) return null;
      return toPreview(slot, reservation);
    })
  );

  return found.filter((preview): preview is PortPreview => preview !== null);
}

/**
 * Reserves an address for a port, returning the same one for the same port.
 *
 * Reusing the existing reservation matters more than it looks: the preview URL
 * is what the user may have open in a tab, in a bookmark, or in a second
 * browser, and re-ordering it to a different port because a slot was free
 * elsewhere would break all of them for no gain.
 */
export async function reservePreview(
  userId: string,
  agentId: string,
  port: number
): Promise<{ slot: number; preview: PortPreview }> {
  const slots = previewPorts();
  if (slots.length === 0) {
    throw new ServiceUnavailableError('Port previews are switched off on this instance');
  }

  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

  for (const slot of slots) {
    const existing = await cache.get<Reservation>(slotKey(slot));
    if (existing === null) continue;
    if (existing.userId === userId && existing.agentId === agentId && existing.port === port) {
      const refreshed: Reservation = { ...existing, expiresAt };
      await cache.set(slotKey(slot), refreshed, PREVIEW_TTL_MS);
      return { slot, preview: toPreview(slot, refreshed) };
    }
  }

  for (const slot of slots) {
    const existing = await cache.get<Reservation>(slotKey(slot));
    if (existing !== null) continue;

    const reservation: Reservation = { userId, agentId, port, expiresAt };
    await cache.set(slotKey(slot), reservation, PREVIEW_TTL_MS);
    return { slot, preview: toPreview(slot, reservation) };
  }

  throw new ConflictError(
    'Every preview address on this instance is in use. Stop a preview you no longer need, or raise the preview port range.',
    { slots: slots.length }
  );
}

/** Ends this user's preview of a port, returning the address it freed. */
export async function releasePreview(
  userId: string,
  agentId: string,
  port: number
): Promise<number | null> {
  for (const slot of previewPorts()) {
    const existing = await cache.get<Reservation>(slotKey(slot));
    if (existing === null) continue;
    if (existing.userId !== userId || existing.agentId !== agentId || existing.port !== port) {
      continue;
    }
    await cache.delete(slotKey(slot));
    return slot;
  }
  return null;
}

/**
 * Decides whether a request on a preview address may proceed.
 *
 * Both halves are required: a valid cookie naming a user, and a reservation on
 * that address belonging to that same user. Anything else is refused — an
 * address with no reservation shows nothing, and a user with a valid cookie
 * cannot reach an address reserved by somebody else.
 */
export async function authorizePreviewRequest(
  slot: number,
  cookieHeader: string | undefined
): Promise<Reservation> {
  const identity = verifyPreviewToken(previewTokenFromCookie(cookieHeader, slot), slot);
  if (identity === null) {
    throw new UnauthenticatedError(
      'This preview has expired. Open it again from the Ports app.',
      'TOKEN_INVALID'
    );
  }

  const reservation = await cache.get<Reservation>(slotKey(slot));
  if (reservation === null) {
    throw new NotFoundError('Nothing is open on this preview address', { slot });
  }

  if (reservation.userId !== identity.userId) {
    throw new ForbiddenError('This preview belongs to another account');
  }

  return reservation;
}
