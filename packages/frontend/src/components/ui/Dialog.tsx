import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';

/**
 * A modal dialog.
 *
 * Built on the native `<dialog>` element so focus trapping, the backdrop, and
 * Escape-to-close come from the platform rather than from a hand-rolled
 * implementation that usually gets one of them wrong.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    if (open && !element.open) {
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    // `cancel` fires for Escape. Routing it through `onClose` keeps the React
    // state in step with the element's own open/closed state.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };

    element.addEventListener('cancel', handleCancel);
    return () => element.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

  return (
    <dialog
      ref={ref}
      className={`w-[calc(100vw-2rem)] ${widths[width]} rounded-lg border border-white/10 bg-surface-800 p-0 text-slate-100 shadow-2xl backdrop:bg-black/60`}
      onClick={(event) => {
        // Clicks land on the dialog element itself only when they hit the
        // backdrop area outside the content panel.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          {description !== undefined ? (
            <p className="text-xs text-slate-400">{description}</p>
          ) : null}
        </div>

        {children}

        <div className="flex justify-end gap-2 pt-1">
          {footer ?? (
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}

/**
 * A confirmation dialog for a destructive action.
 *
 * The confirm button is only destructive-styled when the caller explicitly asks
 * for it, so an accidental "Are you sure?" cannot be dismissed by muscle memory
 * on a red button that looked harmless.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      width="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-300">{message}</div>
    </Dialog>
  );
}
