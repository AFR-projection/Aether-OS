import { create } from 'zustand';

import {
  DEFAULT_THEME,
  isThemeId,
  themeDefinition,
  type ThemeDefinition,
  type ThemeId,
} from '../lib/themes.js';

/**
 * The selected OS theme.
 *
 * Persistence is a manual localStorage read/write rather than zustand's
 * `persist` middleware, matching how the API client stores its refresh token —
 * the codebase deliberately keeps one persistence pattern. The choice is per
 * browser, not per account: there is no server-side user-preference store yet,
 * so syncing across devices is out of scope here.
 *
 * The `data-theme` attribute on `<html>` is the single source of truth the CSS
 * reads; `applyTheme` keeps it in sync with the store. It is set once on load
 * (see main.tsx) before React mounts, so there is no flash of the wrong theme.
 */

const STORAGE_KEY = 'aether.theme';

function readPersistedTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // Storage can be unavailable; fall through to the default.
  }
  return DEFAULT_THEME;
}

function persistTheme(theme: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Best-effort; the in-memory store still drives this session.
  }
}

/** Reflects the theme onto the document so the CSS variables switch. */
export function applyTheme(theme: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

/** Sets the initial `data-theme` before React mounts, avoiding a theme flash. */
export function bootstrapTheme(): ThemeId {
  const theme = readPersistedTheme();
  applyTheme(theme);
  return theme;
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readPersistedTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    persistTheme(theme);
    set({ theme });
  },
}));

/** Convenience selector: the full definition for the active theme. */
export function useActiveTheme(): ThemeDefinition {
  return themeDefinition(useThemeStore((state) => state.theme));
}
