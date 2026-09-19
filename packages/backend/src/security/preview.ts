import { config } from '../config.js';

import type { PreviewCapability } from '@aether/shared';

/**
 * Where a port preview is served from, and how a request is recognised as one.
 *
 * A preview gets its own origin — the desktop's own host on a port from the
 * configured range — rather than a path on the desktop's origin. Two reasons,
 * both of which decide whether a real project works at all:
 *
 * An app served under `/ports/5173/` is not at `/`, so it emits `/assets/app.js`
 * for its own bundle and the browser asks the desktop's origin for a file that
 * only exists on the dev server. The page comes up blank. A preview on its own
 * origin is at `/`, so nothing about the app has to change.
 *
 * The other reason is the session. Content served under the desktop's origin can
 * read the desktop's storage and act as the user. Content on another port is a
 * different origin with its own storage, and can do neither.
 *
 * The cost is that the range has to be published by the reverse proxy and
 * permitted by the firewall. `deploy/` does both, and `previewCapability()`
 * reports the situation so the Ports app can say what is wrong instead of
 * showing a preview that never loads.
 */

/**
 * Prefix of the cookie carrying a previewed page's credential. See
 * `preview.service` — the cookie is named per preview address, because a cookie
 * is not scoped to a port and several previews share one host.
 */
export const PREVIEW_COOKIE_PREFIX = 'aether_preview_';

/** Ports this instance serves previews from. Empty when previews are off. */
export function previewPorts(): number[] {
  if (!config.AETHER_PREVIEW_ENABLED) return [];

  const ports: number[] = [];
  for (let offset = 0; offset < config.AETHER_PREVIEW_PORT_COUNT; offset += 1) {
    const port = config.AETHER_PREVIEW_PORT_START + offset;
    if (port > 65_535) break;
    ports.push(port);
  }
  return ports;
}

/**
 * Scheme and host the desktop itself is served from — `https://example.com`.
 *
 * Taken from `BASE_URL` rather than from the request, because a preview's origin
 * has to be the same in the URL the desktop frames, in the content security
 * policy that permits it, and in the link offered to open in a browser tab. The
 * port is dropped: every preview port is added back explicitly.
 */
export function desktopOrigin(): string {
  return `${new URL(config.BASE_URL).protocol}//${previewHostname()}`;
}

export function previewOrigin(port: number): string {
  return `${desktopOrigin()}:${port}`;
}

/** Every origin a preview can appear on, for the desktop's `frame-src`. */
export function previewOrigins(): string[] {
  return previewPorts().map(previewOrigin);
}

export function previewCapability(): PreviewCapability {
  const ports = previewPorts();
  if (ports.length === 0) {
    return {
      enabled: false,
      origins: [],
      reason:
        'Port previews are switched off on this instance. Set AETHER_PREVIEW_ENABLED and publish the preview port range to turn them on.',
    };
  }

  // A preview address is one the operator's own browser is sent to, so it has to
  // be a name that browser can reach. The installer writes `127.0.0.1` as
  // `BASE_URL` when it has no domain to use, and framing
  // `http://127.0.0.1:8443` would ask the operator's laptop for a server running
  // on the laptop — an address that is built, offered, and then loads nothing.
  //
  // `localhost` is deliberately not treated the same way. It means something
  // different: a developer running the backend on their own machine, where a
  // preview at `http://localhost:8443` is exactly the right address.
  if (isUnnamedHost(previewHostname())) {
    return {
      enabled: false,
      origins: [],
      reason:
        'Previews need this instance to be reachable by name. Set AETHER_DOMAIN and reinstall so a preview address is one your browser can resolve, rather than 127.0.0.1.',
    };
  }

  return { enabled: true, origins: ports.map(previewOrigin), reason: null };
}

/** The desktop's hostname, without scheme or port. */
export function previewHostname(): string {
  return new URL(config.BASE_URL).hostname;
}

/**
 * Whether a hostname is a loopback address the browser cannot be sent to.
 *
 * Only the numeric forms count: an install that never learned its own name is
 * the case being caught, and `localhost` is a name.
 */
function isUnnamedHost(hostname: string): boolean {
  return hostname === '::1' || /^127\./.test(hostname);
}

/**
 * The preview port this request arrived on, or null when it is not one.
 *
 * A request reaches the backend on a preview port only because the reverse proxy
 * forwarded it from that port's own site, so the `Host` header is the proof of
 * which preview the browser is asking for. The host half is still compared
 * against the configured one: a `Host` header is client-supplied, and a request
 * arriving on the desktop's origin must never be mistaken for a preview.
 */
export function previewPortForHost(hostHeader: string | undefined): number | null {
  if (hostHeader === undefined) return null;

  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }

  if (parsed.hostname !== previewHostname()) return null;

  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port)) return null;

  return previewPorts().includes(port) ? port : null;
}
