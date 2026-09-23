import { DESKTOP_LAYOUT_VERSION, type DesktopLayout, type PersistedWindow } from '@aether/shared';
import { create } from 'zustand';

/**
 * Window manager state.
 *
 * This is the whole of the desktop's layout logic: which windows exist, where
 * they are, and which one is on top. It deliberately holds no application data
 * — an app's own state lives in its component or in TanStack Query, so closing
 * a window discards it and reopening gives a clean instance.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInstance {
  id: string;
  appId: string;
  title: string;
  bounds: WindowBounds;
  /** Geometry to return to when un-maximising. Null when not maximised. */
  restoreBounds: WindowBounds | null;
  zIndex: number;
  minimized: boolean;
  /** Props handed to the app component, e.g. `{ sessionId }` for a terminal. */
  props: Record<string, unknown>;
}

export interface OpenWindowOptions {
  title?: string;
  props?: Record<string, unknown>;
  width?: number;
  height?: number;
  /**
   * When true, opening the app focuses its existing window instead of creating
   * a second one. Apps that represent a single resource (Settings, Task
   * Manager) are singletons; apps that open one window per item (Terminal,
   * Files, Code Studio) are not.
   */
  singleton?: boolean;
}

export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 240;

interface DesktopState {
  windows: WindowInstance[];
  /** Id of the focused window, or null when nothing has focus. */
  focusedId: string | null;
  /** Whether the app launcher overlay is visible. */
  launcherOpen: boolean;
  /** Usable desktop area, excluding the taskbar. Updated on resize. */
  desktopSize: { width: number; height: number };
  /** Offset applied to each successive window so they do not stack exactly. */
  cascadeIndex: number;
  topZIndex: number;
  /**
   * The snap zone a title-bar drag is currently hovering, or null. Transient UI
   * state — never persisted — that lets the desktop paint a preview of where the
   * window will land before the pointer is released.
   */
  snapPreview: SnapZone | null;

  setLauncherOpen: (open: boolean) => void;
  setDesktopSize: (width: number, height: number) => void;
  openWindow: (appId: string, options?: OpenWindowOptions) => string;
  closeWindow: (id: string) => void;
  closeAll: () => void;
  focusWindow: (id: string) => void;
  /**
   * Moves focus to the next (`1`) or previous (`-1`) window, cycling through the
   * non-minimised windows in creation order — the stable order the taskbar shows
   * — so repeated presses walk every window rather than toggling two. A no-op
   * with fewer than two visible windows.
   */
  cycleFocus: (direction: 1 | -1) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  toggleMinimize: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  resizeWindow: (id: string, width: number, height: number) => void;
  /**
   * Sets a window's full geometry at once, clamped to the viewport. Used by
   * edge/corner resizing, where the origin moves as the size changes (dragging
   * the left edge grows the window leftward), which the width/height-only
   * `resizeWindow` cannot express.
   */
  setWindowBounds: (id: string, bounds: WindowBounds) => void;
  toggleMaximize: (id: string) => void;
  /**
   * Snaps a window to a half, quarter, or maximise. `maximize` goes through the
   * maximise path (records `restoreBounds` so it can be un-maximised); the
   * halves and quarters become ordinary floating windows at the zone.
   */
  snapWindow: (id: string, zone: SnapZone) => void;
  /** Sets (or clears, with null) the live snap-preview zone during a drag. */
  setSnapPreview: (zone: SnapZone | null) => void;
  setWindowTitle: (id: string, title: string) => void;
  setWindowProps: (id: string, props: Record<string, unknown>) => void;
  /**
   * Reopens the windows in a saved layout, appended to whatever is already on
   * the desktop. Geometry is clamped to the current viewport; unknown apps are
   * skipped (via `isKnownApp`) so a layout saved before an app was removed does
   * not create a blank window. Application state is not restored — props are
   * empty — which is why terminals are persisted and recovered separately.
   */
  applyLayout: (
    layout: DesktopLayout,
    options?: { isKnownApp?: (appId: string) => boolean }
  ) => void;
}

const CASCADE_STEP = 28;
const CASCADE_WRAP = 8;

let windowCounter = 0;

function nextWindowId(appId: string): string {
  windowCounter += 1;
  return `${appId}-${windowCounter}`;
}

/** Clamps a window so a dragged title bar cannot leave it unreachable. */
function clampPosition(
  bounds: WindowBounds,
  desktop: { width: number; height: number }
): WindowBounds {
  // At least this much of the window must remain on screen, so it can always be
  // grabbed again even if the user drags it towards an edge.
  const visible = 80;
  return {
    ...bounds,
    x: Math.min(
      Math.max(bounds.x, -(bounds.width - visible)),
      Math.max(desktop.width - visible, 0)
    ),
    y: Math.min(Math.max(bounds.y, 0), Math.max(desktop.height - 40, 0)),
  };
}

/** The edge or corner a resize drag is anchored to. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * A snap target: the halves and quarters every desktop offers, plus maximise.
 * `maximize` is handled through the existing maximise path (it records
 * `restoreBounds`); the halves and quarters are ordinary floating windows placed
 * at the zone, so they can then be resized or dragged away freely.
 */
export type SnapZone =
  'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize';

/**
 * The bounds a snap zone occupies in the desktop area.
 *
 * Halves split on the floor so the two sides meet with no seam and no overlap:
 * the right half starts exactly where the left half ends. Pure, so the split is
 * asserted rather than eyeballed.
 */
export function snapZoneBounds(
  zone: SnapZone,
  desktop: { width: number; height: number }
): WindowBounds {
  const leftW = Math.floor(desktop.width / 2);
  const rightW = desktop.width - leftW;
  const topH = Math.floor(desktop.height / 2);
  const bottomH = desktop.height - topH;

  switch (zone) {
    case 'maximize':
      return { x: 0, y: 0, width: desktop.width, height: desktop.height };
    case 'left':
      return { x: 0, y: 0, width: leftW, height: desktop.height };
    case 'right':
      return { x: leftW, y: 0, width: rightW, height: desktop.height };
    case 'top-left':
      return { x: 0, y: 0, width: leftW, height: topH };
    case 'top-right':
      return { x: leftW, y: 0, width: rightW, height: topH };
    case 'bottom-left':
      return { x: 0, y: topH, width: leftW, height: bottomH };
    case 'bottom-right':
      return { x: leftW, y: topH, width: rightW, height: bottomH };
  }
}

/** How close (px) a drag must be to an edge before that edge's zone arms. */
export const SNAP_EDGE_THRESHOLD = 32;

/**
 * The snap zone a title-bar drag at `(px, py)` — coordinates relative to the
 * desktop area — is hovering, or null when it is not near an edge.
 *
 * Pure so the region maths is asserted rather than eyeballed. Corners win over
 * edges (a drag into the top-left corner quarters rather than maximising), and
 * the bottom edge alone arms nothing: on every OS the bottom edge is where the
 * taskbar lives, so dragging onto it must not snap.
 */
export function snapZoneForPointer(
  px: number,
  py: number,
  desktop: { width: number; height: number },
  threshold = SNAP_EDGE_THRESHOLD
): SnapZone | null {
  const nearLeft = px <= threshold;
  const nearRight = px >= desktop.width - threshold;
  const nearTop = py <= threshold;
  const nearBottom = py >= desktop.height - threshold;

  if (nearTop && nearLeft) return 'top-left';
  if (nearTop && nearRight) return 'top-right';
  if (nearBottom && nearLeft) return 'bottom-left';
  if (nearBottom && nearRight) return 'bottom-right';
  if (nearTop) return 'maximize';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  return null;
}

/**
 * New bounds when dragging `edge` by `(dx, dy)` from a captured `origin`.
 *
 * Pure geometry, so the fiddly part is tested rather than eyeballed: an edge
 * that moves the origin (west grows leftward, north grows upward) must keep the
 * *opposite* edge pinned, and the minimum size has to hold without letting the
 * moving edge cross the pinned one — otherwise a fast drag past the minimum
 * flips the window inside out. The viewport clamp is applied separately by
 * `setWindowBounds`; this function only resolves the drag.
 */
export function resizeBounds(
  origin: WindowBounds,
  edge: ResizeEdge,
  dx: number,
  dy: number
): WindowBounds {
  let { x, y, width, height } = origin;
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  if (edge.includes('e')) width = origin.width + dx;
  if (edge.includes('s')) height = origin.height + dy;
  if (edge.includes('w')) {
    width = origin.width - dx;
    x = origin.x + dx;
  }
  if (edge.includes('n')) {
    height = origin.height - dy;
    y = origin.y + dy;
  }

  if (width < MIN_WINDOW_WIDTH) {
    width = MIN_WINDOW_WIDTH;
    // A west drag anchors the right edge, so the left edge stops at right - min.
    if (edge.includes('w')) x = right - MIN_WINDOW_WIDTH;
  }
  if (height < MIN_WINDOW_HEIGHT) {
    height = MIN_WINDOW_HEIGHT;
    if (edge.includes('n')) y = bottom - MIN_WINDOW_HEIGHT;
  }

  return { x, y, width, height };
}

function clampSize(bounds: WindowBounds, desktop: { width: number; height: number }): WindowBounds {
  return {
    ...bounds,
    width: Math.max(
      MIN_WINDOW_WIDTH,
      Math.min(bounds.width, Math.max(desktop.width, MIN_WINDOW_WIDTH))
    ),
    height: Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(bounds.height, Math.max(desktop.height, MIN_WINDOW_HEIGHT))
    ),
  };
}

export const useDesktopStore = create<DesktopState>((set, get) => ({
  windows: [],
  focusedId: null,
  launcherOpen: false,
  desktopSize: { width: 1280, height: 720 },
  cascadeIndex: 0,
  topZIndex: 10,
  snapPreview: null,

  setLauncherOpen: (open) => set({ launcherOpen: open }),

  setDesktopSize: (width, height) => {
    set((state) => ({
      desktopSize: { width, height },
      // A window that was sized against a larger viewport must shrink with it,
      // otherwise it becomes impossible to see its own controls.
      windows: state.windows.map((window) => ({
        ...window,
        bounds: clampPosition(clampSize(window.bounds, { width, height }), { width, height }),
      })),
    }));
  },

  openWindow: (appId, options = {}) => {
    const { singleton = true, props = {}, width = 900, height = 600, title } = options;
    const state = get();

    if (singleton) {
      const existing = state.windows.find((window) => window.appId === appId);
      if (existing) {
        get().focusWindow(existing.id);
        return existing.id;
      }
    }

    const desktop = state.desktopSize;
    const offset = (state.cascadeIndex % CASCADE_WRAP) * CASCADE_STEP;
    const bounds = clampSize(
      clampPosition({ x: 48 + offset, y: 32 + offset, width, height }, desktop),
      desktop
    );

    const id = nextWindowId(appId);
    const zIndex = state.topZIndex + 1;

    set((current) => ({
      windows: [
        ...current.windows,
        {
          id,
          appId,
          title: title ?? appId,
          bounds,
          restoreBounds: null,
          zIndex,
          minimized: false,
          props,
        },
      ],
      focusedId: id,
      topZIndex: zIndex,
      cascadeIndex: current.cascadeIndex + 1,
    }));

    return id;
  },

  closeWindow: (id) => {
    set((state) => {
      const remaining = state.windows.filter((window) => window.id !== id);

      if (state.focusedId !== id) {
        return { windows: remaining };
      }

      // Focus falls to the topmost remaining non-minimised window, which is
      // what a user expects after closing the window they were using.
      const candidate = remaining
        .filter((window) => !window.minimized)
        .sort((a, b) => b.zIndex - a.zIndex)[0];

      return { windows: remaining, focusedId: candidate?.id ?? null };
    });
  },

  closeAll: () => set({ windows: [], focusedId: null }),

  focusWindow: (id) => {
    const state = get();
    const target = state.windows.find((window) => window.id === id);
    if (!target) return;

    // Already on top and visible: nothing to change, so no re-render.
    if (state.focusedId === id && !target.minimized && target.zIndex === state.topZIndex) return;

    const zIndex = state.topZIndex + 1;
    set({
      focusedId: id,
      topZIndex: zIndex,
      windows: state.windows.map((window) =>
        window.id === id ? { ...window, zIndex, minimized: false } : window
      ),
    });
  },

  cycleFocus: (direction) => {
    const state = get();
    // Creation order (the array order) is stable while cycling; z-order is not,
    // because focusing raises the target, which would collapse the walk into a
    // two-window toggle.
    const visible = state.windows.filter((window) => !window.minimized);
    if (visible.length < 2) return;

    const current = visible.findIndex((window) => window.id === state.focusedId);
    const from = current < 0 ? 0 : current;
    const next = (from + direction + visible.length) % visible.length;
    get().focusWindow(visible[next]!.id);
  },

  minimizeWindow: (id) => {
    set((state) => {
      const remaining = state.windows.filter((window) => window.id !== id && !window.minimized);
      const candidate = remaining.sort((a, b) => b.zIndex - a.zIndex)[0];

      return {
        windows: state.windows.map((window) =>
          window.id === id ? { ...window, minimized: true } : window
        ),
        focusedId: state.focusedId === id ? (candidate?.id ?? null) : state.focusedId,
      };
    });
  },

  restoreWindow: (id) => {
    get().focusWindow(id);
  },

  toggleMinimize: (id) => {
    const target = get().windows.find((window) => window.id === id);
    if (!target) return;

    if (target.minimized) {
      get().focusWindow(id);
    } else if (get().focusedId === id) {
      get().minimizeWindow(id);
    } else {
      get().focusWindow(id);
    }
  },

  moveWindow: (id, x, y) => {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, bounds: clampPosition({ ...window.bounds, x, y }, state.desktopSize) }
          : window
      ),
    }));
  },

  resizeWindow: (id, width, height) => {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, bounds: clampSize({ ...window.bounds, width, height }, state.desktopSize) }
          : window
      ),
    }));
  },

  setWindowBounds: (id, bounds) => {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              bounds: clampPosition(clampSize(bounds, state.desktopSize), state.desktopSize),
            }
          : window
      ),
    }));
  },

  toggleMaximize: (id) => {
    set((state) => ({
      windows: state.windows.map((window) => {
        if (window.id !== id) return window;

        if (window.restoreBounds !== null) {
          return {
            ...window,
            bounds: clampSize(
              clampPosition(window.restoreBounds, state.desktopSize),
              state.desktopSize
            ),
            restoreBounds: null,
          };
        }

        return {
          ...window,
          restoreBounds: window.bounds,
          bounds: { x: 0, y: 0, width: state.desktopSize.width, height: state.desktopSize.height },
        };
      }),
    }));
  },

  snapWindow: (id, zone) => {
    if (zone === 'maximize') {
      set((state) => ({
        windows: state.windows.map((window) => {
          if (window.id !== id) return window;
          // Already maximised: leave it. Otherwise record the floating bounds so
          // the window can be restored, matching `toggleMaximize`.
          if (window.restoreBounds !== null) return window;
          return {
            ...window,
            restoreBounds: window.bounds,
            bounds: {
              x: 0,
              y: 0,
              width: state.desktopSize.width,
              height: state.desktopSize.height,
            },
          };
        }),
      }));
      return;
    }

    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? {
              ...window,
              // A half/quarter is a normal floating window at the zone, so a
              // previously-maximised window drops its restore bounds here.
              restoreBounds: null,
              bounds: clampSize(snapZoneBounds(zone, state.desktopSize), state.desktopSize),
            }
          : window
      ),
    }));
  },

  setSnapPreview: (zone) => {
    // Avoid a re-render when the armed zone has not actually changed — the drag
    // handler calls this on every pointer move.
    if (get().snapPreview === zone) return;
    set({ snapPreview: zone });
  },

  setWindowTitle: (id, title) => {
    set((state) => ({
      windows: state.windows.map((window) => (window.id === id ? { ...window, title } : window)),
    }));
  },

  setWindowProps: (id, props) => {
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id ? { ...window, props: { ...window.props, ...props } } : window
      ),
    }));
  },

  applyLayout: (layout, options = {}) => {
    const isKnownApp = options.isKnownApp ?? ((): boolean => true);

    set((state) => {
      const desktop = state.desktopSize;
      let zIndex = state.topZIndex;
      const added: WindowInstance[] = [];

      // Back-to-front: the array is already in z-order, so each window opened
      // later sits above the previous one, reproducing the saved stack.
      for (const persisted of layout.windows) {
        if (!isKnownApp(persisted.appId)) continue;

        zIndex += 1;
        added.push({
          id: nextWindowId(persisted.appId),
          appId: persisted.appId,
          title: persisted.title,
          bounds: clampPosition(clampSize(persisted.bounds, desktop), desktop),
          restoreBounds:
            persisted.restoreBounds === null
              ? null
              : clampPosition(clampSize(persisted.restoreBounds, desktop), desktop),
          zIndex,
          minimized: persisted.minimized,
          props: {},
        });
      }

      if (added.length === 0) return state;

      // Focus the topmost restored window that is not minimised, matching what a
      // user sees after arranging their desktop by hand.
      const focused = added
        .filter((window) => !window.minimized)
        .sort((a, b) => b.zIndex - a.zIndex)[0];

      return {
        windows: [...state.windows, ...added],
        topZIndex: zIndex,
        focusedId: focused?.id ?? state.focusedId,
        cascadeIndex: state.cascadeIndex + added.length,
      };
    });
  },
}));

/**
 * Distils the live windows into the persistable layout shape.
 *
 * Pure and app-agnostic: the caller decides which windows to hand it (the
 * desktop excludes terminals, which are recovered from their live sessions
 * instead). Windows are emitted in z-order, back to front, so `applyLayout`
 * rebuilds the same stack. Application state (`props`) is intentionally dropped
 * — the layout records arrangement, never a session id or file contents.
 */
export function serializeLayout(windows: WindowInstance[]): DesktopLayout {
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);
  const persisted: PersistedWindow[] = ordered.map((window) => ({
    appId: window.appId,
    title: window.title,
    bounds: window.bounds,
    restoreBounds: window.restoreBounds,
    minimized: window.minimized,
  }));
  return { version: DESKTOP_LAYOUT_VERSION, windows: persisted };
}

/** Windows in the order the taskbar should show them (creation order). */
export function selectTaskbarWindows(state: DesktopState): WindowInstance[] {
  return state.windows;
}
