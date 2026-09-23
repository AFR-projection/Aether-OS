import { useSyncExternalStore } from 'react';

/**
 * Whether the browser currently has network connectivity, as a React value.
 *
 * This is a genuine signal — `navigator.onLine` plus the `online`/`offline`
 * events the browser fires — not a decorative indicator. Its one honest limit is
 * that it reflects the *browser's* network stack, not whether the Aether backend
 * is reachable: a captive portal or a dead backend on a live network still reads
 * as online. The API client's transport-failure notification is the sharper
 * "backend is gone" signal; this is the coarse "the machine has a network" one,
 * which is exactly what an OS tray's network glyph shows.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function getSnapshot(): boolean {
  // `navigator.onLine` is `true` on the rare platform that cannot determine it,
  // which is the right default: assume connected rather than cry offline.
  return navigator.onLine;
}

function getServerSnapshot(): boolean {
  // No `navigator` during SSR; the app is client-only, but keep the hook honest.
  return true;
}
