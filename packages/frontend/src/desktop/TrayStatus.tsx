import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useOnlineStatus } from '../lib/useOnlineStatus.js';

/**
 * The system-tray network status — a real control, not a decorative glyph.
 *
 * The icon reflects live connectivity (`useOnlineStatus`), and clicking it opens
 * a small status popover the way every OS tray does. Shared by all three shells
 * so there is one implementation of "what the network icon does", rather than a
 * dead `<Wifi>` pasted into each bar. The volume and battery glyphs that used to
 * sit beside it were removed: a headless cloud host has no audio sink and no
 * battery, so a control for either would govern nothing (see KNOWN-LIMITATIONS
 * §"Tray").
 */
export function TrayStatus({ placement = 'down' }: { placement?: 'up' | 'down' }) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape, like a real tray flyout.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const host = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        aria-label={online ? 'Network: connected' : 'Network: offline'}
        aria-expanded={open}
        title={online ? 'Connected' : 'Offline'}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
      >
        {online ? (
          <Wifi size={15} aria-hidden="true" />
        ) : (
          <WifiOff size={15} className="text-amber-400" aria-hidden="true" />
        )}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Network status"
          className={[
            'absolute right-0 z-50 w-60 rounded-lg border border-white/15 bg-surface-800/95 p-3 text-slate-100 shadow-2xl backdrop-blur-xl',
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
          ].join(' ')}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={['h-2 w-2 rounded-full', online ? 'bg-emerald-400' : 'bg-amber-400'].join(
                ' '
              )}
            />
            <span className="text-sm font-medium">{online ? 'Connected' : 'Offline'}</span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {online
              ? 'This device has a network connection.'
              : 'This device has lost its network connection. Aether will reconnect automatically when it returns.'}
          </p>
          {host !== '' ? (
            <p className="mt-2 truncate text-[11px] text-slate-500" title={host}>
              Server: <span className="text-slate-300">{host}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
