import { describe, expect, it } from 'vitest';

import {
  bootstrapRequestSchema,
  createTerminalBodySchema,
  listDirectoryQuerySchema,
  loginRequestSchema,
  passwordSchema,
  relativePathSchema,
  terminalClientMessageSchema,
  uploadQuerySchema,
  usernameSchema,
  writeFileBodySchema,
} from '../index.js';

describe('usernameSchema', () => {
  it('accepts a normal username', () => {
    expect(usernameSchema.safeParse('aldo').success).toBe(true);
    expect(usernameSchema.safeParse('aldo-2').success).toBe(true);
    expect(usernameSchema.safeParse('a_b').success).toBe(true);
  });

  it('rejects uppercase, spaces, and leading punctuation', () => {
    expect(usernameSchema.safeParse('Aldo').success).toBe(false);
    expect(usernameSchema.safeParse('al do').success).toBe(false);
    expect(usernameSchema.safeParse('-aldo').success).toBe(false);
    expect(usernameSchema.safeParse('aldo!').success).toBe(false);
  });

  it('enforces length bounds', () => {
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('requires at least 12 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('elevenchars').success).toBe(false);
    expect(passwordSchema.safeParse('twelvecharss').success).toBe(true);
  });

  it('accepts a long passphrase with no special characters', () => {
    // Composition rules are deliberately not enforced; length is what matters.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });
});

describe('loginRequestSchema', () => {
  it('accepts a well-formed login', () => {
    const result = loginRequestSchema.safeParse({ username: 'aldo', password: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty password without revealing length rules', () => {
    // The login schema must not apply the 12-character policy: that would leak
    // whether a supplied password could ever have been valid.
    const result = loginRequestSchema.safeParse({ username: 'aldo', password: '' });
    expect(result.success).toBe(false);
    expect(loginRequestSchema.safeParse({ username: 'aldo', password: 'abc' }).success).toBe(true);
  });
});

describe('bootstrapRequestSchema', () => {
  it('applies the full password policy to the account being created', () => {
    expect(
      bootstrapRequestSchema.safeParse({ username: 'owner', password: 'strongpassword' }).success,
    ).toBe(true);
    expect(bootstrapRequestSchema.safeParse({ username: 'owner', password: 'weak' }).success).toBe(false);
  });
});

describe('relativePathSchema', () => {
  it('accepts ordinary relative paths', () => {
    expect(relativePathSchema.safeParse('docs/readme.md').success).toBe(true);
    expect(relativePathSchema.safeParse('a').success).toBe(true);
  });

  it('rejects traversal, absolute, and home-relative paths', () => {
    expect(relativePathSchema.safeParse('../etc/passwd').success).toBe(false);
    expect(relativePathSchema.safeParse('foo/../../etc').success).toBe(false);
    expect(relativePathSchema.safeParse('/etc/passwd').success).toBe(false);
    expect(relativePathSchema.safeParse('~/.ssh/id_rsa').success).toBe(false);
    expect(relativePathSchema.safeParse('C:\\Windows').success).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(relativePathSchema.safeParse('foo\0bar').success).toBe(false);
  });

  it('rejects a backslash traversal', () => {
    expect(relativePathSchema.safeParse('..\\..\\windows').success).toBe(false);
  });

  it('rejects an over-long path', () => {
    expect(relativePathSchema.safeParse('a'.repeat(5000)).success).toBe(false);
  });
});

describe('listDirectoryQuerySchema', () => {
  it('defaults to the root with hidden files shown', () => {
    const result = listDirectoryQuerySchema.parse({});
    expect(result.path).toBe('');
    expect(result.showHidden).toBe(true);
  });

  it('coerces the string query form the browser sends', () => {
    const result = listDirectoryQuerySchema.parse({ path: 'docs', showHidden: 'false' });
    expect(result.showHidden).toBe(false);
  });

  it('accepts every documented truthy spelling', () => {
    expect(listDirectoryQuerySchema.parse({ showHidden: 'true' }).showHidden).toBe(true);
    expect(listDirectoryQuerySchema.parse({ showHidden: '1' }).showHidden).toBe(true);
    expect(listDirectoryQuerySchema.parse({ showHidden: '0' }).showHidden).toBe(false);
  });

  it('rejects an unrecognised boolean spelling instead of guessing', () => {
    // A silent fallback here would let `?showHidden=no` quietly mean "yes".
    expect(listDirectoryQuerySchema.safeParse({ showHidden: 'no' }).success).toBe(false);
    expect(listDirectoryQuerySchema.safeParse({ showHidden: 'yes' }).success).toBe(false);
  });
});

describe('writeFileBodySchema', () => {
  it('defaults encoding to utf8 and createOnly to false', () => {
    const result = writeFileBodySchema.parse({ path: 'a.txt', content: 'hello' });
    expect(result.encoding).toBe('utf8');
    expect(result.createOnly).toBe(false);
  });

  it('rejects a traversal path', () => {
    expect(writeFileBodySchema.safeParse({ path: '../evil', content: 'x' }).success).toBe(false);
  });
});

describe('uploadQuerySchema', () => {
  it('accepts a target directory and file name', () => {
    const result = uploadQuerySchema.parse({ path: 'uploads', name: 'photo.png' });
    expect(result.path).toBe('uploads');
    expect(result.name).toBe('photo.png');
  });

  it('rejects a file name containing path separators', () => {
    expect(uploadQuerySchema.safeParse({ name: '../../etc/cron.d/evil' }).success).toBe(false);
    expect(uploadQuerySchema.safeParse({ name: 'a/b' }).success).toBe(false);
    expect(uploadQuerySchema.safeParse({ name: 'a\\b' }).success).toBe(false);
  });

  it('rejects dot-only file names', () => {
    expect(uploadQuerySchema.safeParse({ name: '.' }).success).toBe(false);
    expect(uploadQuerySchema.safeParse({ name: '..' }).success).toBe(false);
  });
});

describe('createTerminalBodySchema', () => {
  it('defaults to an 80x24 terminal', () => {
    const result = createTerminalBodySchema.parse({});
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('rejects absurd dimensions', () => {
    expect(createTerminalBodySchema.safeParse({ cols: 0, rows: 24 }).success).toBe(false);
    expect(createTerminalBodySchema.safeParse({ cols: 100000, rows: 24 }).success).toBe(false);
  });

  it('rejects a working directory outside the workspace', () => {
    expect(createTerminalBodySchema.safeParse({ cwd: '../../etc' }).success).toBe(false);
  });
});

describe('terminalClientMessageSchema', () => {
  it('accepts each supported frame', () => {
    expect(terminalClientMessageSchema.safeParse({ type: 'input', data: 'ls\n' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ type: 'resize', cols: 120, rows: 40 }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ type: 'signal', signal: 'SIGINT' }).success).toBe(true);
    expect(terminalClientMessageSchema.safeParse({ type: 'ping' }).success).toBe(true);
  });

  it('rejects an unknown frame type', () => {
    expect(terminalClientMessageSchema.safeParse({ type: 'exec', command: 'rm -rf /' }).success).toBe(false);
  });

  it('rejects an unsupported signal', () => {
    expect(terminalClientMessageSchema.safeParse({ type: 'signal', signal: 'SIGUSR1' }).success).toBe(false);
  });

  it('rejects an oversized input frame', () => {
    const data = 'a'.repeat(64 * 1024 + 1);
    expect(terminalClientMessageSchema.safeParse({ type: 'input', data }).success).toBe(false);
  });
});
