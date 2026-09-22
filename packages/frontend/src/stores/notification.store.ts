import { create } from 'zustand';

/**
 * The notification system.
 *
 * The README claimed a "notification centre" long before one existed; this is
 * the real thing behind that word. Two surfaces read from one store: a transient
 * toast that appears when something happens, and a persistent centre that keeps
 * the history so a notification missed while looking elsewhere is not lost.
 *
 * The rule that matters is the brief's: a notification is raised from a **real**
 * event (a session that ended, a command that exited, an agent that dropped),
 * never a decorative or invented one. `notify()` is deliberately callable from
 * non-React code — the API client, a WebSocket handler — so the event's real
 * origin is where the notification is born, rather than a component inventing it
 * on render.
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface AetherNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  /** Optional detail line. Kept short; a notification is not a log. */
  body?: string;
  /** Where it came from — an app or subsystem name, shown as a tag. */
  source?: string;
  /** ISO-8601 creation time. */
  at: string;
  read: boolean;
  /**
   * A toast that stays until the user dismisses it, rather than fading on a
   * timer. Errors default to sticky because a message that vanishes is a message
   * that might as well not have been shown for the one case that matters.
   */
  sticky: boolean;
  /**
   * Collapses repeats: a second `notify` with the same key updates the existing
   * unread notification in place instead of stacking a duplicate. "Backend
   * unreachable" fired on every retry would otherwise bury everything else.
   */
  dedupeKey?: string;
}

export interface NotifyInput {
  level?: NotificationLevel;
  title: string;
  body?: string;
  source?: string;
  sticky?: boolean;
  dedupeKey?: string;
}

/** The history is capped so a long-lived session cannot grow it without bound. */
export const MAX_NOTIFICATIONS = 100;

interface NotificationState {
  /** Newest first. */
  notifications: AetherNotification[];
  centreOpen: boolean;
  /** Records a notification and returns its id. Safe to call outside React. */
  notify: (input: NotifyInput) => string;
  dismiss: (id: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  setCentreOpen: (open: boolean) => void;
  toggleCentre: () => void;
}

let idCounter = 0;
/** Monotonic, collision-free without depending on `crypto` being present in jsdom. */
function nextId(): string {
  idCounter += 1;
  return `ntf_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  centreOpen: false,

  notify: (input) => {
    const level = input.level ?? 'info';
    const sticky = input.sticky ?? level === 'error';
    const at = new Date().toISOString();

    // Dedupe: replace an existing *unread* notification with the same key in
    // place, so its position and read-state are preserved but its content and
    // timestamp refresh. A read one is left alone — the user has seen it, and a
    // fresh event deserves a fresh entry.
    if (input.dedupeKey !== undefined) {
      const existing = get().notifications.find(
        (n) => n.dedupeKey === input.dedupeKey && !n.read
      );
      if (existing) {
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === existing.id
              ? { ...n, level, title: input.title, body: input.body, source: input.source, sticky, at }
              : n
          ),
        }));
        return existing.id;
      }
    }

    const notification: AetherNotification = {
      id: nextId(),
      level,
      title: input.title,
      body: input.body,
      source: input.source,
      at,
      read: false,
      sticky,
      dedupeKey: input.dedupeKey,
    };

    set((state) => ({
      notifications: [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
    }));
    return notification.id;
  },

  dismiss: (id) =>
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) })),

  markRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),

  markAllRead: () =>
    set((state) => ({ notifications: state.notifications.map((n) => ({ ...n, read: true })) })),

  clearAll: () => set({ notifications: [] }),

  setCentreOpen: (open) =>
    set((state) => ({
      centreOpen: open,
      // Opening the centre is the user acknowledging what is in it.
      notifications: open ? state.notifications.map((n) => ({ ...n, read: true })) : state.notifications,
    })),

  toggleCentre: () => get().setCentreOpen(!get().centreOpen),
}));

/** Selector: how many notifications the user has not yet seen. */
export function selectUnreadCount(state: NotificationState): number {
  return state.notifications.reduce((count, n) => (n.read ? count : count + 1), 0);
}

/**
 * Raises a notification from anywhere, including non-React code.
 *
 * This is the entry point a real event uses — an API client that learns the
 * session is gone, a socket handler that sees an agent drop. It reads the store
 * imperatively so the caller needs no hook.
 */
export function notify(input: NotifyInput): string {
  return useNotificationStore.getState().notify(input);
}
