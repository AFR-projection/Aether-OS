import { describe, expect, it } from 'vitest';

import {
  RLIMIT_UNHONOURED_EXIT,
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

  it('sets both the soft and the hard limit — the setting command carries no -S or -H', () => {
    // This is the whole point: `ulimit -v <n>` with no flag sets both, so the
    // value is a ceiling the process cannot raise again. A `-S` would set only
    // the soft limit, which the child could raise back to the (unset) hard one.
    const prologue = buildRlimitPrologue(
      rlimits({ addressSpaceBytes: 256 * 1024 * 1024, cpuSeconds: 10 })
    );
    // Split into statements so the assertion is about the *setting* commands,
    // not about the read-back that follows each one and does name `-H`.
    const setters = prologue
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('ulimit '));
    expect(setters.length).toBeGreaterThan(0);
    for (const setter of setters) {
      expect(setter).not.toContain('-S');
      expect(setter).not.toContain('-H');
    }
    expect(prologue).toContain('ulimit -v ');
    expect(prologue).toContain('ulimit -t ');
  });

  it("converts byte inputs to the shell's 1024-byte units", () => {
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
    expect(buildRlimitPrologue(rlimits({ addressSpaceBytes: 1024 + 1 }))).toContain('ulimit -v 2');
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

  describe('a bound that cannot be applied ends the unit instead of running unbounded', () => {
    // This is the difference between a bound and a belief. A shell that cannot
    // set a limit may report an error — or, as Cygwin's `ulimit -n` does, report
    // success and change nothing. So each limit is set, then read back and
    // compared; a check that only trusted the exit status would miss the second
    // case entirely.

    it('sets and then verifies every limit — two guards each, not one for the group', () => {
      const prologue = buildRlimitPrologue(
        rlimits({
          addressSpaceBytes: 1024 * 1024,
          cpuSeconds: 60,
          maxOpenFiles: 128,
          coreDumpBytes: 0,
        })
      );
      const guards = prologue.match(/\|\| exit \d+/g) ?? [];
      // Four limits × (set, verify). One guard for the whole group would let
      // three of four failures pass unnoticed.
      expect(guards).toHaveLength(8);
    });

    it('compares the hard limit that was actually set, after setting it', () => {
      const prologue = buildRlimitPrologue(rlimits({ maxOpenFiles: 128 }));
      // The read-back must come after the set, and must read the *hard* limit —
      // a soft-limit check would pass for a process that can raise it back.
      const setAt = prologue.indexOf('ulimit -n 128');
      const readAt = prologue.indexOf('ulimit -Hn');
      expect(setAt).toBeGreaterThanOrEqual(0);
      expect(readAt).toBeGreaterThan(setAt);
    });

    it('fails only when the host ends up more permissive than asked for', () => {
      // `-le`, not `-eq`: a host whose own hard limit is lower gives a tighter
      // ceiling, which still honours a request for "no more than N".
      const prologue = buildRlimitPrologue(rlimits({ cpuSeconds: 7 }));
      expect(prologue).toContain('-le 7');
    });

    it('uses the reserved status for "Aether could not honour the request"', () => {
      const prologue = buildRlimitPrologue(rlimits({ cpuSeconds: 5 }));
      expect(prologue).toContain(`|| exit ${RLIMIT_UNHONOURED_EXIT}`);
      // 125 is the conventional "the command could not be executed" status, so
      // it is distinguishable from the command's own failure codes.
      expect(RLIMIT_UNHONOURED_EXIT).toBe(125);
    });

    it('still emits nothing at all when no bound was requested', () => {
      // The guard must not appear for a unit that asked for no limits, or every
      // unit would gain a failure mode it never opted into.
      expect(buildRlimitPrologue(NONE)).toBe('');
    });
  });
});
