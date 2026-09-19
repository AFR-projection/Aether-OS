import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Checkbox } from '../../components/ui/Input.js';
import { fetchSettings, updateSettings } from '../../lib/system-api.js';
import { useCurrentUser } from '../../stores/auth.store.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { APP_REGISTRY, availableApps, type AppProps } from '../registry.js';

/**
 * The App Catalog.
 *
 * Each user decides which apps appear on their own desktop and in their own
 * launcher. The choice lives in the shared `settings` table under
 * `desktop.pinnedApps.<username>` — server-side, so it follows the user to any
 * browser — and is applied by reading it back here.
 *
 * Pinning is a preference, not a permission: unpinning an app hides its icon
 * but changes nothing about what the account is allowed to open.
 */

const SETTINGS_KEY_PREFIX = 'desktop.pinnedApps.';

function settingsKey(username: string): string {
  return `${SETTINGS_KEY_PREFIX}${username}`;
}

/** Parses the stored pin list; anything malformed falls back to "all pinned". */
function parsePinned(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const pinned = value.filter((entry): entry is string => typeof entry === 'string');
  return pinned.length === value.length ? pinned : null;
}

export function AppCatalogApp({ windowId }: AppProps) {
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const openWindow = useDesktopStore((state) => state.openWindow);
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);

  const [draftPinned, setDraftPinned] = useState<string[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setWindowTitle(windowId, 'App Catalog');
  }, [setWindowTitle, windowId]);

  const username = user?.username ?? '';

  const settingsQuery = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: fetchSettings,
  });

  const usableApps = useMemo(() => (user === null ? [] : availableApps(user.permissions)), [user]);

  const storedPinned = useMemo(() => {
    const record = settingsQuery.data?.settings.find(
      (entry) => entry.key === settingsKey(username)
    );
    if (record === undefined) return null;
    return parsePinned(record.value);
  }, [settingsQuery.data, username]);

  // Default: every app the account may use is pinned.
  const pinned = draftPinned ?? storedPinned ?? usableApps.map((app) => app.id);

  const saveMutation = useMutation({
    mutationFn: (pinnedApps: string[]) => updateSettings({ [settingsKey(username)]: pinnedApps }),
    onSuccess: () => {
      setSaveError(null);
      setSaved(true);
      setDraftPinned(null);
      void queryClient.invalidateQueries({ queryKey: ['system', 'settings'] });
    },
    onError: (error: unknown) => {
      setSaved(false);
      setSaveError(error instanceof Error ? error.message : 'Could not save the layout.');
    },
  });

  if (user === null) {
    return <ErrorState error={new Error('No signed-in user.')} />;
  }

  if (settingsQuery.isPending) return <LoadingState label="Reading the catalog…" />;
  if (settingsQuery.isError) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  const pinnedSet = new Set(pinned);
  const dirty = draftPinned !== null;

  const toggle = (appId: string, checked: boolean) => {
    setSaved(false);
    const base = draftPinned ?? storedPinned ?? usableApps.map((app) => app.id);
    const next = checked
      ? [...base.filter((id) => id !== appId), appId]
      : base.filter((id) => id !== appId);
    // Preserve the registry order so the desktop and launcher stay stable.
    const ordered = APP_REGISTRY.map((app) => app.id).filter((id) => next.includes(id));
    setDraftPinned(ordered);
  };

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Button
          size="sm"
          variant="primary"
          loading={saveMutation.isPending}
          disabled={!dirty}
          onClick={() => saveMutation.mutate(pinned)}
        >
          Save layout
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!dirty}
          onClick={() => {
            setDraftPinned(null);
            setSaveError(null);
          }}
        >
          Reset
        </Button>
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500">
          {pinned.length} of {usableApps.length} pinned
        </span>
      </div>

      {saveError !== null ? (
        <div className="px-2 pt-2">
          <Banner tone="danger" onDismiss={() => setSaveError(null)}>
            {saveError}
          </Banner>
        </div>
      ) : null}

      {saved && !dirty ? (
        <div className="px-2 pt-2">
          <Banner tone="info" onDismiss={() => setSaved(false)}>
            Layout saved. It applies to this account on every browser.
          </Banner>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {usableApps.length === 0 ? (
          <EmptyState
            title="No apps available"
            description="This account has no app permissions. Ask an administrator to grant access."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {usableApps.map((app) => (
              <li
                key={app.id}
                className="flex items-start gap-3 rounded-lg border border-white/10 bg-surface-900/40 p-3"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"
                  aria-hidden="true"
                >
                  <app.icon size={20} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-slate-100">{app.name}</h2>
                    <Checkbox
                      label="Pin"
                      checked={pinnedSet.has(app.id)}
                      onChange={(event) => toggle(app.id, event.target.checked)}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{app.description}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() =>
                      openWindow(app.id, {
                        title: app.name,
                        width: app.defaultSize.width,
                        height: app.defaultSize.height,
                        singleton: app.singleton,
                      })
                    }
                  >
                    Open
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-slate-600">
          Stored under the settings key <code className="font-mono">{settingsKey(username)}</code>.
          Unpinned apps stay usable through other windows but are hidden from your desktop and
          launcher.
        </p>
      </div>
    </div>
  );
}
