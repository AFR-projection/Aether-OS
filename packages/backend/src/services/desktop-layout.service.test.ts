import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopLayout } from '@aether/shared';

const queryMock = vi.fn();
const queryOneMock = vi.fn();

vi.mock('../db/pool.js', () => ({
  query: queryMock,
  queryOne: queryOneMock,
}));

const { desktopLayoutKey, getDesktopLayout, saveDesktopLayout } = await import(
  './desktop-layout.service.js'
);

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const LAYOUT_A: DesktopLayout = {
  version: 1,
  windows: [
    {
      appId: 'files',
      title: 'Files',
      bounds: { x: 48, y: 32, width: 900, height: 600 },
      restoreBounds: null,
      minimized: false,
    },
  ],
};

beforeEach(() => {
  queryMock.mockReset();
  queryOneMock.mockReset();
});

describe('desktopLayoutKey', () => {
  it('derives a distinct key per user id', () => {
    expect(desktopLayoutKey(USER_A)).toBe(`desktop.layout.${USER_A}`);
    expect(desktopLayoutKey(USER_A)).not.toBe(desktopLayoutKey(USER_B));
  });
});

describe('saveDesktopLayout', () => {
  it('upserts under the caller-derived key and stores the layout as jsonb', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    await saveDesktopLayout(USER_A, LAYOUT_A);

    const call = queryMock.mock.calls.at(-1);
    expect(call).toBeDefined();
    const sql = String(call?.[0]);
    const params = (call?.[1] ?? []) as unknown[];

    expect(sql).toContain('INSERT INTO aether.settings');
    expect(sql).toContain('ON CONFLICT (key) DO UPDATE');
    // The key and updated_by are the user's id — never anything from the body.
    expect(params[0]).toBe(desktopLayoutKey(USER_A));
    expect(params[2]).toBe(USER_A);
    expect(JSON.parse(String(params[1]))).toEqual(LAYOUT_A);
  });
});

describe('getDesktopLayout', () => {
  it('reads the caller-derived key and returns the stored layout', async () => {
    queryOneMock.mockResolvedValue({ value: LAYOUT_A });

    const layout = await getDesktopLayout(USER_A);

    const params = (queryOneMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];
    expect(params[0]).toBe(desktopLayoutKey(USER_A));
    expect(layout).toEqual(LAYOUT_A);
  });

  it('returns null when the user has no saved layout', async () => {
    queryOneMock.mockResolvedValue(null);
    expect(await getDesktopLayout(USER_B)).toBeNull();
  });
});

describe('isolation between users', () => {
  it('never lets one user read or write another user’s layout', async () => {
    // User A saves; the write is scoped to A's key.
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    await saveDesktopLayout(USER_A, LAYOUT_A);
    const writeParams = (queryMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];
    expect(writeParams[0]).toBe(desktopLayoutKey(USER_A));

    // User B reads; the read is scoped to B's key, and the store has nothing
    // for B, so B sees null rather than A's windows.
    queryOneMock.mockResolvedValue(null);
    const forB = await getDesktopLayout(USER_B);
    const readParams = (queryOneMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];
    expect(readParams[0]).toBe(desktopLayoutKey(USER_B));
    expect(forB).toBeNull();
  });
});
