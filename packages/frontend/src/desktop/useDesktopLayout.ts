import { useEffect, useRef } from 'react';

import { APP_REGISTRY } from '../apps/registry.js';
import { fetchDesktopLayout, saveDesktopLayout } from '../lib/desktop-api.js';
import { serializeLayout, useDesktopStore } from '../stores/desktop.store.js';

/**
 * Restores and persists the desktop window layout, per user, server-side.
 *
 * On load it fetches the caller's saved layout and reopens those windows;
 * thereafter it saves the arrangement (debounced) whenever windows change. The
 * store holds no application state, so this restores *arrangement* — which apps
 * were open and where — not a terminal's session or a file's contents.
 *
 * Terminals are deliberately excluded: they are recovered from their live
 * sessions by `useTerminalRecovery`, because a saved terminal window could
 * otherwise reopen for a shell that has since died. Layout persistence and
 * session recovery run at the same time on a fresh desktop and touch disjoint
 * sets of apps, so their order does not matter.
 */

/** Apps whose windows are recovered from live sessions, not from the layout. */
const SESSION_BACKED_APPS = new Set(['terminal']);

/** App ids that still exist; a layout saved before an app was removed skips it. */
const KNOWN_APP_IDS = new Set(APP_REGISTRY.map((app) => app.id));

const SAVE_DEBOUNCE_MS = 800;

export function useDesktopLayout(enabled: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    // Set synchronously so a double-invoked effect (StrictMode) cannot start twice.
    startedRef.current = true;

    let cancelled = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const persist = (): void => {
      const state = useDesktopStore.getState();
      const persistable = state.windows.filter((window) => !SESSION_BACKED_APPS.has(window.appId));
      void saveDesktopLayout(serializeLayout(persistable)).catch(() => undefined);
    };

    void (async () => {
      let layout;
      try {
        ({ layout } = await fetchDesktopLayout());
      } catch {
        // A failed load must not block the desktop; the user simply starts clean.
        layout = null;
      }
      if (cancelled) return;

      if (layout !== null) {
        useDesktopStore
          .getState()
          .applyLayout(layout, { isKnownApp: (id) => KNOWN_APP_IDS.has(id) });
      }

      // Persist future changes only after the initial restore, so an empty
      // desktop mid-load can never overwrite a good saved layout.
      unsubscribe = useDesktopStore.subscribe((state, prev) => {
        if (state.windows === prev.windows) return;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
      });
    })();

    return () => {
      cancelled = true;
      if (saveTimer !== null) clearTimeout(saveTimer);
      if (unsubscribe !== null) unsubscribe();
    };
  }, [enabled]);
}
