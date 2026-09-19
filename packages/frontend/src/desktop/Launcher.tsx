import { Power, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { availableApps } from '../apps/registry.js';
import { useAuthStore, useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';
import { useActiveTheme } from '../stores/theme.store.js';

import type { AppDefinition } from '../apps/registry.js';

/**
 * The app launcher, styled per theme to match how each OS opens apps:
 *
 * - **Windows 11**: a Start menu — a rounded panel anchored to the bottom
 *   centre, with a search box and a pinned-apps grid.
 * - **macOS**: Launchpad — a full, heavily blurred overlay with a centred grid.
 * - **GNOME**: the Activities overview — a full dark overlay, search at the top.
 *
 * Opening the launcher and picking an app are the only jobs; it closes on pick,
 * on backdrop click, and on Escape.
 */
export function Launcher() {
  const user = useCurrentUser();
  const open = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);
  const openWindow = useDesktopStore((state) => state.openWindow);
  const logout = useAuthStore((state) => state.logout);
  const { chrome } = useActiveTheme();

  const [filter, setFilter] = useState('');

  const apps = useMemo(() => {
    if (user === null) return [];
    const visible = availableApps(user.permissions);
    const needle = filter.trim().toLowerCase();
    return needle === ''
      ? visible
      : visible.filter(
          (app) =>
            app.name.toLowerCase().includes(needle) ||
            app.description.toLowerCase().includes(needle)
        );
  }, [filter, user]);

  if (!open) return null;

  const close = () => {
    setFilter('');
    setLauncherOpen(false);
  };

  const launch = (app: AppDefinition) => {
    openWindow(app.id, {
      title: app.name,
      width: app.defaultSize.width,
      height: app.defaultSize.height,
      singleton: app.singleton,
    });
    close();
  };

  // Windows 11: a Start-menu panel; the others: a full-surface overlay.
  const startMenu = chrome.shell === 'taskbar';
  const initials = (user?.username ?? 'U').slice(0, 2).toUpperCase();

  return (
    <div
      className="absolute inset-0 z-40 flex bg-black/40 backdrop-blur-sm"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <div
        role="dialog"
        aria-label="App launcher"
        onClick={(event) => event.stopPropagation()}
        className={
          startMenu
            ? 'absolute bottom-3 left-1/2 max-h-[70%] w-[36rem] max-w-[92%] -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-surface-800/95 p-4 shadow-2xl backdrop-blur-2xl'
            : 'm-auto flex max-h-[80%] w-[52rem] max-w-[92%] flex-col rounded-2xl border border-white/10 bg-surface-900/70 p-6 shadow-2xl backdrop-blur-2xl'
        }
      >
        <div className="relative mb-4">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            autoFocus
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="h-10 w-full rounded-md border border-white/10 bg-surface-900/70 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none"
          />
        </div>

        {apps.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            {filter === ''
              ? 'No apps are available to this account.'
              : 'No apps match that search.'}
          </p>
        ) : (
          <ul
            className={[
              'grid gap-2 overflow-auto',
              startMenu ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-4 sm:grid-cols-6',
            ].join(' ')}
          >
            {apps.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  onClick={() => launch(app)}
                  className="flex h-full w-full flex-col items-center gap-2 rounded-xl border border-transparent p-3 text-center hover:border-white/10 hover:bg-white/5"
                >
                  <span
                    className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 text-accent"
                    aria-hidden="true"
                  >
                    <app.icon size={24} strokeWidth={1.75} />
                  </span>
                  <span className="text-xs font-medium text-slate-100">{app.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Windows 11 puts the account + power controls in the Start menu footer,
            which is why the taskbar tray carries none. */}
        {startMenu ? (
          <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent"
              >
                {initials}
              </span>
              <span className="text-sm text-slate-200">{user?.username ?? 'User'}</span>
            </div>
            <button
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                close();
                void logout();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-300 hover:bg-white/10"
            >
              <Power size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
