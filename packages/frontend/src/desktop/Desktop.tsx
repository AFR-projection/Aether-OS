import { useEffect, useRef } from 'react';

import { DesktopIcons } from './DesktopIcons.js';
import { Launcher } from './Launcher.js';
import { Shell } from './Shell.js';
import { useDesktopLayout } from './useDesktopLayout.js';
import { useTerminalRecovery } from './useTerminalRecovery.js';
import { Window } from './Window.js';
import { APP_REGISTRY } from '../apps/registry.js';
import { ErrorBoundary } from '../components/ui/ErrorBoundary.js';
import { useAuthStore, useCurrentUser } from '../stores/auth.store.js';
import { useDesktopStore } from '../stores/desktop.store.js';
import { useActiveTheme } from '../stores/theme.store.js';

import type { ThemeId } from '../lib/themes.js';

/**
 * The desktop shell: wallpaper, icons, windows, launcher, and the OS shell
 * bars. The shell bars, window chrome, and wallpaper all follow the active
 * theme so the desktop reads as the chosen OS.
 *
 * Apps stay mounted while minimised — only hidden — so a running terminal or a
 * half-written file survives being minimised. Closing a window unmounts it and
 * discards its local state.
 */

/** An authentic wallpaper per OS: Windows 11 Bloom blue, macOS Sequoia-style
 *  spectrum, and the Adwaita blue-violet. Pure CSS so there is no image to ship. */
const WALLPAPERS: Record<ThemeId, string> = {
  win11:
    'radial-gradient(120% 120% at 70% 15%, #1a4da8 0%, #123a7a 32%, #0a1f47 70%, #060f26 100%)',
  macos: 'linear-gradient(150deg, #2b1b4d 0%, #3d2a6b 22%, #6d3f8a 45%, #b5527a 68%, #e08b5f 100%)',
  gnome:
    'radial-gradient(130% 130% at 30% 20%, #4a5fd0 0%, #3a3f9e 38%, #2a2c66 72%, #1a1c3d 100%)',
};

export function Desktop() {
  const user = useCurrentUser();
  const logout = useAuthStore((state) => state.logout);
  const windows = useDesktopStore((state) => state.windows);
  const focusedId = useDesktopStore((state) => state.focusedId);
  const setDesktopSize = useDesktopStore((state) => state.setDesktopSize);
  const desktopRef = useRef<HTMLDivElement | null>(null);
  const { id: themeId } = useActiveTheme();

  // The usable area for windows; the window manager clamps to this.
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

  const registry = new Map(APP_REGISTRY.map((app) => [app.id, app]));

  // Reattach live shells after a browser refresh. Gated on the terminal
  // permission — a user who cannot create a terminal has no sessions to recover,
  // and passing `undefined` makes the hook a no-op. Called before the
  // `user === null` guard so it is never conditional.
  const terminalApp = registry.get('terminal');
  const canUseTerminal =
    user !== null &&
    (terminalApp?.requiredPermission === undefined ||
      user.permissions.includes(terminalApp.requiredPermission));
  useTerminalRecovery(canUseTerminal ? terminalApp : undefined);

  // Restore and persist the per-user window layout. Runs for any signed-in
  // user; gated on `user` only so it does nothing on the login screen.
  useDesktopLayout(user !== null);

  if (user === null) return null;

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: WALLPAPERS[themeId], backgroundSize: 'cover' }}
    >
      <Shell position="top" onLogout={() => void logout()} />

      {/* Window area. Ref is here so the window manager measures only the space
          windows may occupy, never the shell bars. */}
      <div ref={desktopRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <DesktopIcons />

        {windows.map((window) => {
          const app = registry.get(window.appId);
          if (app === undefined) return null;

          const Component = app.component;

          return (
            <Window key={window.id} instance={window} focused={window.id === focusedId}>
              {/* Keep the app mounted while minimised so its state survives. */}
              <div className={window.minimized ? 'hidden' : 'h-full'}>
                {/* One boundary per window: a crash here shows a fallback in
                    this window only and never unmounts the desktop. */}
                <ErrorBoundary label={app.name} resetKey={window.appId}>
                  <Component windowId={window.id} props={window.props} />
                </ErrorBoundary>
              </div>
            </Window>
          );
        })}

        <Launcher />
      </div>

      <Shell position="bottom" onLogout={() => void logout()} />
    </div>
  );
}
