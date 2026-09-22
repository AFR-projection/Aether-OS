import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { NotificationBell, NotificationCentre } from './NotificationCentre.js';
import { useNotificationStore } from '../stores/notification.store.js';

function reset(): void {
  useNotificationStore.setState({ notifications: [], centreOpen: false });
}

beforeEach(reset);

describe('NotificationBell', () => {
  it('shows an unread count and opening the centre clears it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <NotificationBell />
        <NotificationCentre />
      </>
    );

    act(() => {
      useNotificationStore.getState().notify({ title: 'one' });
      useNotificationStore.getState().notify({ title: 'two' });
    });

    // Badge reflects two unread.
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }));

    // Centre is open and everything is now read — the badge label drops the count.
    expect(screen.getByRole('dialog', { name: 'Notification centre' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('caps the badge at 9+', () => {
    render(<NotificationBell />);
    act(() => {
      for (let i = 0; i < 12; i += 1) useNotificationStore.getState().notify({ title: `n${i}` });
    });
    expect(screen.getByText('9+')).toBeInTheDocument();
  });
});

describe('NotificationCentre', () => {
  it('lists notifications and can dismiss one', async () => {
    const user = userEvent.setup();
    act(() => {
      useNotificationStore.getState().notify({ title: 'Deploy finished', source: 'Deployments' });
      useNotificationStore.setState({ centreOpen: true });
    });

    render(<NotificationCentre />);

    expect(screen.getByText('Deploy finished')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Deploy finished')).not.toBeInTheDocument();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('shows an honest empty state rather than an invented one', () => {
    act(() => {
      useNotificationStore.setState({ centreOpen: true });
    });
    render(<NotificationCentre />);
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('clears everything on Clear all', async () => {
    const user = userEvent.setup();
    act(() => {
      useNotificationStore.getState().notify({ title: 'a' });
      useNotificationStore.getState().notify({ title: 'b' });
      useNotificationStore.setState({ centreOpen: true });
    });
    render(<NotificationCentre />);

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });
});
