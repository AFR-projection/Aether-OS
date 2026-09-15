import { useQuery } from '@tanstack/react-query';

import { APP_REGISTRY } from '../apps/registry.js';
import { fetchSettings } from '../lib/system-api.js';
import { useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';

/**
 * The desktop icon column.
 *
 * Icons follow the pinned set from the App Catalog, which is stored per user in
 * the shared `settings` table. When nothing has been pinned yet — or the
 * settings request fails — every app the account may use is shown, so a failed
 * preference read can never present an empty desktop.
 */
export function DesktopIcons() {
  const user = useCurrentUser();
  const openWindow = useDesktopStore((state) => state.openWindow);

  const username = user?.username ?? '';

  const settingsQuery = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: fetchSettings,
    // Pinned apps change rarely; the catalog invalidates this key on save.
    staleTime: 60_000,
    enabled: username !== '',
  });

  if (user === null) return null;

  const permitted = new Set(user.permissions);
  const usable = APP_REGISTRY.filter(
    (app) => app.requiredPermission === undefined || permitted.has(app.requiredPermission)
  );

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

  return (
    <div className="flex w-24 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-white/5 bg-surface-900/40 py-3">
      {visible.map((app) => (
        <button
          key={app.id}
          type="button"
          title={app.description}
          aria-label={`Open ${app.name}`}
          className="flex w-20 flex-col items-center gap-1 rounded-lg p-2 hover:bg-white/5"
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
          <span className="text-2xl" aria-hidden="true">
            {app.icon}
          </span>
          <span className="w-full truncate text-center text-[11px] text-slate-300">{app.name}</span>
        </button>
      ))}
    </div>
  );
}
