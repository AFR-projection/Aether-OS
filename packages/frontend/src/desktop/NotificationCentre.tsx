import { AlertTriangle, Bell, CheckCircle2, Info, Trash2, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';

import { useNotificationStore, type NotificationLevel } from '../stores/notification.store.js';

/**
 * The persistent half of the notification system — the history the toasts fade
 * out of. Opened from the tray bell; opening it marks everything read (the store
 * does that), which is what clears the unread badge.
 *
 * It shows only what was really raised. An empty centre says so plainly rather
 * than inventing a "you're all caught up" celebration for a system that has
 * simply had nothing to report.
 */

const LEVEL_ICON: Record<NotificationLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const LEVEL_ACCENT: Record<NotificationLevel, string> = {
  info: 'text-sky-300',
  success: 'text-emerald-300',
  warning: 'text-amber-300',
  error: 'text-red-300',
};

/** A compact relative time — "now", "3m", "2h", or a date once it is old. */
function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function NotificationCentre() {
  const open = useNotificationStore((state) => state.centreOpen);
  const notifications = useNotificationStore((state) => state.notifications);
  const setCentreOpen = useNotificationStore((state) => state.setCentreOpen);
  const dismiss = useNotificationStore((state) => state.dismiss);
  const clearAll = useNotificationStore((state) => state.clearAll);

  // Escape closes it, matching every other dismissible surface on the desktop.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCentreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setCentreOpen]);

  if (!open) return null;

  const now = Date.now();

  return (
    <>
      {/* A click-catcher behind the panel: clicking away closes it. */}
      <button
        type="button"
        aria-label="Close notifications"
        tabIndex={-1}
        onClick={() => setCentreOpen(false)}
        className="absolute inset-0 z-[1100] cursor-default bg-transparent"
      />
      <section
        role="dialog"
        aria-label="Notification centre"
        className="absolute bottom-3 right-3 z-[1101] flex max-h-[70vh] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-white/10 bg-surface-900/95 shadow-2xl backdrop-blur-xl"
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Bell size={15} className="text-slate-300" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-100">Notifications</h2>
          </div>
          <div className="flex items-center gap-1">
            {notifications.length > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-slate-200"
              >
                <Trash2 size={13} aria-hidden="true" />
                Clear all
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Close"
              onClick={() => setCentreOpen(false)}
              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <Bell size={22} className="text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-400">No notifications</p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
            {notifications.map((n) => {
              const Icon = LEVEL_ICON[n.level];
              return (
                <li key={n.id} className="group flex items-start gap-2.5 px-4 py-2.5">
                  <Icon
                    size={16}
                    className={`mt-0.5 shrink-0 ${LEVEL_ACCENT[n.level]}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium text-slate-100">{n.title}</p>
                      <time className="shrink-0 text-[10px] tabular-nums text-slate-500">
                        {relativeTime(n.at, now)}
                      </time>
                    </div>
                    {n.body !== undefined ? (
                      <p className="mt-0.5 text-xs leading-snug text-slate-300">{n.body}</p>
                    ) : null}
                    {n.source !== undefined ? (
                      <span className="mt-1 inline-block text-[10px] uppercase tracking-wide text-slate-500">
                        {n.source}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss notification"
                    onClick={() => dismiss(n.id)}
                    className="shrink-0 rounded p-1 text-slate-500 opacity-0 hover:bg-white/10 hover:text-slate-200 focus:opacity-100 group-hover:opacity-100"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * The tray bell with an unread badge. Rendered in each shell's status area, so
 * every theme gets the same real control rather than a decorative glyph.
 */
export function NotificationBell({ className = '' }: { className?: string }) {
  const unread = useNotificationStore((state) =>
    state.notifications.reduce((count, n) => (n.read ? count : count + 1), 0)
  );
  const toggleCentre = useNotificationStore((state) => state.toggleCentre);
  const centreOpen = useNotificationStore((state) => state.centreOpen);

  return (
    <button
      type="button"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      aria-expanded={centreOpen}
      onClick={toggleCentre}
      className={`relative rounded p-1 text-slate-300 hover:bg-white/10 hover:text-slate-100 ${className}`}
    >
      <Bell size={15} aria-hidden="true" />
      {unread > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </button>
  );
}
