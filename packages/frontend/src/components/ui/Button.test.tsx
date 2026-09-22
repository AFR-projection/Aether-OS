import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button.js';

/**
 * The first component test — as much a proof that the jsdom + Testing Library
 * harness renders a real React tree and dispatches real events as it is a test
 * of `Button`. The window-manager parity work that follows leans on exactly
 * this: render a component, act on it the way a user would, assert what the DOM
 * actually shows.
 *
 * `Button`'s own contract is small but load-bearing: it must not submit a form
 * by accident (its `type` default), and it must refuse clicks while an action
 * is in flight (its `loading` state) — the two behaviours whose absence causes
 * the "cancel that saves anyway" and the double-submit.
 */
describe('Button', () => {
  it('renders its label and is clickable', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('defaults to type=button so it cannot submit a form by accident', () => {
    render(<Button>Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  });

  it('is disabled and announces busy while loading, and swallows clicks', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Deploy
      </Button>
    );

    const button = screen.getByRole('button', { name: 'Deploy' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('honours an explicit type for use as a form submit', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute('type', 'submit');
  });
});
