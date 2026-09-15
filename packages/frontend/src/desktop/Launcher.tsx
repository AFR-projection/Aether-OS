import { useMemo, useState } from 'react';

import { APP_REGISTRY } from '../apps/registry.js';
import { useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';

/**
 * The app launcher: a searchable grid over every app the account may use.
 *
 * Closing on open is deliberate — the launcher is a means of starting
 * something, not a place to linger — and Escape closes it like any menu.
 */
export function Launcher() {
  const user = useCurrentUser();
  const open = useDesktopStore((state) => state.launcherOpen);
  const setLauncherOpen = useDesktopStore((state) => state.setLauncherOpen);
  const openWindow = useDesktopStore((state) => state.openWindow);

  const [filter, setFilter] = useState('');

  const apps = useMemo(() => {
    if (user === null) return [];
    const permitted = new Set(user.permissions);
    const visible = APP_REGISTRY.filter(
      (app) => app.requiredPermission === undefined || permitted.has(app.requiredPermission)
    );
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

  return (
    <div
      className="absolute inset-x-0 bottom-10 top-0 z-40 flex items-start justify-center bg-black/50 p-4"
      onClick={() => {
        setFilter('');
        setLauncherOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setFilter('');
          setLauncherOpen(false);
        }
      }}
    >
      <div
        role="dialog"
        aria-label="App launcher"
        className="mt-8 w-full max-w-2xl rounded-lg border border-white/10 bg-surface-800 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search apps…"
          aria-label="Search apps"
          className="mb-3 h-10 w-full rounded-md border border-white/10 bg-surface-900/70 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none"
        />

        {apps.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            {filter === ''
              ? 'No apps are available to this account.'
              : 'No apps match that search.'}
          </p>
        ) : (
          <ul className="grid max-h-96 grid-cols-2 gap-2 overflow-auto sm:grid-cols-3">
            {apps.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-transparent p-3 text-left hover:border-white/10 hover:bg-white/5"
                  onClick={() => {
                    openWindow(app.id, {
                      title: app.name,
                      width: app.defaultSize.width,
                      height: app.defaultSize.height,
                      singleton: app.singleton,
                    });
                    setFilter('');
                    setLauncherOpen(false);
                  }}
                >
                  <span className="text-2xl" aria-hidden="true">
                    {app.icon}
                  </span>
                  <span className="text-sm font-medium text-slate-100">{app.name}</span>
                  <span className="text-xs text-slate-500">{app.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
