import { describe, expect, it } from 'vitest';

import {
  buildRlimitPrologue,
  hasRequestedRlimits,
  type ExecutionUnitRlimits,
} from './execution-units.js';

/**
 * The rlimit prologue is how a unit's resource ceilings reach the real process:
 * it is a snippet of shell run in the same shell, before the target's command,
 * that sets each `ulimit`. These tests pin the exact shell it emits, because
 * the contract is not "a prologue exists" but "the prologue is the one that
 * bounds the process and cannot be raised by it".
 */

const NONE: ExecutionUnitRlimits = {
  addressSpaceBytes: null,
  cpuSeconds: null,
  maxOpenFiles: null,
  coreDumpBytes: null,
};

function rlimits(overrides: Partial<ExecutionUnitRlimits>): ExecutionUnitRlimits {
  return { ...NONE, ...overrides };
}

describe('hasRequestedRlimits', () => {
  it('is false when nothing was asked for', () => {
    expect(hasRequestedRlimits(NONE)).toBe(false);
  });

  it('is true when any single bound was asked for', () => {
    expect(hasRequestedRlimits(rlimits({ cpuSeconds: 30 }))).toBe(true);
    expect(hasRequestedRlimits(rlimits({ addressSpaceBytes: 128 * 1024 * 1024 }))).toBe(true);
    expect(hasRequestedRlimits(rlimits({ maxOpenFiles: 256 }))).toBe(true);
    expect(hasRequestedRlimits(rlimits({ coreDumpBytes: 0 }))).toBe(true);
  });

  it('counts a zero core-dump bound as a request — it is how cores are disabled', () => {
    // Zero is a meaningful value, not an absence: `ulimit -c 0` turns core
    // dumps off. Treating it as unset would silently re-enable them.
    expect(hasRequestedRlimits(rlimits({ coreDumpBytes: 0 }))).toBe(true);
  });
});

describe('buildRlimitPrologue', () => {
  it('emits nothing when no bound was requested', () => {
    expect(buildRlimitPrologue(NONE)).toBe('');
  });

  it('names no ulimit when nothing was requested, so the shell keeps the host login', () => {
    // An empty prologue must not reset a limit the host's own login set — the
    // absence of a request is not a request for zero.
    expect(buildRlimitPrologue(NONE)).not.toContain('ulimit');
  });

  it('sets both the soft and the hard limit — no -S and no -H flag', () => {
    // This is the whole point: `ulimit -v <n>` with no flag sets both, so the
    // value is a ceiling the process cannot raise again. A `-S` would set only
    // the soft limit, which the child could raise back to the (unset) hard one.
    const prologue = buildRlimitPrologue(
      rlimits({ addressSpaceBytes: 256 * 1024 * 1024, cpuSeconds: 10 })
    );
    expect(prologue).not.toContain('-S');
    expect(prologue).not.toContain('-H');
    expect(prologue).toContain('ulimit -v ');
    expect(prologue).toContain('ulimit -t ');
  });

  it('converts byte inputs to the shell\'s 1024-byte units', () => {
    // `ulimit -v` and `-c` take kibibytes; the model speaks bytes. The
    // conversion lives here and nowhere else.
    expect(buildRlimitPrologue(rlimits({ addressSpaceBytes: 512 * 1024 }))).toContain(
      'ulimit -v 512'
    );
    expect(buildRlimitPrologue(rlimits({ coreDumpBytes: 2 * 1024 }))).toContain('ulimit -c 2');
  });

  it('rounds a byte input up to the next kibibyte rather than down', () => {
    // Rounding down would hand the process a *smaller* ceiling than requested;
    // rounding up is the conservative direction — the bound never becomes
    // tighter than what was asked for.
    expect(buildRlimitPrologue(rlimits({ addressSpaceBytes: 1024 + 1 }))).toContain(
      'ulimit -v 2'
    );
  });

  it('passes a file-descriptor count through unchanged', () => {
    expect(buildRlimitPrologue(rlimits({ maxOpenFiles: 4096 }))).toContain('ulimit -n 4096');
  });

  it('passes CPU seconds through unchanged', () => {
    expect(buildRlimitPrologue(rlimits({ cpuSeconds: 900 }))).toContain('ulimit -t 900');
  });

  it('encodes a zero core-dump bound as the way to disable cores', () => {
    expect(buildRlimitPrologue(rlimits({ coreDumpBytes: 0 }))).toContain('ulimit -c 0');
  });

  it('applies every requested bound in one prologue', () => {
    const prologue = buildRlimitPrologue(
      rlimits({
        addressSpaceBytes: 1024 * 1024,
        cpuSeconds: 60,
        maxOpenFiles: 128,
        coreDumpBytes: 0,
      })
    );
    expect(prologue).toContain('ulimit -v 1024');
    expect(prologue).toContain('ulimit -t 60');
    expect(prologue).toContain('ulimit -n 128');
    expect(prologue).toContain('ulimit -c 0');
  });

  it('ends with a separator so the real command follows in the same shell', () => {
    // The prologue is prepended to the target's command, so it has to terminate
    // as a complete statement; otherwise `ulimit -t 5 echo hi` would parse the
    // command as an argument to ulimit.
    const prologue = buildRlimitPrologue(rlimits({ cpuSeconds: 5 }));
    expect(prologue.trimEnd().endsWith(';')).toBe(true);
  });

  it('ignores an unset field in a partially-specified request', () => {
    const prologue = buildRlimitPrologue(rlimits({ cpuSeconds: 5 }));
    expect(prologue).toContain('ulimit -t 5');
    expect(prologue).not.toContain('ulimit -v');
    expect(prologue).not.toContain('ulimit -n');
    expect(prologue).not.toContain('ulimit -c');
  });
});
