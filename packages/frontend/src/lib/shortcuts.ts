/**
 * The keyboard-shortcut registry.
 *
 * This module is pure data plus pure matching/formatting — no DOM, no store —
 * so the chord logic is unit-tested directly. The desktop installs a single
 * global listener (`useGlobalShortcuts`) that matches a keydown against these
 * bindings and dispatches the matching action.
 *
 * A deliberate honesty note lives in the docs: a web desktop cannot capture the
 * shortcuts the host OS or browser reserve for themselves. `Super`/`Meta`
 * combos are grabbed by Windows and GNOME for their *own* window snapping before
 * the page ever sees them, and `Ctrl+Alt+<letter>` is `AltGr` on many keyboard
 * layouts and would type a character instead. So the default bindings avoid
 * both: window management is on `Ctrl+Alt+<arrow>` (arrows never produce an
 * `AltGr` glyph), the launcher is on `Ctrl+Space`, and window cycling is on
 * `Ctrl+` backquote. See KNOWN-LIMITATIONS.md §"Keyboard shortcuts".
 */

/** A key chord: a `KeyboardEvent.key` plus the modifier state it requires. */
export interface Chord {
  /** Matched against `KeyboardEvent.key`, case-insensitively for letters. */
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** The action a binding triggers, resolved to a store call by the hook. */
export type ShortcutAction =
  | 'launcher.toggle'
  | 'window.snapLeft'
  | 'window.snapRight'
  | 'window.maximize'
  | 'window.minimizeOrRestore'
  | 'window.cycleNext'
  | 'window.cyclePrev';

export interface ShortcutBinding {
  action: ShortcutAction;
  chord: Chord;
  /** Human-readable, for a shortcuts help surface. */
  description: string;
  category: 'Windows' | 'Navigation' | 'System';
}

/**
 * The default bindings. Chords are chosen to be reliably delivered to a web app
 * and cancelable (see the module note): none rely on `Meta`, none are
 * `Ctrl+Alt+<letter>`.
 */
export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    action: 'launcher.toggle',
    chord: { key: ' ', ctrl: true },
    description: 'Open or close the app launcher',
    category: 'System',
  },
  {
    action: 'window.snapLeft',
    chord: { key: 'ArrowLeft', ctrl: true, alt: true },
    description: 'Snap the focused window to the left half',
    category: 'Windows',
  },
  {
    action: 'window.snapRight',
    chord: { key: 'ArrowRight', ctrl: true, alt: true },
    description: 'Snap the focused window to the right half',
    category: 'Windows',
  },
  {
    action: 'window.maximize',
    chord: { key: 'ArrowUp', ctrl: true, alt: true },
    description: 'Maximise the focused window',
    category: 'Windows',
  },
  {
    action: 'window.minimizeOrRestore',
    chord: { key: 'ArrowDown', ctrl: true, alt: true },
    description: 'Restore a maximised window, or minimise a floating one',
    category: 'Windows',
  },
  {
    action: 'window.cycleNext',
    chord: { key: '`', ctrl: true },
    description: 'Focus the next window',
    category: 'Navigation',
  },
  {
    action: 'window.cyclePrev',
    chord: { key: '`', ctrl: true, shift: true },
    description: 'Focus the previous window',
    category: 'Navigation',
  },
];

/** A minimal view of a keyboard event, so the matcher needs no real DOM. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Whether `event` is exactly `chord`. Modifiers must match exactly — a chord
 * without `shift` does not fire when Shift is held — so `Ctrl+` and `Ctrl+Shift+`
 * on the same key are distinct bindings. Letter keys compare case-insensitively
 * because Shift changes the reported case.
 */
export function chordMatches(event: KeyEventLike, chord: Chord): boolean {
  const key = normaliseKey(event.key);
  if (key !== normaliseKey(chord.key)) return false;
  return (
    event.ctrlKey === (chord.ctrl ?? false) &&
    event.altKey === (chord.alt ?? false) &&
    event.shiftKey === (chord.shift ?? false) &&
    event.metaKey === (chord.meta ?? false)
  );
}

/** The first binding whose chord matches, or null. */
export function matchShortcut(
  event: KeyEventLike,
  bindings: ShortcutBinding[] = DEFAULT_SHORTCUTS
): ShortcutBinding | null {
  return bindings.find((binding) => chordMatches(event, binding.chord)) ?? null;
}

function normaliseKey(key: string): string {
  // Space arrives as ' '; give it a stable name, and lowercase single letters
  // so 'A' (Shift held) equals 'a'.
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** A display label for a chord, e.g. `Ctrl+Alt+←`. For a help surface. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Super');
  parts.push(KEY_LABELS[chord.key] ?? chord.key.toUpperCase());
  return parts.join('+');
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ' ': 'Space',
  '`': '`',
};
