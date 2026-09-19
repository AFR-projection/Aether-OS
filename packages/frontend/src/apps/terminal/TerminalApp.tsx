import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { apiRequest } from '../../lib/api-client.js';
import { useFsScope, effectiveScope } from '../../lib/fs-scope.js';
import { TerminalConnection, type TerminalConnectionState } from '../../lib/terminal-connection.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { isHostScope, type FsScope } from '../files/files-api.js';

import type { AppProps } from '../registry.js';
import type { TerminalServerMessage, TerminalSession } from '@aether/shared';

import '@xterm/xterm/css/xterm.css';

/**
 * The Terminal app.
 *
 * This is a real PTY on the host: keystrokes go to the backend over a
 * WebSocket, are written to a `node-pty` process, and its output is streamed
 * back. Nothing here is simulated — if `node-pty` is unavailable on the host the
 * backend reports it and this app says so instead of pretending to type.
 *
 * The shell survives detaching. Closing this window disposes the socket but not
 * the server-side session, so reopening from the taskbar re-attaches to the same
 * shell with its scrollback replayed.
 */

const TERMINAL_THEME = {
  background: '#0b1020',
  foreground: '#e2e8f0',
  cursor: '#4f8cff',
  cursorAccent: '#0b1020',
  selectionBackground: '#2c3760',
  black: '#1e293b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#475569',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
} as const;

const STATE_LABEL: Record<TerminalConnectionState, string> = {
  idle: 'idle',
  'requesting-ticket': 'connecting',
  connecting: 'connecting',
  open: 'connected',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

const STATE_TONE: Record<TerminalConnectionState, string> = {
  idle: 'text-slate-400',
  'requesting-ticket': 'text-amber-300',
  connecting: 'text-amber-300',
  open: 'text-emerald-400',
  reconnecting: 'text-amber-300',
  closed: 'text-red-400',
};

export function TerminalApp({ windowId, props }: AppProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  /** Prevents a second PTY being created if the effect re-runs. */
  const creationStartedRef = useRef(false);

  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);
  const setWindowProps = useDesktopStore((state) => state.setWindowProps);

  const [sessionId, setSessionId] = useState<string | null>(
    typeof props.sessionId === 'string' ? props.sessionId : null
  );
  /**
   * Where this shell runs.
   *
   * A window opened with an explicit scope keeps it, as does one reattaching to
   * an existing session. Otherwise the scope settles on a connected host agent,
   * because a shell on the real machine is the whole point of the app.
   *
   * Defaulting to the backend container instead is how `aether status` came
   * back "command not found": the CLI is installed on the host, and the shell
   * was not. The container is still reachable from the picker — it is just no
   * longer what an operator gets by accident.
   */
  const scope = useFsScope(props, { pinned: typeof props.sessionId === 'string' });
  const { fs, setFs, connectedAgents } = scope;

  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [exited, setExited] = useState<{ code: number | null } | null>(null);
  const [fatalError, setFatalError] = useState<unknown>(null);

  /** The scope in use, or the workspace while the choice is still pending. */
  const activeFs: FsScope = effectiveScope(scope);

  /** Creates a new server-side shell in the given scope and binds this window to it. */
  const createSession = useCallback(
    async (cols: number, rows: number, scope: FsScope) => {
      const scopeFields = isHostScope(scope)
        ? { scope: 'host' as const, agentId: scope.agentId }
        : {};
      const session = await apiRequest<TerminalSession>('/api/terminal/sessions', {
        method: 'POST',
        body: { cols, rows, ...scopeFields },
      });

      setSessionId(session.id);
      // Persist the scope alongside the session id so reopening from the taskbar
      // and the "New" button both remember where this terminal lives. The
      // workspace is left implicit: a session id alone already pins a window to
      // the workspace, and writing `scope: 'workspace'` for a fallback would
      // record a decision nobody made as though somebody had.
      setWindowProps(windowId, {
        sessionId: session.id,
        ...(isHostScope(scope) ? { scope: 'host', agentId: scope.agentId } : {}),
      });
      setWindowTitle(windowId, `Terminal — ${session.shell.split('/').pop() ?? 'shell'}`);
      setExited(null);
      return session.id;
    },
    [setWindowProps, setWindowTitle, windowId]
  );

  // Build the xterm instance exactly once per window and tear it down on close.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: TERMINAL_THEME,
      allowProposedApi: false,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // Links are rendered but not opened automatically; opening a URL from a
    // terminal on someone's click is a phishing vector when the output is
    // attacker-influenced (a log line, a `curl`ed script).
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    // The container has no size until the window has been laid out.
    const raf = window.requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // `fit` throws when the element is not measurable yet; the observer
        // below will run once it is.
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        const connection = connectionRef.current;
        if (connection !== null) connection.sendResize(terminal.cols, terminal.rows);
      } catch {
        // Ignore: a resize during teardown is not an error worth surfacing.
      }
    });
    observer.observe(host);

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      connectionRef.current?.dispose();
      connectionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Create or attach the session, then open the socket for it.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null || sessionId === null || exited !== null) return;

    const connection = new TerminalConnection(sessionId, {
      onMessage: (message: TerminalServerMessage) => {
        switch (message.type) {
          case 'ready':
            setConnectionState('open');
            setStatusMessage(null);
            setWindowTitle(windowId, `Terminal — ${message.shell.split('/').pop() ?? 'shell'}`);
            break;
          case 'output':
            terminal.write(message.data);
            break;
          case 'exit':
            setExited({ code: message.exitCode });
            terminal.write(`\r\n\x1b[90m[process exited with code ${message.exitCode}]\x1b[0m\r\n`);
            break;
          case 'error':
            setStatusMessage(message.message);
            break;
          case 'pong':
            break;
        }
      },
      onStateChange: (state, detail) => {
        setConnectionState(state);
        if (detail !== undefined) setStatusMessage(detail);
      },
    });

    connectionRef.current = connection;
    void connection.connect();

    const inputSubscription = terminal.onData((data) => {
      connection.sendInput(data);
    });

    return () => {
      inputSubscription.dispose();
      connection.dispose();
      connectionRef.current = null;
    };
  }, [sessionId, exited, setWindowTitle, windowId]);

  // First mount: create the shell if this window was not opened with one.
  useEffect(() => {
    // Hold off until the scope is decided — see the effect that settles it.
    if (fs === undefined) return;
    if (sessionId !== null || creationStartedRef.current) return;
    creationStartedRef.current = true;

    const terminal = terminalRef.current;
    const cols = terminal?.cols ?? 80;
    const rows = terminal?.rows ?? 24;

    void createSession(cols, rows, fs).catch((error: unknown) => {
      setFatalError(error);
    });
  }, [createSession, sessionId, fs]);

  const handleReconnect = useCallback(() => {
    setExited(null);
    const connection = connectionRef.current;
    if (connection !== null) {
      void connection.connect();
    }
  }, []);

  const handleNewSession = useCallback(() => {
    const terminal = terminalRef.current;
    setSessionId(null);
    setExited(null);
    setStatusMessage(null);
    terminal?.reset();
    void createSession(terminal?.cols ?? 80, terminal?.rows ?? 24, activeFs).catch(
      (error: unknown) => {
        setFatalError(error);
      }
    );
  }, [createSession, activeFs]);

  /** Switches this window to a new shell in another scope (workspace or a host agent). */
  const changeLocation = useCallback(
    (next: FsScope) => {
      const terminal = terminalRef.current;
      setFs(next);
      setSessionId(null);
      setExited(null);
      setStatusMessage(null);
      terminal?.reset();
      void createSession(terminal?.cols ?? 80, terminal?.rows ?? 24, next).catch(
        (error: unknown) => {
          setFatalError(error);
        }
      );
    },
    [createSession]
  );

  const handleKill = useCallback(async () => {
    if (sessionId === null) return;
    try {
      await apiRequest<void>(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' });
      setExited({ code: null });
      terminalRef.current?.write('\r\n\x1b[90m[session terminated]\x1b[0m\r\n');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not terminate the session.');
    }
  }, [sessionId]);

  if (fatalError !== null) {
    return <ErrorState error={fatalError} onRetry={handleNewSession} />;
  }

  return (
    <div className="flex h-full flex-col bg-surface-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <select
          aria-label="Terminal location"
          value={isHostScope(fs) ? `host:${fs.agentId}` : 'workspace'}
          onChange={(event) => {
            const value = event.target.value;
            changeLocation(
              value === 'workspace'
                ? { scope: 'workspace' }
                : { scope: 'host', agentId: value.slice('host:'.length) }
            );
          }}
          title="Where this shell runs"
          className="h-7 rounded border border-white/10 bg-surface-800 px-2 text-xs text-slate-100 focus:border-accent focus:outline-none"
        >
          <option value="workspace">Workspace (backend)</option>
          {connectedAgents.map((agent) => (
            <option key={agent.agentId} value={`host:${agent.agentId}`}>
              {agent.label} (host)
            </option>
          ))}
          {isHostScope(fs) && !connectedAgents.some((agent) => agent.agentId === fs.agentId) ? (
            <option value={`host:${fs.agentId}`}>host (disconnected)</option>
          ) : null}
        </select>

        <div className="mx-1 h-5 w-px bg-white/10" />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => connectionRef.current?.sendSignal('SIGINT')}
          disabled={connectionState !== 'open'}
          title="Send Ctrl+C to the foreground process"
        >
          ^C
        </Button>

        <Button size="sm" variant="ghost" onClick={handleNewSession} title="Start a new shell">
          New
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={handleReconnect}
          disabled={connectionState === 'open' || connectionState === 'connecting'}
          title="Re-attach to this shell"
        >
          Reconnect
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => terminalRef.current?.clear()}
          title="Clear the visible scrollback"
        >
          Clear
        </Button>

        <div className="flex-1" />

        <span className={`text-[11px] ${STATE_TONE[connectionState]}`}>
          {STATE_LABEL[connectionState]}
        </span>

        <Button
          size="sm"
          variant="danger"
          onClick={() => void handleKill()}
          disabled={sessionId === null || exited !== null}
          title="Terminate the shell process"
        >
          Kill
        </Button>
      </div>

      {statusMessage !== null ? (
        <div className="border-b border-amber-500/30 bg-amber-950/40 px-3 py-1 text-[11px] text-amber-100">
          {statusMessage}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="terminal-host" />

        {sessionId === null && fatalError === null ? (
          <div className="pointer-events-none absolute inset-0 bg-surface-900">
            <LoadingState label="Starting a shell…" />
          </div>
        ) : null}

        {exited !== null ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-white/10 bg-surface-800/95 px-3 py-2">
            <span className="text-xs text-slate-300">
              The shell has exited
              {exited.code !== null ? ` with code ${exited.code}` : ''}.
            </span>
            <Button size="sm" variant="primary" onClick={handleNewSession}>
              Start a new shell
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
