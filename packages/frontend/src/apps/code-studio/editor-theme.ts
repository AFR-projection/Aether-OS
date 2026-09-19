/**
 * Builds a Monaco colour theme from the OS theme's CSS variables.
 *
 * The desktop themes (Windows 11 / macOS / GNOME) each define their surface and
 * accent colours as CSS custom properties on `<html>`. Rather than ship a
 * separate hand-tuned Monaco theme per OS — which would drift out of sync — this
 * reads those variables at call time and derives a matching editor theme, so the
 * editor chrome always sits flush with the window it lives in.
 *
 * Monaco wants `#rrggbb` hex; the variables hold space-separated RGB channels
 * (`"14 18 28"`), so `channelsToHex` converts.
 *
 * The `monaco` handle is typed against the `monaco-editor` package directly
 * rather than `@monaco-editor/react`'s `Monaco` alias: the alias points at an
 * untyped submodule and collapses to `any`, which would make every call here
 * unchecked.
 */
import type * as Monaco from 'monaco-editor';

export const AETHER_THEME_ID = 'aether';

function channelsToHex(channels: string): string | null {
  const parts = channels.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function readVar(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return channelsToHex(raw) ?? fallback;
}

/**
 * (Re)defines and returns the Aether editor theme for the current OS theme.
 * Call this again after the OS theme changes to pick up the new palette.
 */
export function defineEditorTheme(monaco: typeof Monaco): string {
  const background = readVar('--surface-800', '#0f172a');
  const gutter = readVar('--surface-900', '#0b1220');
  const foreground = '#e2e8f0';
  const accent = readVar('--accent', '#2563eb');
  const lineHighlight = readVar('--surface-700', '#1e293b');

  monaco.editor.defineTheme(AETHER_THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorGutter.background': gutter,
      'editorLineNumber.foreground': '#475569',
      'editorLineNumber.activeForeground': '#cbd5e1',
      'editor.lineHighlightBackground': lineHighlight,
      'editor.selectionBackground': `${accent}55`,
      'editorCursor.foreground': accent,
      'editorIndentGuide.background1': '#1e293b',
      'editorWidget.background': gutter,
      'editorWidget.border': '#1e293b',
      'editorSuggestWidget.background': gutter,
      'input.background': gutter,
      'dropdown.background': gutter,
      'minimap.background': background,
      'scrollbarSlider.background': '#33415566',
      'scrollbarSlider.hoverBackground': '#33415599',
    },
  });

  return AETHER_THEME_ID;
}
