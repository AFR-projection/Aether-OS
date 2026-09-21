import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TERM,
  SYSTEM_PATH,
  buildShellArgv,
  buildShellEnvironment,
  type ShellIdentity,
} from './execution-environment.js';

const IDENTITY: ShellIdentity = {
  user: 'deploy',
  home: '/home/deploy',
  shell: '/bin/bash',
};

const CWD = '/srv/app';

function build(
  overrides: Partial<ShellIdentity> = {},
  ambient: Record<string, string | undefined> = {}
): Record<string, string> {
  return buildShellEnvironment({ ...IDENTITY, ...overrides }, { cwd: CWD, ambient });
}

describe('buildShellArgv', () => {
  it('asks for a login shell when there is no command', () => {
    expect(buildShellArgv()).toEqual(['-l']);
  });

  it('treats an empty command as no command', () => {
    expect(buildShellArgv('')).toEqual(['-l']);
  });

  it('keeps the login flag when running one command', () => {
    // Code Studio's Run panel goes through this path. A `-c` without `-l` is a
    // non-login shell, which is the entire defect: it would not see the tools
    // the user's own shell sees.
    expect(buildShellArgv('node main.js')).toEqual(['-l', '-c', 'node main.js']);
  });
});

describe('buildShellEnvironment', () => {
  it('reports the identity the host gave it', () => {
    const env = build();
    expect(env['USER']).toBe('deploy');
    expect(env['LOGNAME']).toBe('deploy');
    expect(env['HOME']).toBe('/home/deploy');
    expect(env['SHELL']).toBe('/bin/bash');
  });

  it('sets PWD to the directory the process starts in, not to the home', () => {
    const env = build();
    expect(env['PWD']).toBe(CWD);
    expect(env['PWD']).not.toBe(IDENTITY.home);
  });

  it('starts PATH at the stock system path', () => {
    expect(build()['PATH']).toBe(SYSTEM_PATH);
  });

  it('does not add any user-local or tool-specific directory to PATH', () => {
    // This is the rule that keeps the fix architectural rather than a patch.
    // `~/.local/bin` and the runtime-manager directories must arrive because the
    // host's own login files add them, never because this file names them.
    const path = build()['PATH'] ?? '';
    expect(path).not.toContain('.local/bin');
    expect(path).not.toContain('.cargo');
    expect(path).not.toContain('.nvm');
    expect(path).not.toContain('.pyenv');
    expect(path).not.toContain('claude');
  });

  it('does not carry a stale PATH from the spawning process', () => {
    // The daemon's PATH is the systemd service path. Inheriting it is how the
    // terminal ends up with an environment nobody's login ever produced.
    const env = build({}, { PATH: '/daemon/only/bin' });
    expect(env['PATH']).toBe(SYSTEM_PATH);
    expect(env['PATH']).not.toContain('/daemon/only/bin');
  });

  it('defaults the terminal type and allows an override', () => {
    expect(build()['TERM']).toBe(DEFAULT_TERM);
    const custom = buildShellEnvironment(IDENTITY, {
      cwd: CWD,
      ambient: {},
      term: 'screen-256color',
    });
    expect(custom['TERM']).toBe('screen-256color');
  });

  describe('the inheritance allowlist', () => {
    it('carries the named non-sensitive variables through', () => {
      const env = build({}, { LANG: 'en_GB.UTF-8', TZ: 'Asia/Jakarta' });
      expect(env['LANG']).toBe('en_GB.UTF-8');
      expect(env['TZ']).toBe('Asia/Jakarta');
    });

    it('skips a variable the spawning process does not set', () => {
      expect(build()['LANG']).toBeUndefined();
    });

    it('skips a variable that is set to the empty string', () => {
      expect(build({}, { LANG: '' })['LANG']).toBeUndefined();
    });

    it('does not leak the agent pairing token', () => {
      // The agent process holds this to authenticate to the backend, and a shell
      // running as the same user could otherwise read it with one `env`.
      const env = build({}, { AETHER_PAIRING_TOKEN: 'super-secret-token' });
      expect(env['AETHER_PAIRING_TOKEN']).toBeUndefined();
      expect(Object.values(env)).not.toContain('super-secret-token');
    });

    it('does not leak the backend secrets', () => {
      const env = build(
        {},
        {
          DATABASE_URL: 'postgresql://user:pw@host/db',
          JWT_SECRET: 'jwt-secret-value',
          ENCRYPTION_KEY: 'encryption-key-value',
        }
      );
      expect(Object.values(env)).not.toContain('postgresql://user:pw@host/db');
      expect(Object.values(env)).not.toContain('jwt-secret-value');
      expect(Object.values(env)).not.toContain('encryption-key-value');
      expect(Object.keys(env)).not.toContain('DATABASE_URL');
      expect(Object.keys(env)).not.toContain('JWT_SECRET');
      expect(Object.keys(env)).not.toContain('ENCRYPTION_KEY');
    });

    it('carries nothing from a wholesale environment', () => {
      // A blunt check on the shape of the rule: every key present is either one
      // this module derives or one it names in the allowlist.
      const ambient: Record<string, string> = {};
      for (let i = 0; i < 200; i += 1) ambient[`AMBIENT_${i}`] = `value-${i}`;
      const env = build({}, ambient);
      expect(Object.keys(env).some((key) => key.startsWith('AMBIENT_'))).toBe(false);
    });
  });
});
