import { useRef, type ReactNode } from 'react';

import { useDesktopStore, type WindowInstance } from '../stores/desktop.store.js';

/**
 * A draggable, resizable window frame.
 *
 * Dragging and resizing are pointer-based so touch and mouse behave the same.
 * The title bar is the drag handle; the bottom-right corner is the resize
 * handle. Double-clicking the title bar toggles maximisation.
 */

const TASKBAR_HEIGHT = 40;

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
  const resizeWindow = useDesktopStore((state) => state.resizeWindow);
  const toggleMaximize = useDesktopStore((state) => state.toggleMaximize);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
  } | null>(null);

  if (instance.minimized) return null;

  const maximised = instance.restoreBounds !== null;

  return (
    <div
      className={[
        'absolute flex flex-col overflow-hidden rounded-lg border bg-surface-800 shadow-2xl',
        focused ? 'border-accent/50' : 'border-white/10',
      ].join(' ')}
      style={{
        left: instance.bounds.x,
        top: instance.bounds.y,
        width: instance.bounds.width,
        height: instance.bounds.height,
        zIndex: instance.zIndex,
        // A maximised window has square corners and no border, like every other OS.
        ...(maximised ? { borderRadius: 0, borderWidth: 0 } : {}),
        marginBottom: TASKBAR_HEIGHT,
      }}
      onPointerDown={() => focusWindow(instance.id)}
    >
      {/* Title bar */}
      <div
        className="flex h-9 shrink-0 cursor-move select-none items-center gap-1 bg-surface-900/80 px-2"
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
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-slate-200">
          {instance.title}
        </span>

        <button
          type="button"
          aria-label="Minimize"
          className="rounded px-2 py-0.5 text-slate-400 hover:bg-white/10"
          onClick={(event) => {
            event.stopPropagation();
            minimizeWindow(instance.id);
          }}
        >
          –
        </button>
        <button
          type="button"
          aria-label={maximised ? 'Restore' : 'Maximize'}
          className="rounded px-2 py-0.5 text-slate-400 hover:bg-white/10"
          onClick={(event) => {
            event.stopPropagation();
            toggleMaximize(instance.id);
          }}
        >
          {maximised ? '❐' : '□'}
        </button>
        <button
          type="button"
          aria-label="Close"
          className="rounded px-2 py-0.5 text-slate-400 hover:bg-red-600 hover:text-white"
          onClick={(event) => {
            event.stopPropagation();
            closeWindow(instance.id);
          }}
        >
          ✕
        </button>
      </div>

      {/* App content */}
      <div className="min-h-0 flex-1">{children}</div>

      {/* Resize handle */}
      {!maximised ? (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            resizeRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              originWidth: instance.bounds.width,
              originHeight: instance.bounds.height,
            };
          }}
          onPointerMove={(event) => {
            const resize = resizeRef.current;
            if (resize === null) return;
            resizeWindow(
              instance.id,
              resize.originWidth + (event.clientX - resize.startX),
              resize.originHeight + (event.clientY - resize.startY)
            );
          }}
          onPointerUp={() => {
            resizeRef.current = null;
          }}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-slate-600">
            <path d="M14 14 L4 14 L14 4 Z" fill="currentColor" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
