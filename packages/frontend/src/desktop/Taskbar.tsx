import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { ConfirmDialog } from '../components/ui/Dialog.js';
import { useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';

/**
 * The bottom taskbar: launcher toggle, running windows, clock, user, sign-out.
 */
export function Taskbar({ onLogout }: { onLogout: () => void }) {
  const user = useCurrentUser();
  const windows = useDesktopStore((state) => state.windows);
  const focusedId = useDesktopStore((state) => state.focusedId);
  const toggleMinimize = useDesktopStore((state) => state.toggleMinimize);

  const [confirmLogout, setConfirmLogout] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // A one-minute clock tick. An interval here is fine — it re-renders the
  // taskbar only, not the windows.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-white/10 bg-surface-900/90 px-2">
      <LauncherToggle />

      <div className="mx-1 h-5 w-px bg-white/10" />

      {/* Running windows */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {windows.map((window) => (
          <button
            key={window.id}
            type="button"
            onClick={() => toggleMinimize(window.id)}
            title={window.title}
            aria-pressed={window.id === focusedId && !window.minimized}
            className={[
              'flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded px-2 text-xs',
              window.id === focusedId && !window.minimized
                ? 'bg-accent/25 text-slate-100'
                : 'text-slate-400 hover:bg-white/5',
              window.minimized ? 'opacity-60' : '',
            ].join(' ')}
          >
            <span className="truncate">{window.title}</span>
          </button>
        ))}
      </div>

      <span className="hidden shrink-0 text-[11px] tabular-nums text-slate-500 sm:block">
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </span>

      <span className="hidden shrink-0 text-xs text-slate-400 md:block" title={user?.username}>
        {user?.username}
      </span>

      <Button size="sm" variant="ghost" onClick={() => setConfirmLogout(true)}>
        Sign out
      </Button>

      <ConfirmDialog
        open={confirmLogout}
        title="Sign out?"
        confirmLabel="Sign out"
        message="Open windows are closed and unsaved work in them is lost."
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          onLogout();
        }}
      />
    </footer>
  );
}

/** The launcher toggle lives in the taskbar but opens the overlay above it. */
function LauncherToggle() {
  const open = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);

  return (
    <Button
      size="sm"
      variant={open ? 'primary' : 'ghost'}
      onClick={() => setLauncherOpen(!open)}
      aria-expanded={open}
      aria-label="Open the app launcher"
    >
      ⊞ Apps
    </Button>
  );
}
