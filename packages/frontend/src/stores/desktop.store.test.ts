import { beforeEach, describe, expect, it } from 'vitest';

import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  resizeBounds,
  serializeLayout,
  snapZoneBounds,
  snapZoneForPointer,
  useDesktopStore,
  type SnapZone,
  type WindowBounds,
  type WindowInstance,
} from './desktop.store.js';

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
    snapPreview: null,
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
      windowFixture({
        id: 'a',
        appId: 'settings',
        title: 'Settings',
        zIndex: 14,
        props: { secret: 1 },
      }),
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
      windows: [windowLayoutEntry('files'), windowLayoutEntry('an-app-that-was-removed')],
    };

    useDesktopStore.getState().applyLayout(layout, { isKnownApp: (id) => id === 'files' });

    expect(useDesktopStore.getState().windows.map((w) => w.appId)).toEqual(['files']);
  });

  it('appends to existing windows rather than replacing them', () => {
    useDesktopStore.setState({
      windows: [
        windowFixture({ id: 'terminal-1', appId: 'terminal', title: 'Terminal', zIndex: 11 }),
      ],
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

/**
 * Edge and corner resizing. The geometry is `resizeBounds` — pure, so the parts
 * that are easy to get subtly wrong (an origin that moves with the edge, a
 * minimum size that pins the opposite edge) are asserted directly rather than
 * inferred from a rendered window.
 */
describe('resizeBounds', () => {
  const origin: WindowBounds = { x: 100, y: 100, width: 400, height: 300 };

  it('grows east without moving the origin', () => {
    expect(resizeBounds(origin, 'e', 50, 0)).toEqual({ x: 100, y: 100, width: 450, height: 300 });
  });

  it('grows south without moving the origin', () => {
    expect(resizeBounds(origin, 's', 0, 40)).toEqual({ x: 100, y: 100, width: 400, height: 340 });
  });

  it('moves the origin west as it widens leftward', () => {
    // Dragging the left edge 60px left: x drops by 60, width grows by 60, the
    // right edge (x+width = 500) stays put.
    const next = resizeBounds(origin, 'w', -60, 0);
    expect(next).toEqual({ x: 40, y: 100, width: 460, height: 300 });
    expect(next.x + next.width).toBe(origin.x + origin.width);
  });

  it('moves the origin north as it grows upward', () => {
    const next = resizeBounds(origin, 'n', 0, -50);
    expect(next).toEqual({ x: 100, y: 50, width: 400, height: 350 });
    expect(next.y + next.height).toBe(origin.y + origin.height);
  });

  it('resizes both axes from a corner', () => {
    expect(resizeBounds(origin, 'se', 30, 20)).toEqual({
      x: 100,
      y: 100,
      width: 430,
      height: 320,
    });
  });

  it('pins the right edge when a west drag hits the minimum width', () => {
    // Drag the left edge far past the minimum. Width clamps to MIN and x stops
    // at right - MIN rather than overshooting into an inside-out window.
    const next = resizeBounds(origin, 'w', 10_000, 0);
    expect(next.width).toBe(MIN_WINDOW_WIDTH);
    expect(next.x).toBe(origin.x + origin.width - MIN_WINDOW_WIDTH);
  });

  it('pins the bottom edge when a north drag hits the minimum height', () => {
    const next = resizeBounds(origin, 'n', 0, 10_000);
    expect(next.height).toBe(MIN_WINDOW_HEIGHT);
    expect(next.y).toBe(origin.y + origin.height - MIN_WINDOW_HEIGHT);
  });
});

describe('setWindowBounds', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: [windowFixture({ id: 'w-1', bounds: { x: 100, y: 100, width: 400, height: 300 } })],
      desktopSize: { width: 1280, height: 720 },
    });
  });

  it('applies new geometry to the named window', () => {
    useDesktopStore.getState().setWindowBounds('w-1', { x: 200, y: 150, width: 500, height: 350 });
    expect(useDesktopStore.getState().windows[0]!.bounds).toEqual({
      x: 200,
      y: 150,
      width: 500,
      height: 350,
    });
  });

  it('clamps a size larger than the viewport down to it', () => {
    useDesktopStore.getState().setWindowBounds('w-1', { x: 0, y: 0, width: 5000, height: 5000 });
    const { bounds } = useDesktopStore.getState().windows[0]!;
    expect(bounds.width).toBe(1280);
    expect(bounds.height).toBe(720);
  });

  it('never shrinks a window below the minimum', () => {
    useDesktopStore.getState().setWindowBounds('w-1', { x: 100, y: 100, width: 10, height: 10 });
    const { bounds } = useDesktopStore.getState().windows[0]!;
    expect(bounds.width).toBe(MIN_WINDOW_WIDTH);
    expect(bounds.height).toBe(MIN_WINDOW_HEIGHT);
  });
});

/**
 * Window snapping. `snapZoneBounds` is pure geometry — the split must leave no
 * seam and no overlap — and `snapZoneForPointer` is the pure edge-detection that
 * arms a zone during a drag. `snapWindow` mutates the store, so its restore-bounds
 * behaviour (a half is a plain window; a maximise can be un-maximised) is asserted
 * against real state.
 */
describe('snapZoneBounds', () => {
  const desktop = { width: 1280, height: 720 };

  it('splits the two halves with no seam and no overlap', () => {
    const left = snapZoneBounds('left', desktop);
    const right = snapZoneBounds('right', desktop);
    // The right half begins exactly where the left ends, and together they
    // cover the full width.
    expect(left.x + left.width).toBe(right.x);
    expect(left.width + right.width).toBe(desktop.width);
    expect(left.height).toBe(desktop.height);
    expect(right.height).toBe(desktop.height);
  });

  it('places the four quarters so they tile the desktop exactly', () => {
    const tl = snapZoneBounds('top-left', desktop);
    const tr = snapZoneBounds('top-right', desktop);
    const bl = snapZoneBounds('bottom-left', desktop);
    const br = snapZoneBounds('bottom-right', desktop);
    // Widths and heights of adjacent quarters meet with no gap.
    expect(tl.x + tl.width).toBe(tr.x);
    expect(tl.y + tl.height).toBe(bl.y);
    expect(tl.width + tr.width).toBe(desktop.width);
    expect(tl.height + bl.height).toBe(desktop.height);
    // Bottom-right closes the far corner.
    expect(br.x + br.width).toBe(desktop.width);
    expect(br.y + br.height).toBe(desktop.height);
  });

  it('maximise fills the desktop', () => {
    expect(snapZoneBounds('maximize', desktop)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });
});

describe('snapZoneForPointer', () => {
  const desktop = { width: 1000, height: 800 };

  it('arms nothing away from the edges', () => {
    expect(snapZoneForPointer(500, 400, desktop)).toBeNull();
  });

  it('arms the halves on the left and right edges', () => {
    expect(snapZoneForPointer(4, 400, desktop)).toBe('left');
    expect(snapZoneForPointer(996, 400, desktop)).toBe('right');
  });

  it('arms maximise on the top edge', () => {
    expect(snapZoneForPointer(500, 2, desktop)).toBe('maximize');
  });

  it('prefers the corner quarter over the edge it shares', () => {
    expect(snapZoneForPointer(2, 2, desktop)).toBe('top-left');
    expect(snapZoneForPointer(998, 2, desktop)).toBe('top-right');
    expect(snapZoneForPointer(2, 798, desktop)).toBe('bottom-left');
    expect(snapZoneForPointer(998, 798, desktop)).toBe('bottom-right');
  });

  it('never arms on the bottom edge alone (where the taskbar lives)', () => {
    expect(snapZoneForPointer(500, 798, desktop)).toBeNull();
  });
});

describe('snapWindow', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: [windowFixture({ id: 'w-1', bounds: { x: 100, y: 100, width: 400, height: 300 } })],
      desktopSize: { width: 1280, height: 720 },
    });
  });

  it('snaps to the left half as a plain floating window', () => {
    useDesktopStore.getState().snapWindow('w-1', 'left');
    const window = useDesktopStore.getState().windows[0]!;
    expect(window.bounds).toEqual({ x: 0, y: 0, width: 640, height: 720 });
    // A half is not "maximised", so there is no restore geometry to return to.
    expect(window.restoreBounds).toBeNull();
  });

  it('records restore bounds when snapping to maximise, and can be un-maximised', () => {
    useDesktopStore.getState().snapWindow('w-1', 'maximize');
    let window = useDesktopStore.getState().windows[0]!;
    expect(window.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(window.restoreBounds).toEqual({ x: 100, y: 100, width: 400, height: 300 });

    // toggleMaximize restores the pre-snap geometry.
    useDesktopStore.getState().toggleMaximize('w-1');
    window = useDesktopStore.getState().windows[0]!;
    expect(window.bounds).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(window.restoreBounds).toBeNull();
  });

  it('drops restore bounds when snapping a maximised window to a half', () => {
    useDesktopStore.getState().snapWindow('w-1', 'maximize');
    useDesktopStore.getState().snapWindow('w-1', 'right');
    const window = useDesktopStore.getState().windows[0]!;
    expect(window.bounds).toEqual({ x: 640, y: 0, width: 640, height: 720 });
    expect(window.restoreBounds).toBeNull();
  });
});

describe('setSnapPreview', () => {
  it('sets and clears the armed zone', () => {
    const zones: SnapZone[] = ['left', 'right', 'maximize'];
    for (const zone of zones) {
      useDesktopStore.getState().setSnapPreview(zone);
      expect(useDesktopStore.getState().snapPreview).toBe(zone);
    }
    useDesktopStore.getState().setSnapPreview(null);
    expect(useDesktopStore.getState().snapPreview).toBeNull();
  });
});
