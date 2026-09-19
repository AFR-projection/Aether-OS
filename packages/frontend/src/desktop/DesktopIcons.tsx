import { useQuery } from '@tanstack/react-query';

import { availableApps } from '../apps/registry.js';
import { fetchSettings } from '../lib/system-api.js';
import { useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';
import { useActiveTheme } from '../stores/theme.store.js';

/**
 * Desktop shortcut icons, laid out the way each OS lays them out.
 *
 * Windows keeps them in a top-left column; macOS keeps them at the top-right.
 * GNOME shows no desktop icons at all by default — its apps are reached through
 * Activities — so under that theme this renders nothing and the launcher is the
 * way in, which is exactly how GNOME behaves.
 *
 * Which icons appear follows the pinned set from the App Catalog, stored per
 * user in the shared `settings` table. When nothing is pinned — or the settings
 * request fails — every app the account may use is shown, so a failed
 * preference read can never present an empty desktop.
 */
export function DesktopIcons() {
  const user = useCurrentUser();
  const openWindow = useDesktopStore((state) => state.openWindow);
  const { chrome } = useActiveTheme();

  const username = user?.username ?? '';

  const settingsQuery = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: fetchSettings,
    // Pinned apps change rarely; the catalog invalidates this key on save.
    staleTime: 60_000,
    enabled: username !== '',
  });

  if (user === null) return null;
  // GNOME has no desktop icons; the launcher (Activities) is the entry point.
  if (chrome.shell === 'topbar') return null;

  const usable = availableApps(user.permissions);

  const stored = settingsQuery.data?.settings.find(
    (entry) => entry.key === `desktop.pinnedApps.${username}`
  );
  const pinnedIds =
    stored !== undefined &&
    Array.isArray(stored.value) &&
    stored.value.every((id) => typeof id === 'string')
      ? new Set<string>(stored.value)
      : null;

  const visible = pinnedIds === null ? usable : usable.filter((app) => pinnedIds.has(app.id));

  // macOS aligns desktop icons to the right edge; Windows to the left.
  const alignRight = chrome.controlSide === 'left';

  return (
    <div
      className={[
        'pointer-events-none absolute top-2 z-0 flex flex-col gap-1',
        alignRight ? 'right-2 items-end' : 'left-2 items-start',
      ].join(' ')}
    >
      {visible.map((app) => (
        <button
          key={app.id}
          type="button"
          title={app.description}
          aria-label={`Open ${app.name}`}
          className="pointer-events-auto flex w-20 flex-col items-center gap-1 rounded-lg p-2 hover:bg-white/10"
          onDoubleClick={() =>
            openWindow(app.id, {
              title: app.name,
              width: app.defaultSize.width,
              height: app.defaultSize.height,
              singleton: app.singleton,
            })
          }
          onClick={(event) => {
            // A single click selects nothing here; a double click opens. But a
            // touch device has no double-click, so a single tap opens as well
            // when the event comes from touch.
            if (event.detail === 0) {
              openWindow(app.id, {
                title: app.name,
                width: app.defaultSize.width,
                height: app.defaultSize.height,
                singleton: app.singleton,
              });
            }
          }}
        >
          <span
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-black/25 text-white shadow-lg backdrop-blur-sm"
            aria-hidden="true"
          >
            <app.icon size={24} strokeWidth={1.75} />
          </span>
          <span className="w-full truncate text-center text-[11px] font-medium text-white drop-shadow">
            {app.name}
          </span>
        </button>
      ))}
    </div>
  );
}
