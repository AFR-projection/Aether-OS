import { Grid3x3, Power, Search, Wifi, Volume2, BatteryFull } from 'lucide-react';
import { useEffect, useState } from 'react';

import { findApp } from '../apps/registry.js';
import { useDesktopStore } from '../stores/desktop.store.js';
import { useActiveTheme } from '../stores/theme.store.js';

import type { WindowInstance } from '../stores/desktop.store.js';

/**
 * The desktop shell — the bar(s) that frame the window area.
 *
 * Each OS theme has a different shell, and this is where most of the "it looks
 * like that OS" comes from, so the layouts are distinct rather than a single
 * bar restyled:
 *
 * - **Windows 11**: one bottom taskbar, its contents centred, with a Start
 *   button, running-app buttons, and a right-aligned system tray + clock.
 * - **macOS**: a translucent top menu bar AND a bottom Dock of large icons
 *   with running-indicator dots.
 * - **GNOME**: a single top bar — Activities on the left, the clock centred,
 *   status icons on the right — and no bottom bar.
 *
 * `Shell` is rendered twice by the desktop, once per position; it returns null
 * for a position the active theme does not use.
 */
export function Shell({
  position,
  onLogout,
}: {
  position: 'top' | 'bottom';
  onLogout: () => void;
}) {
  const { chrome } = useActiveTheme();

  if (chrome.shell === 'taskbar') {
    return position === 'bottom' ? <Win11Taskbar /> : null;
  }
  if (chrome.shell === 'dock') {
    return position === 'top' ? <MacMenuBar onLogout={onLogout} /> : <MacDock />;
  }
  // gnome
  return position === 'top' ? <GnomeTopBar onLogout={onLogout} /> : null;
}

// --- shared hooks ----------------------------------------------------------

function useClock(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useRunningWindows(): WindowInstance[] {
  return useDesktopStore((state) => state.windows);
}

// --- Windows 11 ------------------------------------------------------------

function Win11Taskbar() {
  const now = useClock();
  const windows = useRunningWindows();
  const focusedId = useDesktopStore((state) => state.focusedId);
  const toggleMinimize = useDesktopStore((state) => state.toggleMinimize);
  const launcherOpen = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);

  return (
    <footer className="relative flex h-12 shrink-0 items-center bg-surface-900/85 px-2 backdrop-blur-xl">
      {/* Centre cluster: Start + running apps. */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        <button
          type="button"
          aria-label="Start"
          aria-expanded={launcherOpen}
          onClick={() => setLauncherOpen(!launcherOpen)}
          className={[
            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
            launcherOpen ? 'bg-white/15' : 'hover:bg-white/10',
          ].join(' ')}
        >
          <WindowsLogo />
        </button>

        {windows.map((window) => {
          const app = findApp(window.appId);
          const Icon = app?.icon ?? Grid3x3;
          const active = window.id === focusedId && !window.minimized;
          return (
            <button
              key={window.id}
              type="button"
              title={window.title}
              onClick={() => toggleMinimize(window.id)}
              className={[
                'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                active ? 'bg-white/15' : 'hover:bg-white/10',
              ].join(' ')}
            >
              <Icon size={18} strokeWidth={1.75} className="text-slate-200" aria-hidden="true" />
              <span
                aria-hidden="true"
                className={[
                  'absolute bottom-0.5 h-0.5 rounded-full bg-accent transition-all',
                  active ? 'w-4' : 'w-1.5',
                  window.minimized ? 'opacity-50' : '',
                ].join(' ')}
              />
            </button>
          );
        })}
      </div>

      {/* Right system tray. Real Windows 11 has no power control here — sign-out
          lives in the Start menu (see Launcher). The tray carries status + clock. */}
      <div className="ml-auto flex items-center gap-3 pr-2">
        <div className="flex items-center gap-2 rounded-md px-2 py-1 text-slate-300 hover:bg-white/10">
          <Wifi size={15} aria-hidden="true" />
          <Volume2 size={15} aria-hidden="true" />
        </div>
        <div className="flex flex-col items-end leading-tight text-slate-200">
          <span className="text-[11px] tabular-nums">
            {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="text-[10px] tabular-nums text-slate-400">
            {now.toLocaleDateString(undefined, {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            })}
          </span>
        </div>
      </div>
    </footer>
  );
}

function WindowsLogo() {
  // The four-pane Windows mark, in the Fluent accent.
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" rx="1" fill="rgb(var(--accent-hover))" />
      <rect x="10" y="0" width="8" height="8" rx="1" fill="rgb(var(--accent-hover))" />
      <rect x="0" y="10" width="8" height="8" rx="1" fill="rgb(var(--accent-hover))" />
      <rect x="10" y="10" width="8" height="8" rx="1" fill="rgb(var(--accent-hover))" />
    </svg>
  );
}

// --- macOS -----------------------------------------------------------------

function MacMenuBar({ onLogout }: { onLogout: () => void }) {
  const now = useClock();
  const focusedId = useDesktopStore((state) => state.focusedId);
  const windows = useRunningWindows();
  const active = windows.find((window) => window.id === focusedId);
  const appName = active ? (findApp(active.appId)?.name ?? 'Finder') : 'Aether';

  return (
    <header className="flex h-7 shrink-0 items-center gap-4 bg-surface-900/70 px-3 text-[13px] text-slate-100 backdrop-blur-xl">
      <AppleLogo />
      <span className="font-semibold">{appName}</span>
      <span className="hidden text-slate-300 sm:inline">File</span>
      <span className="hidden text-slate-300 sm:inline">Edit</span>
      <span className="hidden text-slate-300 sm:inline">View</span>
      <span className="hidden text-slate-300 sm:inline">Window</span>

      <div className="ml-auto flex items-center gap-3 text-slate-200">
        <BatteryFull size={16} aria-hidden="true" />
        <Wifi size={15} aria-hidden="true" />
        <Search size={14} aria-hidden="true" />
        <button
          type="button"
          aria-label="Sign out"
          onClick={onLogout}
          className="rounded p-0.5 hover:bg-white/10"
        >
          <Power size={14} aria-hidden="true" />
        </button>
        <span className="text-[12px] tabular-nums">
          {now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
          {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </header>
  );
}

function AppleLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 12.53c-.03-2.62 2.14-3.88 2.24-3.94-1.22-1.79-3.12-2.03-3.8-2.06-1.62-.16-3.16.95-3.98.95-.82 0-2.09-.93-3.44-.9-1.77.03-3.4 1.03-4.31 2.61-1.84 3.19-.47 7.9 1.32 10.49.87 1.27 1.91 2.69 3.27 2.64 1.31-.05 1.81-.85 3.4-.85 1.58 0 2.03.85 3.42.82 1.41-.02 2.31-1.29 3.17-2.57.99-1.47 1.4-2.9 1.42-2.97-.03-.01-2.73-1.05-2.76-4.15zM14.6 4.6c.72-.88 1.21-2.09 1.08-3.3-1.04.04-2.3.69-3.05 1.56-.67.77-1.26 2.01-1.1 3.19 1.16.09 2.35-.59 3.07-1.45z" />
    </svg>
  );
}

function MacDock() {
  const windows = useRunningWindows();
  const focusedId = useDesktopStore((state) => state.focusedId);
  const toggleMinimize = useDesktopStore((state) => state.toggleMinimize);
  const launcherOpen = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);

  return (
    <div className="pointer-events-none flex h-20 shrink-0 items-end justify-center pb-2">
      <div className="pointer-events-auto flex items-end gap-2 rounded-2xl border border-white/15 bg-white/10 px-3 py-2 shadow-2xl backdrop-blur-2xl">
        <DockIcon
          label="Launchpad"
          active={launcherOpen}
          onClick={() => setLauncherOpen(!launcherOpen)}
        >
          <Grid3x3 size={26} strokeWidth={1.5} className="text-slate-100" aria-hidden="true" />
        </DockIcon>

        {windows.length > 0 ? <span className="mx-1 h-10 w-px self-center bg-white/20" /> : null}

        {windows.map((window) => {
          const app = findApp(window.appId);
          const Icon = app?.icon ?? Grid3x3;
          const running = window.id === focusedId && !window.minimized;
          return (
            <DockIcon
              key={window.id}
              label={window.title}
              onClick={() => toggleMinimize(window.id)}
            >
              <Icon size={26} strokeWidth={1.5} className="text-slate-100" aria-hidden="true" />
              <span
                aria-hidden="true"
                className={[
                  'absolute -bottom-1.5 h-1 w-1 rounded-full bg-slate-200',
                  running ? 'opacity-100' : 'opacity-0',
                ].join(' ')}
              />
            </DockIcon>
          );
        })}
      </div>
    </div>
  );
}

function DockIcon({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={[
        'relative flex h-12 w-12 items-center justify-center rounded-xl transition-transform duration-150 hover:-translate-y-1.5 hover:scale-110',
        active ? 'bg-white/20' : 'bg-white/10',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// --- GNOME -----------------------------------------------------------------

function GnomeTopBar({ onLogout }: { onLogout: () => void }) {
  const now = useClock();
  const launcherOpen = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);

  return (
    <header className="flex h-8 shrink-0 items-center bg-black/85 px-2 text-[13px] text-slate-100">
      <button
        type="button"
        aria-expanded={launcherOpen}
        onClick={() => setLauncherOpen(!launcherOpen)}
        className={[
          'rounded px-3 py-0.5 font-medium transition-colors',
          launcherOpen ? 'bg-white/20' : 'hover:bg-white/10',
        ].join(' ')}
      >
        Activities
      </button>

      {/* Centred clock, the GNOME hallmark. */}
      <button
        type="button"
        className="absolute left-1/2 -translate-x-1/2 rounded px-3 py-0.5 text-[12px] font-medium tabular-nums hover:bg-white/10"
      >
        {now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </button>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-2 rounded px-2 py-0.5 text-slate-200 hover:bg-white/10">
          <Wifi size={14} aria-hidden="true" />
          <Volume2 size={14} aria-hidden="true" />
          <BatteryFull size={15} aria-hidden="true" />
        </div>
        <button
          type="button"
          aria-label="Sign out"
          onClick={onLogout}
          className="rounded p-1 text-slate-200 hover:bg-white/10"
        >
          <Power size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
