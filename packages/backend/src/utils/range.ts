/**
 * HTTP `Range` header parsing for the byte-serving endpoints.
 *
 * Only the single-range form is supported, which is what browsers actually send
 * for `<img>`, `<video>` and `<audio>`. A multi-range request (`bytes=0-9,20-29`)
 * is answered by ignoring the header and returning the whole file, which the
 * spec permits: a server may always answer `200` with the full body.
 */

export interface ByteRange {
  /** First byte to send, inclusive. */
  start: number;
  /** Last byte to send, inclusive. */
  end: number;
}

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'range'; range: ByteRange }
  /** Syntactically valid but unsatisfiable — the caller must answer `416`. */
  | { kind: 'unsatisfiable' };

/** `bytes=…` — the only unit the spec defines and the only one sent in practice. */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolves a `Range` header against a known file size.
 *
 * `size` is required rather than optional because every branch below depends on
 * it: `bytes=-500` means the *last* 500 bytes, and a start past the end is
 * unsatisfiable rather than empty. An absent or unparseable header is `full`,
 * matching the spec's rule that a malformed range is ignored.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'full' };

  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return { kind: 'full' };

  const [, rawStart, rawEnd] = match;
  if (rawStart === undefined || rawEnd === undefined) return { kind: 'full' };

  // `bytes=-N`: a suffix length, not a start offset.
  if (rawStart === '') {
    if (rawEnd === '') return { kind: 'full' };
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    // A suffix longer than the file means the whole file.
    return { kind: 'range', range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: 'unsatisfiable' };

  // An open-ended `bytes=N-` runs to the last byte.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };

  return { kind: 'range', range: { start, end } };
}
