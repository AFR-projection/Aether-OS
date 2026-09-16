import { useEffect, useRef } from 'react';

import { DesktopIcons } from './DesktopIcons.js';
import { Launcher } from './Launcher.js';
import { Taskbar } from './Taskbar.js';
import { Window } from './Window.js';
import { APP_REGISTRY } from '../apps/registry.js';
import { useAuthStore, useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';

/**
 * The desktop shell: icons, windows, launcher, and taskbar.
 *
 * Apps stay mounted while minimised — only hidden — so a running terminal or a
 * half-written file survives being minimised. Closing a window unmounts it and
 * discards its local state.
 */
export function Desktop() {
  const user = useCurrentUser();
  const logout = useAuthStore((state) => state.logout);
  const windows = useDesktopStore((state) => state.windows);
  const focusedId = useDesktopStore((state) => state.focusedId);
  const setDesktopSize = useDesktopStore((state) => state.setDesktopSize);
  const desktopRef = useRef<HTMLDivElement | null>(null);

  // The usable area above the taskbar; the window manager clamps to this.
  useEffect(() => {
    const element = desktopRef.current;
    if (element === null) return;

    const observer = new ResizeObserver(() => {
      setDesktopSize(element.clientWidth, element.clientHeight);
    });
    observer.observe(element);
    setDesktopSize(element.clientWidth, element.clientHeight);

    return () => observer.disconnect();
  }, [setDesktopSize]);

  if (user === null) return null;

  const components = new Map(APP_REGISTRY.map((app) => [app.id, app.component]));

  return (
    <div className="flex h-full flex-col bg-surface-900">
      <div className="flex min-h-0 flex-1">
        {/* Left icon rail */}
        <DesktopIcons />

        {/* Window area */}
        <div ref={desktopRef} className="relative min-w-0 flex-1 overflow-hidden">
          {/* Empty-state hint, behind the windows. */}
          {windows.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <p className="text-4xl" aria-hidden="true">
                🌌
              </p>
              <p className="text-sm text-slate-400">Welcome, {user.username}.</p>
              <p className="max-w-xs text-xs text-slate-500">
                Open an app from the launcher below, or double-click a desktop icon.
              </p>
            </div>
          ) : null}

          {windows.map((window) => {
            const Component = components.get(window.appId);
            if (Component === undefined) return null;

            return (
              <Window key={window.id} instance={window} focused={window.id === focusedId}>
                {/* Keep the app mounted while minimised so its state survives. */}
                <div className={window.minimized ? 'hidden' : 'h-full'}>
                  <Component windowId={window.id} props={window.props} />
                </div>
              </Window>
            );
          })}
        </div>
      </div>

      <Launcher />
      <Taskbar onLogout={() => void logout()} />
    </div>
  );
}
