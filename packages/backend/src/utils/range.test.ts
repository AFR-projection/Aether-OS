import { describe, expect, it } from 'vitest';

import { parseRange } from './range.js';

/**
 * A range parser is the kind of code that looks obviously right and is not, so
 * these pin the branches a browser actually triggers: a video element opening a
 * file, seeking backwards, and reading the tail of one.
 */

describe('parseRange', () => {
  it('treats a missing header as a request for the whole file', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'full' });
  });

  it('ignores a header it cannot parse rather than failing the request', () => {
    // The spec says a malformed Range is ignored, not rejected.
    expect(parseRange('bytes=abc', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-10', 1000)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-10,20-30', 1000)).toEqual({ kind: 'full' });
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'range', range: { start: 0, end: 99 } });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({
      kind: 'range',
      range: { start: 500, end: 999 },
    });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 },
    });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseRange('bytes=-5000', 1000)).toEqual({
      kind: 'range',
      range: { start: 0, end: 999 },
    });
  });

  it('clamps an end past the last byte', () => {
    expect(parseRange('bytes=900-99999', 1000)).toEqual({
      kind: 'range',
      range: { start: 900, end: 999 },
    });
  });

  it('reports a start past the end as unsatisfiable', () => {
    // Browsers rely on a 416 here to learn the file shrank beneath them.
    expect(parseRange('bytes=1000-1010', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a reversed range as unsatisfiable', () => {
    expect(parseRange('bytes=500-100', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports any range against an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
