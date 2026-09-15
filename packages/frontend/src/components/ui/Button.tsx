import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:bg-accent-muted',
  secondary:
    'bg-surface-600 text-slate-100 hover:bg-surface-500 border border-white/10 disabled:opacity-50',
  ghost:
    'bg-transparent text-slate-200 hover:bg-white/5 border border-transparent disabled:opacity-40',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-900',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

/**
 * A button that renders as `disabled` while an action is in flight.
 *
 * `type` defaults to `button` so a button placed inside a form does not submit
 * it by accident — the classic cause of a "cancel" that saves anyway.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      className={[
        'inline-flex select-none items-center justify-center rounded-md font-medium',
        'transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      {children}
    </button>
  );
}

/** An indeterminate spinner. There is no progress value to show, so none is faked. */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z"
      />
    </svg>
  );
}
