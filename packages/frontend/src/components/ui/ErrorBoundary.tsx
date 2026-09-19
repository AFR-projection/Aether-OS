import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './Button.js';

/**
 * Catches a render-time crash inside a single app and shows a recoverable
 * fallback instead of letting the exception unmount the whole desktop.
 *
 * Before this existed, one app that threw during render (for example reading a
 * property off an undefined API response) propagated to the root and blanked
 * the entire OS — the user lost every open window, not just the broken one.
 * A boundary per app window contains the blast radius to that window.
 *
 * `resetKey` lets the parent force a remount of the subtree: when it changes,
 * the boundary drops its captured error and tries to render its children
 * again. The desktop passes the app id so switching what a window shows always
 * starts from a clean slate rather than a stuck error state.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  /** Human label for the crashed surface, e.g. the app name. */
  label?: string;
  /** Changing this value clears the error and re-renders the children. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    // A new resetKey means the parent is showing something different here;
    // discard the previous crash so the fresh subtree gets a real attempt.
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- a crashed app must leave a trace.
    console.error(`[${this.props.label ?? 'app'}] crashed while rendering`, error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const label = this.props.label ?? 'This app';

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium text-red-300">{label} ran into a problem.</p>
        <p className="max-w-sm text-xs text-slate-500">
          The rest of the desktop is unaffected. You can try reloading this app; if it keeps
          failing, close it and reopen it.
        </p>
        <p className="max-w-sm break-words font-mono text-[11px] text-slate-600">{error.message}</p>
        <Button size="sm" onClick={this.retry}>
          Reload this app
        </Button>
      </div>
    );
  }
}
