import { useEffect, useRef } from 'react';

import { listTerminalSessions } from '../lib/terminal-api.js';
import { useDesktopStore } from '../stores/desktop.store.js';

import type { AppDefinition } from '../apps/registry.js';

/**
 * Reattaches live shells to the desktop after a browser refresh.
 *
 * The window manager holds no persistence: a refresh empties it, and every
 * terminal window is gone from the client even though the shell it was bound to
 * is still alive. The backend, though, was not restarted by a refresh — its
 * `hostSessions` map and the agent's PTYs both survived — so the honest way back
 * is discovery, not a saved layout. This lists the caller's live sessions and
 * reopens a terminal window bound to each one, and the existing reattach path in
 * `TerminalApp` (a window opened with a `sessionId` prop attaches to that shell
 * and replays its scrollback) does the rest.
 *
 * What it deliberately does not do:
 *
 * - It does not resurrect a dead shell. Only a session the server still reports
 *   as `starting` or `running` reopens; an `exited` or `killed` one is left
 *   closed, because reopening it would put a window on screen for a process that
 *   is not there. The server reconciles each session against its agent before it
 *   answers, so a shell that ended on its own is already reported ended.
 * - It does not restore window geometry. The desktop never persisted geometry
 *   for any app; a recovered terminal opens at the default cascade position. The
 *   claim is "your shell is still here", not "your screen is pixel-identical".
 * - It runs once, and only onto an empty desktop. If the user already has
 *   terminal windows open (a second tab, a fast re-render) it does nothing,
 *   so it can never double-open a shell.
 */
export function useTerminalRecovery(terminalApp: AppDefinition | undefined): void {
  const recoveredRef = useRef(false);

  useEffect(() => {
    if (terminalApp === undefined || recoveredRef.current) return;
    recoveredRef.current = true;

    let cancelled = false;

    void (async () => {
      let sessions;
      try {
        sessions = await listTerminalSessions();
      } catch {
        // A failed discovery must not block the desktop from loading. The user
        // can still open a terminal by hand; nothing is lost that a manual
        // reconnect cannot recover.
        return;
      }
      if (cancelled) return;

      const store = useDesktopStore.getState();

      // Only onto a clean desktop. A window already bound to one of these
      // sessions must never be duplicated.
      const alreadyOpen = new Set(
        store.windows
          .filter((window) => window.appId === terminalApp.id)
          .map((window) => window.props.sessionId)
          .filter((id): id is string => typeof id === 'string')
      );

      for (const session of sessions) {
        if (session.status !== 'running' && session.status !== 'starting') continue;
        if (alreadyOpen.has(session.id)) continue;

        store.openWindow(terminalApp.id, {
          singleton: false,
          width: terminalApp.defaultSize.width,
          height: terminalApp.defaultSize.height,
          title: `Terminal — ${session.shell.split('/').pop() ?? 'shell'}`,
          // These are exactly the props `TerminalApp` reads to pin a window to an
          // existing shell: a session id makes it reattach rather than create,
          // and the scope pins it to the endpoint that owns the PTY.
          props: {
            sessionId: session.id,
            ...(session.scope === 'host' && session.agentId !== undefined
              ? { scope: 'host', agentId: session.agentId }
              : {}),
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [terminalApp]);
}
