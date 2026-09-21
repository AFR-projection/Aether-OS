import { beforeEach, describe, expect, it } from 'vitest';

import { serializeLayout, useDesktopStore, type WindowInstance } from './desktop.store.js';

import type { DesktopLayout } from '@aether/shared';

/**
 * Layout persistence is what lets a desktop survive a reload. These tests cover
 * the two pure halves of it — `serializeLayout` (live windows → saved shape) and
 * the store's `applyLayout` (saved shape → live windows) — and the round trip
 * between them. They need no DOM: the window manager is plain state.
 */

function resetStore(): void {
  useDesktopStore.setState({
    windows: [],
    focusedId: null,
    launcherOpen: false,
    desktopSize: { width: 1280, height: 720 },
    cascadeIndex: 0,
    topZIndex: 10,
  });
}

function windowFixture(overrides: Partial<WindowInstance>): WindowInstance {
  return {
    id: 'x-1',
    appId: 'files',
    title: 'Files',
    bounds: { x: 48, y: 32, width: 900, height: 600 },
    restoreBounds: null,
    zIndex: 11,
    minimized: false,
    props: {},
    ...overrides,
  };
}

beforeEach(resetStore);

describe('serializeLayout', () => {
  it('emits windows back-to-front by z-order and drops app state', () => {
    const windows: WindowInstance[] = [
      windowFixture({ id: 'a', appId: 'settings', title: 'Settings', zIndex: 14, props: { secret: 1 } }),
      windowFixture({ id: 'b', appId: 'files', title: 'Files', zIndex: 12 }),
    ];

    const layout = serializeLayout(windows);

    expect(layout.version).toBe(1);
    // Sorted by ascending zIndex: files (12) before settings (14).
    expect(layout.windows.map((w) => w.appId)).toEqual(['files', 'settings']);
    // No `props`/`id`/`zIndex` leak into the persisted shape.
    expect(Object.keys(layout.windows[0]!)).toEqual([
      'appId',
      'title',
      'bounds',
      'restoreBounds',
      'minimized',
    ]);
  });
});

describe('applyLayout', () => {
  it('reopens the saved windows, appended, in z-order', () => {
    const layout: DesktopLayout = {
      version: 1,
      windows: [
        {
          appId: 'files',
          title: 'Files',
          bounds: { x: 48, y: 32, width: 900, height: 600 },
          restoreBounds: null,
          minimized: false,
        },
        {
          appId: 'settings',
          title: 'Settings',
          bounds: { x: 100, y: 60, width: 700, height: 500 },
          restoreBounds: null,
          minimized: true,
        },
      ],
    };

    useDesktopStore.getState().applyLayout(layout);

    const { windows, focusedId } = useDesktopStore.getState();
    expect(windows.map((w) => w.appId)).toEqual(['files', 'settings']);
    // Second window is stacked above the first.
    expect(windows[1]!.zIndex).toBeGreaterThan(windows[0]!.zIndex);
    // Focus lands on the topmost non-minimised window (files, since settings is minimised).
    expect(focusedId).toBe(windows[0]!.id);
    // Geometry is preserved (it fits the default viewport, so no clamp changes it).
    expect(windows[0]!.bounds).toEqual({ x: 48, y: 32, width: 900, height: 600 });
    expect(windows[1]!.minimized).toBe(true);
  });

  it('skips apps that no longer exist', () => {
    const layout: DesktopLayout = {
      version: 1,
      windows: [
        windowLayoutEntry('files'),
        windowLayoutEntry('an-app-that-was-removed'),
      ],
    };

    useDesktopStore.getState().applyLayout(layout, { isKnownApp: (id) => id === 'files' });

    expect(useDesktopStore.getState().windows.map((w) => w.appId)).toEqual(['files']);
  });

  it('appends to existing windows rather than replacing them', () => {
    useDesktopStore.setState({
      windows: [windowFixture({ id: 'terminal-1', appId: 'terminal', title: 'Terminal', zIndex: 11 })],
      topZIndex: 11,
    });

    useDesktopStore.getState().applyLayout({ version: 1, windows: [windowLayoutEntry('files')] });

    const apps = useDesktopStore.getState().windows.map((w) => w.appId);
    expect(apps).toEqual(['terminal', 'files']);
  });
});

describe('round trip', () => {
  it('serialize then applyLayout reproduces the arrangement', () => {
    const original: WindowInstance[] = [
      windowFixture({ id: 'a', appId: 'files', title: 'Files', zIndex: 12 }),
      windowFixture({
        id: 'b',
        appId: 'settings',
        title: 'Settings',
        zIndex: 15,
        bounds: { x: 120, y: 80, width: 640, height: 480 },
        minimized: true,
      }),
    ];

    const layout = serializeLayout(original);
    useDesktopStore.getState().applyLayout(layout);

    const restored = useDesktopStore.getState().windows;
    expect(restored.map((w) => [w.appId, w.title, w.minimized])).toEqual([
      ['files', 'Files', false],
      ['settings', 'Settings', true],
    ]);
    expect(restored[0]!.bounds).toEqual({ x: 48, y: 32, width: 900, height: 600 });
    expect(restored[1]!.bounds).toEqual({ x: 120, y: 80, width: 640, height: 480 });
  });
});

function windowLayoutEntry(appId: string): DesktopLayout['windows'][number] {
  return {
    appId,
    title: appId,
    bounds: { x: 48, y: 32, width: 900, height: 600 },
    restoreBounds: null,
    minimized: false,
  };
}
