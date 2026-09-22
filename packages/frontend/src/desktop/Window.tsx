import { useRef, type ReactNode } from 'react';

import { WindowControls } from './WindowControls.js';
import {
  resizeBounds,
  useDesktopStore,
  type ResizeEdge,
  type WindowBounds,
  type WindowInstance,
} from '../stores/desktop.store.js';
import { useActiveTheme } from '../stores/theme.store.js';

/**
 * A draggable, resizable window frame.
 *
 * Dragging and resizing are pointer-based so touch and mouse behave the same.
 * The title bar is the drag handle; every edge and corner resizes, so a window
 * can grow in any direction like a native one rather than only from the
 * bottom-right. Double-clicking the title bar toggles maximisation.
 *
 * The title-bar layout follows the active OS theme: where the controls sit
 * (left for macOS traffic lights, right for Windows/GNOME), how the title is
 * aligned, the bar height, and the window corner radius all come from the
 * theme's chrome definition.
 */

/** The eight resize handles: four edges and four corners, with their cursors. */
const RESIZE_HANDLES: Array<{ edge: ResizeEdge; className: string; cursor: string }> = [
  { edge: 'n', className: 'left-2 right-2 top-0 h-1.5', cursor: 'ns-resize' },
  { edge: 's', className: 'left-2 right-2 bottom-0 h-1.5', cursor: 'ns-resize' },
  { edge: 'w', className: 'top-2 bottom-2 left-0 w-1.5', cursor: 'ew-resize' },
  { edge: 'e', className: 'top-2 bottom-2 right-0 w-1.5', cursor: 'ew-resize' },
  { edge: 'nw', className: 'left-0 top-0 h-2.5 w-2.5', cursor: 'nwse-resize' },
  { edge: 'ne', className: 'right-0 top-0 h-2.5 w-2.5', cursor: 'nesw-resize' },
  { edge: 'sw', className: 'left-0 bottom-0 h-2.5 w-2.5', cursor: 'nesw-resize' },
  { edge: 'se', className: 'right-0 bottom-0 h-2.5 w-2.5', cursor: 'nwse-resize' },
];

export function Window({
  instance,
  focused,
  children,
}: {
  instance: WindowInstance;
  focused: boolean;
  children: ReactNode;
}) {
  const focusWindow = useDesktopStore((state) => state.focusWindow);
  const closeWindow = useDesktopStore((state) => state.closeWindow);
  const minimizeWindow = useDesktopStore((state) => state.minimizeWindow);
  const moveWindow = useDesktopStore((state) => state.moveWindow);
  const setWindowBounds = useDesktopStore((state) => state.setWindowBounds);
  const toggleMaximize = useDesktopStore((state) => state.toggleMaximize);
  const { chrome } = useActiveTheme();

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeRef = useRef<{
    edge: ResizeEdge;
    startX: number;
    startY: number;
    origin: WindowBounds;
  } | null>(null);

  if (instance.minimized) return null;

  const maximised = instance.restoreBounds !== null;
  const controlsLeft = chrome.controlSide === 'left';
  // Windows 11 caption buttons run flush into the top-right corner (clipped only
  // by the window radius), so the title bar drops its right padding for that theme.
  const flushControls = chrome.controlStyle === 'win11';

  const controls = (
    <WindowControls
      chrome={chrome}
      focused={focused}
      maximised={maximised}
      onMinimize={() => minimizeWindow(instance.id)}
      onToggleMaximize={() => toggleMaximize(instance.id)}
      onClose={() => closeWindow(instance.id)}
    />
  );

  const title = (
    <span
      className={[
        'min-w-0 flex-1 truncate px-1 text-xs font-medium text-slate-200',
        chrome.titleAlign === 'center' ? 'text-center' : 'text-left',
      ].join(' ')}
    >
      {instance.title}
    </span>
  );

  return (
    <div
      className={[
        'absolute flex flex-col overflow-hidden bg-surface-800 shadow-2xl',
        focused ? 'border border-accent/50' : 'border border-white/10',
      ].join(' ')}
      style={{
        left: instance.bounds.x,
        top: instance.bounds.y,
        width: instance.bounds.width,
        height: instance.bounds.height,
        zIndex: instance.zIndex,
        borderRadius: maximised ? 0 : chrome.windowRadius,
        // A maximised window is edge-to-edge with no border, like every OS.
        ...(maximised ? { borderWidth: 0 } : {}),
      }}
      onPointerDown={() => focusWindow(instance.id)}
    >
      {/* Title bar */}
      <div
        className={[
          'flex shrink-0 cursor-move select-none items-center gap-1 bg-surface-900/80',
          flushControls ? 'pl-2 pr-0' : 'px-2',
        ].join(' ')}
        style={{ height: chrome.titlebarHeight }}
        onPointerDown={(event) => {
          if (maximised || event.button !== 0) return;
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: instance.bounds.x,
            originY: instance.bounds.y,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag === null) return;
          moveWindow(
            instance.id,
            drag.originX + (event.clientX - drag.startX),
            drag.originY + (event.clientY - drag.startY)
          );
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onDoubleClick={() => toggleMaximize(instance.id)}
      >
        {controlsLeft ? (
          <>
            {controls}
            {title}
            {/* A spacer the width of the controls keeps a centred title truly
                centred rather than pushed right by the left-side lights. */}
            <span aria-hidden="true" className="w-14 shrink-0" />
          </>
        ) : (
          <>
            {chrome.titleAlign === 'center' ? (
              <span aria-hidden="true" className="w-20 shrink-0" />
            ) : null}
            {title}
            {controls}
          </>
        )}
      </div>

      {/* App content */}
      <div className="min-h-0 flex-1">{children}</div>

      {/* Resize handles — every edge and corner. Hidden while maximised, where
          the window is pinned to the viewport. */}
      {!maximised
        ? RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.edge}
              className={`absolute ${handle.className}`}
              style={{ cursor: handle.cursor, touchAction: 'none' }}
              aria-hidden="true"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                resizeRef.current = {
                  edge: handle.edge,
                  startX: event.clientX,
                  startY: event.clientY,
                  origin: instance.bounds,
                };
              }}
              onPointerMove={(event) => {
                const resize = resizeRef.current;
                if (resize === null) return;
                setWindowBounds(
                  instance.id,
                  resizeBounds(
                    resize.origin,
                    resize.edge,
                    event.clientX - resize.startX,
                    event.clientY - resize.startY
                  )
                );
              }}
              onPointerUp={() => {
                resizeRef.current = null;
              }}
            />
          ))
        : null}
    </div>
  );
}
