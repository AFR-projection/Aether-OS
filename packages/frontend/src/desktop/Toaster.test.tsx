import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from './Toaster.js';
import { useNotificationStore } from '../stores/notification.store.js';

/**
 * The toast surface. What matters here is the ephemeral/persistent split: a
 * toast appears for a *new* event, fades on its own for routine ones, stays for
 * errors, and dismissing it never erases the underlying notification — the
 * centre keeps it.
 */

function reset(): void {
  useNotificationStore.setState({ notifications: [], centreOpen: false });
}

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe('Toaster', () => {
  it('shows a toast for a notification raised after mount', async () => {
    render(<Toaster />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => {
      useNotificationStore.getState().notify({ title: 'Command finished', source: 'Terminal' });
    });

    expect(await screen.findByText('Command finished')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();
  });

  it('does not replay history that existed before mount', () => {
    act(() => {
      useNotificationStore.getState().notify({ title: 'Old news' });
    });

    render(<Toaster />);
    expect(screen.queryByText('Old news')).not.toBeInTheDocument();
  });

  it('dismissing a toast hides it but keeps the notification in the store', async () => {
    const user = userEvent.setup();
    render(<Toaster />);

    act(() => {
      useNotificationStore.getState().notify({ title: 'Keep me' });
    });
    expect(await screen.findByText('Keep me')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));

    expect(screen.queryByText('Keep me')).not.toBeInTheDocument();
    // Still in the history, now marked read.
    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.read).toBe(true);
  });

  it('auto-dismisses a routine toast but keeps a sticky error', () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      useNotificationStore.getState().notify({ title: 'Routine', level: 'info' });
      useNotificationStore.getState().notify({ title: 'Broke', level: 'error' });
    });

    expect(screen.getByText('Routine')).toBeInTheDocument();
    expect(screen.getByText('Broke')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6_500);
    });

    // The info toast faded; the error toast (sticky) stayed.
    expect(screen.queryByText('Routine')).not.toBeInTheDocument();
    expect(screen.getByText('Broke')).toBeInTheDocument();
  });
});
