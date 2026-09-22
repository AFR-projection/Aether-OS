import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_NOTIFICATIONS,
  notify,
  selectUnreadCount,
  useNotificationStore,
} from './notification.store.js';

/**
 * The notification store is pure state — no DOM — so it is tested directly. The
 * behaviours that matter are the ones a decorative implementation gets wrong:
 * newest-first ordering, a bounded history, dedupe that collapses a retry storm
 * without burying everything, and read-state that the centre and the unread
 * badge both depend on.
 */

function reset(): void {
  useNotificationStore.setState({ notifications: [], centreOpen: false });
}

beforeEach(reset);

describe('notify', () => {
  it('records a notification newest-first and returns its id', () => {
    const first = notify({ title: 'First' });
    const second = notify({ title: 'Second' });

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.title).toBe('Second');
    expect(notifications[0]?.id).toBe(second);
    expect(notifications[1]?.id).toBe(first);
  });

  it('defaults to info, unread, and non-sticky', () => {
    notify({ title: 'Plain' });
    const n = useNotificationStore.getState().notifications[0];
    expect(n?.level).toBe('info');
    expect(n?.read).toBe(false);
    expect(n?.sticky).toBe(false);
  });

  it('makes errors sticky by default so they do not fade unseen', () => {
    notify({ title: 'Boom', level: 'error' });
    expect(useNotificationStore.getState().notifications[0]?.sticky).toBe(true);
  });

  it('lets an explicit sticky override the level default', () => {
    notify({ title: 'Boom', level: 'error', sticky: false });
    expect(useNotificationStore.getState().notifications[0]?.sticky).toBe(false);
  });

  it('caps the history and keeps the newest', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 25; i += 1) notify({ title: `n${i}` });
    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS);
    expect(notifications[0]?.title).toBe(`n${MAX_NOTIFICATIONS + 24}`);
  });
});

describe('dedupe', () => {
  it('replaces an existing unread notification with the same key in place', () => {
    const id = notify({ title: 'Backend unreachable (1)', dedupeKey: 'net' });
    const again = notify({ title: 'Backend unreachable (2)', dedupeKey: 'net' });

    const { notifications } = useNotificationStore.getState();
    expect(again).toBe(id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('Backend unreachable (2)');
  });

  it('does not collapse into a notification the user has already read', () => {
    const id = notify({ title: 'Backend unreachable', dedupeKey: 'net' });
    useNotificationStore.getState().markRead(id);

    notify({ title: 'Backend unreachable again', dedupeKey: 'net' });
    expect(useNotificationStore.getState().notifications).toHaveLength(2);
  });
});

describe('read state and dismissal', () => {
  it('markRead flips one, markAllRead flips all', () => {
    const a = notify({ title: 'a' });
    notify({ title: 'b' });

    useNotificationStore.getState().markRead(a);
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(1);

    useNotificationStore.getState().markAllRead();
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(0);
  });

  it('dismiss removes just one; clearAll empties the history', () => {
    const a = notify({ title: 'a' });
    notify({ title: 'b' });

    useNotificationStore.getState().dismiss(a);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    useNotificationStore.getState().clearAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('opening the centre marks everything read', () => {
    notify({ title: 'a' });
    notify({ title: 'b' });
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(2);

    useNotificationStore.getState().setCentreOpen(true);
    expect(selectUnreadCount(useNotificationStore.getState())).toBe(0);
    expect(useNotificationStore.getState().centreOpen).toBe(true);
  });
});
