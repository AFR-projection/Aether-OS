import { describe, expect, it } from 'vitest';

import { resolveIdentityFrom } from './host-identity.js';

describe('resolveIdentityFrom', () => {
  it('prefers the passwd entry over every fallback', () => {
    const identity = resolveIdentityFrom(
      { username: 'deploy', homedir: '/home/deploy', shell: '/bin/bash' },
      { user: 'fallback-user', home: '/fallback-home', shell: '/bin/sh' }
    );

    expect(identity).toEqual({
      user: 'deploy',
      home: '/home/deploy',
      shell: '/bin/bash',
    });
  });

  it('uses the fallbacks when there is no passwd entry', () => {
    // A uid with no passwd entry: `os.userInfo()` throws and the caller passes
    // null. The terminal must still work.
    const identity = resolveIdentityFrom(null, {
      user: 'aether',
      home: '/opt/aether',
      shell: '/bin/bash',
    });

    expect(identity).toEqual({
      user: 'aether',
      home: '/opt/aether',
      shell: '/bin/bash',
    });
  });

  it('treats a numeric username as no answer', () => {
    // `os.userInfo()` reports the uid as a string when the uid has no passwd
    // entry. Carrying that on as USER and LOGNAME would be a quiet lie about who
    // the shell is.
    const identity = resolveIdentityFrom({ username: '1001' }, { user: 'aether' });
    expect(identity.user).toBe('aether');
  });

  it('treats empty and missing fields as no answer', () => {
    const identity = resolveIdentityFrom(
      { username: '', homedir: null, shell: undefined },
      { user: 'deploy', home: '/home/deploy', shell: '/bin/bash' }
    );

    expect(identity).toEqual({
      user: 'deploy',
      home: '/home/deploy',
      shell: '/bin/bash',
    });
  });

  it('never produces a blank user, home or shell', () => {
    // A blank USER or HOME makes tools misbehave in confusing ways, so the last
    // resort is a real value rather than an empty string.
    const identity = resolveIdentityFrom(null, {});
    expect(identity.user).toBe('aether');
    expect(identity.home).toBe('/');
    expect(identity.shell).toBe('/bin/sh');
  });

  it('overrides only the fields passwd could not answer', () => {
    const identity = resolveIdentityFrom(
      { username: 'deploy', homedir: '', shell: null },
      { user: 'ignored', home: '/home/deploy', shell: '/bin/bash' }
    );

    expect(identity.user).toBe('deploy');
    expect(identity.home).toBe('/home/deploy');
    expect(identity.shell).toBe('/bin/bash');
  });

  it('passes a service account login shell through unchanged', () => {
    // `/usr/sbin/nologin` is a real passwd shell for service accounts. This
    // module reports it honestly and does not silently rewrite it; the
    // allowlist in the caller is what refuses to spawn it.
    const identity = resolveIdentityFrom(
      { username: 'aether-agent', homedir: '/var/lib/aether-agent', shell: '/usr/sbin/nologin' },
      {}
    );

    expect(identity.shell).toBe('/usr/sbin/nologin');
  });
});
