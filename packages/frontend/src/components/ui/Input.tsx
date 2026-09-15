import { useId } from 'react';

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export interface FieldProps {
  label: string;
  /** Rendered under the control. Use for a real hint, not for a validation error. */
  hint?: string;
  /** Rendered in place of the hint and announced to assistive technology. */
  error?: string | null;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    invalid: boolean;
  }) => ReactNode;
}

/**
 * Wraps a control with a label, an optional hint, and an error slot.
 *
 * The error is wired to the control with `aria-describedby` and `aria-invalid`
 * so a screen reader announces it rather than leaving it as visual noise.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const describedBy =
    error !== null && error !== undefined ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, invalid: Boolean(error) })}
      {error !== null && error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function TextInput({ invalid = false, className = '', ...rest }: TextInputProps) {
  return (
    <input
      aria-invalid={invalid}
      className={[
        'h-10 w-full rounded-md border bg-surface-900/70 px-3 text-sm text-slate-100',
        'placeholder:text-slate-500 focus:outline-none focus:ring-1',
        invalid
          ? 'border-red-500/70 focus:border-red-500 focus:ring-red-500'
          : 'border-white/10 focus:border-accent focus:ring-accent',
        className,
      ].join(' ')}
      {...rest}
    />
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function TextArea({ invalid = false, className = '', ...rest }: TextAreaProps) {
  return (
    <textarea
      aria-invalid={invalid}
      className={[
        'w-full rounded-md border bg-surface-900/70 px-3 py-2 font-mono text-sm text-slate-100',
        'placeholder:text-slate-500 focus:outline-none focus:ring-1',
        invalid
          ? 'border-red-500/70 focus:border-red-500 focus:ring-red-500'
          : 'border-white/10 focus:border-accent focus:ring-accent',
        className,
      ].join(' ')}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      className={[
        'h-9 rounded-md border border-white/10 bg-surface-900/70 px-2 text-sm text-slate-100',
        'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </select>
  );
}

/** A labelled checkbox, laid out inline. */
export function Checkbox({
  label,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 rounded border-white/20 bg-surface-900 accent-accent"
        {...rest}
      />
      <label htmlFor={id} className="select-none text-sm text-slate-300">
        {label}
      </label>
    </div>
  );
}
