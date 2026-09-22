import { useEffect } from 'react';

import { DEFAULT_SHORTCUTS, matchShortcut, type ShortcutAction } from '../lib/shortcuts.js';
import { useDesktopStore } from '../stores/desktop.store.js';

/**
 * Installs the single global keyboard-shortcut listener for the desktop.
 *
 * One `keydown` handler on the window matches the event against the registry and
 * dispatches the matching action against the window-manager store. It reads the
 * store through `getState()` at event time rather than closing over a snapshot,
 * so the handler is registered once and never needs re-binding.
 *
 * Shortcuts are ignored while focus is in a text field or an editor/terminal —
 * both of which expose a real `<textarea>`/`contenteditable`, so the check below
 * catches Monaco and xterm without any per-app wiring. That means a window can be
 * snapped by keyboard when the desktop or a non-text app has focus, but not while
 * you are typing into a terminal; the browser sandbox gives no way to grab the
 * keys ahead of the focused control the way a native window manager does.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
        ) != null
      ) {
        return;
      }

      const binding = matchShortcut(event, DEFAULT_SHORTCUTS);
      if (binding === null) return;

      event.preventDefault();
      dispatch(binding.action);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Resolves a shortcut action to the window-manager store calls it performs. */
function dispatch(action: ShortcutAction): void {
  const store = useDesktopStore.getState();
  const { focusedId } = store;

  switch (action) {
    case 'launcher.toggle':
      store.setLauncherOpen(!store.launcherOpen);
      return;
    case 'window.cycleNext':
      store.cycleFocus(1);
      return;
    case 'window.cyclePrev':
      store.cycleFocus(-1);
      return;
  }

  // The remaining actions operate on the focused window.
  if (focusedId === null) return;
  const focused = store.windows.find((window) => window.id === focusedId);
  if (focused === undefined) return;

  switch (action) {
    case 'window.snapLeft':
      store.snapWindow(focusedId, 'left');
      return;
    case 'window.snapRight':
      store.snapWindow(focusedId, 'right');
      return;
    case 'window.maximize':
      // Idempotent: snapWindow('maximize') only records restore bounds if the
      // window is not already maximised, so repeated presses do not toggle.
      store.snapWindow(focusedId, 'maximize');
      return;
    case 'window.minimizeOrRestore':
      if (focused.restoreBounds !== null) {
        store.toggleMaximize(focusedId); // restore a maximised window
      } else {
        store.minimizeWindow(focusedId);
      }
      return;
  }
}
