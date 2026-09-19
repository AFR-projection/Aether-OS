/**
 * OS theme definitions.
 *
 * Aether ships three desktop themes, each a faithful rendition of a real
 * operating system's shell — not a loose "inspired by". What makes each one
 * recognisable is structural, not just colour: where the window controls sit
 * and how they look, whether the shell is a centred taskbar, a bottom dock, or
 * a top bar, the corner radius, and the system font. Those decisions live here
 * as data so the chrome components can branch on them; the colour palettes live
 * in index.css under `[data-theme=…]` selectors and drive the Tailwind
 * `surface`/`accent` scales through CSS variables.
 */

export const THEME_IDS = ['win11', 'macos', 'gnome'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'win11';

/** Where a window's traffic-light / caption buttons live. */
export type ControlSide = 'left' | 'right';

/** The shape the shell takes along the screen edge. */
export type ShellKind =
  | 'taskbar' // Windows 11: a floating bar, icons centred
  | 'dock' // macOS: a bottom dock of large icons, plus a top menu bar
  | 'topbar'; // GNOME: a top bar (Activities · clock · system), plus a dash

export interface ThemeChrome {
  /** Corner radius of a floating window, in px. */
  windowRadius: number;
  /** Height of a window's title bar, in px. */
  titlebarHeight: number;
  /** Which edge the window controls sit on. */
  controlSide: ControlSide;
  /** Visual language of the window controls. */
  controlStyle: 'win11' | 'traffic' | 'gnome';
  /** Whether the title text is centred (macOS/GNOME) or leading (Windows). */
  titleAlign: 'center' | 'leading';
  /** The shell layout. */
  shell: ShellKind;
}

export interface ThemeDefinition {
  id: ThemeId;
  /** Name shown in the theme picker. */
  label: string;
  /** One line describing the look, shown under the label. */
  description: string;
  chrome: ThemeChrome;
}

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  win11: {
    id: 'win11',
    label: 'Windows 11',
    description: 'Fluent design — a centred taskbar, mica surfaces, caption buttons on the right.',
    chrome: {
      windowRadius: 8,
      titlebarHeight: 32,
      controlSide: 'right',
      controlStyle: 'win11',
      titleAlign: 'leading',
      shell: 'taskbar',
    },
  },
  macos: {
    id: 'macos',
    label: 'macOS',
    description:
      'A translucent menu bar, a magnifying Dock, and traffic-light controls on the left.',
    chrome: {
      windowRadius: 10,
      titlebarHeight: 38,
      controlSide: 'left',
      controlStyle: 'traffic',
      titleAlign: 'center',
      shell: 'dock',
    },
  },
  gnome: {
    id: 'gnome',
    label: 'Linux (GNOME)',
    description: 'The Adwaita shell — a top bar, a flat header bar, and a single close button.',
    chrome: {
      windowRadius: 12,
      titlebarHeight: 44,
      controlSide: 'right',
      controlStyle: 'gnome',
      titleAlign: 'center',
      shell: 'topbar',
    },
  },
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

export function themeDefinition(id: ThemeId): ThemeDefinition {
  return THEMES[id];
}
