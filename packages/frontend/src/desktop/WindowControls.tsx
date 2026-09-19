import type { ThemeChrome } from '../lib/themes.js';

/**
 * Window controls, drawn to match each OS exactly.
 *
 * The three real desktops treat these buttons very differently, and the detail
 * is what sells the theme, so each style is hand-drawn rather than shared:
 *
 * - **Windows 11**: full-height caption buttons flush to the top-right corner,
 *   square, thin Fluent glyphs, and a red close on hover.
 * - **macOS**: the traffic lights, top-left, 12px circles in close/minimise/
 *   maximise order, grey when the window is not focused and showing their
 *   glyphs only on hover of the group.
 * - **GNOME/Adwaita**: circular symbolic buttons on the right, close last.
 */
export function WindowControls({
  chrome,
  focused,
  maximised,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  chrome: ThemeChrome;
  focused: boolean;
  maximised: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  if (chrome.controlStyle === 'traffic') {
    return (
      <TrafficLights
        focused={focused}
        onMinimize={onMinimize}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
    );
  }

  if (chrome.controlStyle === 'gnome') {
    return (
      <GnomeControls
        maximised={maximised}
        onMinimize={onMinimize}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
    );
  }

  return (
    <Win11Controls
      maximised={maximised}
      onMinimize={onMinimize}
      onToggleMaximize={onToggleMaximize}
      onClose={onClose}
    />
  );
}

/** Stops a control click from also dragging or focusing the title bar. */
function stop(handler: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

function Win11Controls({
  maximised,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  maximised: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        aria-label="Minimize"
        onClick={stop(onMinimize)}
        className="flex w-[46px] items-center justify-center text-slate-300 transition-colors hover:bg-white/10"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximised ? 'Restore' : 'Maximize'}
        onClick={stop(onToggleMaximize)}
        className="flex w-[46px] items-center justify-center text-slate-300 transition-colors hover:bg-white/10"
      >
        {maximised ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M2.5 2.5 V0.5 H8.5 V6.5 H6.5" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={stop(onClose)}
        className="flex w-[46px] items-center justify-center text-slate-300 transition-colors hover:bg-[#c42b1c] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

function TrafficLights({
  focused,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  focused: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  // The glyphs show only on hover of the whole cluster, exactly like macOS.
  return (
    <div className="group flex items-center gap-2 px-1">
      <TrafficLight
        color="#ff5f57"
        focused={focused}
        label="Close"
        onClick={onClose}
        glyph={
          <path d="M2 2 L6 6 M6 2 L2 6" stroke="#4d0000" strokeWidth="1.1" strokeLinecap="round" />
        }
      />
      <TrafficLight
        color="#febc2e"
        focused={focused}
        label="Minimize"
        onClick={onMinimize}
        glyph={<path d="M1.8 4 H6.2" stroke="#5c3d00" strokeWidth="1.1" strokeLinecap="round" />}
      />
      <TrafficLight
        color="#28c840"
        focused={focused}
        label="Zoom"
        onClick={onToggleMaximize}
        glyph={
          <path
            d="M2.4 2.4 H5.6 V5.6 Z M5.6 5.6 H2.4 V2.4 Z"
            fill="#0b5c1a"
            stroke="none"
          />
        }
      />
    </div>
  );
}

function TrafficLight({
  color,
  focused,
  label,
  onClick,
  glyph,
}: {
  color: string;
  focused: boolean;
  label: string;
  onClick: () => void;
  glyph: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={stop(onClick)}
      className="flex h-3 w-3 items-center justify-center rounded-full"
      style={{ backgroundColor: focused ? color : '#4b4b4e' }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" className="opacity-0 group-hover:opacity-100" aria-hidden="true">
        {glyph}
      </svg>
    </button>
  );
}

function GnomeControls({
  maximised,
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  maximised: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  const base =
    'flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-slate-200 transition-colors hover:bg-white/20';

  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Minimize" onClick={stop(onMinimize)} className={base}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <line x1="3" y1="8.5" x2="9" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximised ? 'Restore' : 'Maximize'}
        onClick={stop(onToggleMaximize)}
        className={base}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="3" y="3" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button type="button" aria-label="Close" onClick={stop(onClose)} className={base}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
