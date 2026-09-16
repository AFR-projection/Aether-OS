import { Button, Spinner } from './Button.js';
import { ApiRequestError } from '../../lib/api-client.js';

import type { ReactNode } from 'react';

/**
 * Shared feedback surfaces.
 *
 * Every app needs the same three states — loading, empty, failed — and each of
 * them must say something true. In particular `ErrorState` shows the error code
 * and the server's request id, because those are what make a bug report
 * actionable.
 */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {description !== undefined ? (
        <p className="max-w-sm text-xs text-slate-500">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

/**
 * Renders a failed request.
 *
 * A network failure is called out separately from a server rejection, because
 * the user's next action is different: retry versus change what they typed.
 */
export function ErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const apiError = error instanceof ApiRequestError ? error : null;
  const message =
    apiError?.message ?? (error instanceof Error ? error.message : 'Something went wrong.');

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-950/40 px-3 py-2">
        <span className="text-xs text-red-200">{message}</span>
        {onRetry ? (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-red-300">{message}</p>

      {apiError !== null && !apiError.isNetworkFailure ? (
        <p className="font-mono text-[11px] text-slate-500">
          {apiError.code}
          {apiError.requestId !== undefined ? ` · request ${apiError.requestId}` : ''}
        </p>
      ) : null}

      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A non-blocking banner, used for warnings that should not block the view. */
export function Banner({
  tone = 'info',
  children,
  onDismiss,
}: {
  tone?: 'info' | 'warning' | 'danger';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    info: 'border-accent/40 bg-accent/10 text-slate-200',
    warning: 'border-amber-500/40 bg-amber-950/40 text-amber-100',
    danger: 'border-red-500/40 bg-red-950/40 text-red-100',
  } as const;

  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs ${tones[tone]}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded px-1 text-slate-400 hover:text-slate-200"
          aria-label="Dismiss"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** A horizontal usage bar. Values are clamped so a bad reading cannot overflow. */
export function UsageBar({
  percent,
  tone,
  label,
}: {
  percent: number;
  tone?: 'normal' | 'warning' | 'critical';
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

  const resolvedTone = tone ?? (clamped >= 90 ? 'critical' : clamped >= 75 ? 'warning' : 'normal');

  const fills = {
    normal: 'bg-accent',
    warning: 'bg-amber-500',
    critical: 'bg-red-500',
  } as const;

  return (
    <div className="flex flex-col gap-1">
      {label !== undefined ? <span className="text-xs text-slate-400">{label}</span> : null}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-600"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'usage'}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${fills[resolvedTone]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
