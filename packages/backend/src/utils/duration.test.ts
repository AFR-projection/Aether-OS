import { describe, expect, it } from 'vitest';

import { formatDuration, parseDurationMs } from './duration.js';

describe('parseDurationMs', () => {
  it('parses each supported unit', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('30d')).toBe(2_592_000_000);
    expect(parseDurationMs('1w')).toBe(604_800_000);
  });

  it('tolerates surrounding and internal whitespace', () => {
    expect(parseDurationMs(' 15 m ')).toBe(900_000);
  });

  it('throws on an unparseable value instead of defaulting', () => {
    // A silently-defaulted token lifetime would be a security bug, so an
    // unrecognised value must be fatal.
    expect(() => parseDurationMs('15')).toThrow();
    expect(() => parseDurationMs('fortnight')).toThrow();
    expect(() => parseDurationMs('')).toThrow();
    expect(() => parseDurationMs('-5m')).toThrow();
  });
});

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(900_000)).toBe('15m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(2_592_000_000)).toBe('30d');
  });
});
