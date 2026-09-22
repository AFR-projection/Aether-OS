import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHORTCUTS,
  chordMatches,
  formatChord,
  matchShortcut,
  type KeyEventLike,
} from './shortcuts.js';

/**
 * The chord matcher is the whole correctness surface of the shortcut registry:
 * modifiers must match exactly (so `Ctrl+` and `Ctrl+Shift+` on one key stay
 * distinct), and letter case must not matter (Shift reports an uppercase key).
 * Pure, so it is asserted directly with a minimal event shape.
 */

function event(over: Partial<KeyEventLike>): KeyEventLike {
  return { key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

describe('chordMatches', () => {
  it('matches a modifier-plus-key chord', () => {
    expect(chordMatches(event({ key: ' ', ctrlKey: true }), { key: ' ', ctrl: true })).toBe(true);
  });

  it('requires modifiers to match exactly', () => {
    // A chord without shift must not fire when shift is held.
    expect(
      chordMatches(event({ key: '`', ctrlKey: true, shiftKey: true }), { key: '`', ctrl: true })
    ).toBe(false);
    // And the shift variant must fire only with shift.
    expect(
      chordMatches(event({ key: '`', ctrlKey: true, shiftKey: true }), {
        key: '`',
        ctrl: true,
        shift: true,
      })
    ).toBe(true);
  });

  it('compares letters case-insensitively', () => {
    expect(chordMatches(event({ key: 'S', ctrlKey: true }), { key: 's', ctrl: true })).toBe(true);
  });

  it('does not match when a modifier is missing', () => {
    expect(chordMatches(event({ key: 'ArrowLeft', ctrlKey: true }), {
      key: 'ArrowLeft',
      ctrl: true,
      alt: true,
    })).toBe(false);
  });
});

describe('matchShortcut', () => {
  it('resolves Ctrl+Alt+Left to snap-left', () => {
    const binding = matchShortcut(event({ key: 'ArrowLeft', ctrlKey: true, altKey: true }));
    expect(binding?.action).toBe('window.snapLeft');
  });

  it('distinguishes Ctrl+` from Ctrl+Shift+`', () => {
    expect(matchShortcut(event({ key: '`', ctrlKey: true }))?.action).toBe('window.cycleNext');
    expect(matchShortcut(event({ key: '`', ctrlKey: true, shiftKey: true }))?.action).toBe(
      'window.cyclePrev'
    );
  });

  it('returns null for an unbound chord', () => {
    expect(matchShortcut(event({ key: 'x', ctrlKey: true }))).toBeNull();
  });

  it('binds no default shortcut to Meta (the host OS reserves it)', () => {
    expect(DEFAULT_SHORTCUTS.every((binding) => binding.chord.meta !== true)).toBe(true);
  });

  it('binds no default shortcut to Ctrl+Alt+<letter> (AltGr on many layouts)', () => {
    const isLetter = (key: string): boolean => /^[a-z]$/i.test(key);
    expect(
      DEFAULT_SHORTCUTS.every(
        (binding) => !(binding.chord.ctrl && binding.chord.alt && isLetter(binding.chord.key))
      )
    ).toBe(true);
  });
});

describe('formatChord', () => {
  it('renders modifiers and an arrow glyph', () => {
    expect(formatChord({ key: 'ArrowLeft', ctrl: true, alt: true })).toBe('Ctrl+Alt+←');
  });

  it('renders the space key by name', () => {
    expect(formatChord({ key: ' ', ctrl: true })).toBe('Ctrl+Space');
  });
});
