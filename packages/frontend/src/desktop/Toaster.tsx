import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  useNotificationStore,
  type AetherNotification,
  type NotificationLevel,
} from '../stores/notification.store.js';

/**
 * Transient toasts — the "it just happened" surface of the notification system.
 *
 * A toast is ephemeral by design: it appears when a notification is raised,
 * fades on a timer (unless the event is important enough to be `sticky`), and
 * dismissing it never erases the notification — the centre keeps the history.
 * The two surfaces are one store seen two ways, so a toast the user missed is
 * still in the centre, and a centre entry the user reads stops toasting.
 *
 * Toasts are only shown for notifications raised *after* mount: a reload
 * restores the centre from the store, and replaying every past toast on load
 * would be noise, not news.
 */

const AUTO_DISMISS_MS = 6_000;

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

export function Toaster() {
  const notifications = useNotificationStore((state) => state.notifications);
  const markRead = useNotificationStore((state) => state.markRead);

  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const timers = useRef<Map<string, number>>(new Map());

  const hide = (id: string): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setVisibleIds((ids) => ids.filter((x) => x !== id));
    markRead(id);
  };

  useEffect(() => {
    // First pass: adopt whatever is already in the store as "seen" so history
    // restored on load does not replay as toasts.
    if (!initialized.current) {
      initialized.current = true;
      for (const n of notifications) seen.current.add(n.id);
      return;
    }
    for (const n of notifications) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      setVisibleIds((ids) => (ids.includes(n.id) ? ids : [n.id, ...ids]));
      if (!n.sticky) {
        const timer = window.setTimeout(
          () => setVisibleIds((ids) => ids.filter((x) => x !== n.id)),
          AUTO_DISMISS_MS
        );
        timers.current.set(n.id, timer);
      }
    }
  }, [notifications]);

  // Clear outstanding timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
      map.clear();
    };
  }, []);

  const byId = new Map(notifications.map((n) => [n.id, n]));
  const toasts = visibleIds
    .map((id) => byId.get(id))
    .filter((n): n is AetherNotification => n !== undefined);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute right-3 top-3 z-[1000] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => {
        const Icon = LEVEL_ICON[toast.level];
        return (
          <div
            key={toast.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-white/10 bg-surface-800/95 px-3 py-2.5 shadow-xl backdrop-blur-xl"
          >
            <Icon
              size={16}
              className={`mt-0.5 shrink-0 ${LEVEL_ACCENT[toast.level]}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <p className="truncate text-sm font-medium text-slate-100">{toast.title}</p>
                {toast.source !== undefined ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                    {toast.source}
                  </span>
                ) : null}
              </div>
              {toast.body !== undefined ? (
                <p className="mt-0.5 text-xs leading-snug text-slate-300">{toast.body}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => hide(toast.id)}
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
