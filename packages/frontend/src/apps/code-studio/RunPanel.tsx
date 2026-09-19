import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Play, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultRunCommand, directoryOf } from './run-command.js';
import { Button } from '../../components/ui/Button.js';
import { createTerminalSession, killTerminalSession } from '../../lib/terminal-api.js';
import { TerminalConnection } from '../../lib/terminal-connection.js';

import type { FsScope } from '../files/files-api.js';
import type { TerminalServerMessage } from '@aether/shared';

import '@xterm/xterm/css/xterm.css';

/**
 * The Run panel: executes the open file in a real process.
 *
 * This is not an interpreter written in JavaScript and it is not a simulation.
 * The command runs in a genuine PTY — the same `node-pty` machinery the
 * Terminal app uses — so output is real output, `stdin` works, a program that
 * prompts for input waits for it, and Ctrl+C reaches the process. A program
 * that reads from the terminal is therefore runnable, which a captured
 * `child_process.exec` would not give you.
 *
 * The command is visible and editable before it runs. Guessing an interpreter
 * from the extension and firing it off would be the wrong default for anything
 * but a single-file script, and the panel is a poor place to discover that the
 * guess was wrong after the fact.
 */

/** The same palette the Terminal app uses, so one shell does not look like two. */
const RUN_TERMINAL_THEME = {
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

export interface RunPanelProps {
  /** Path of the file to run, relative to the scope root. */
  path: string;
  fs: FsScope;
  onClose: () => void;
}

export function RunPanel({ path, fs, onClose }: RunPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const sessionRef = useRef<string | null>(null);

  const [command, setCommand] = useState(() => defaultRunCommand(path));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The suggested command follows the file being viewed, but never overwrites
  // something the user typed for the file they are still on.
  const suggestedFor = useRef(path);
  useEffect(() => {
    if (suggestedFor.current === path) return;
    suggestedFor.current = path;
    setCommand(defaultRunCommand(path));
  }, [path]);

  // Build the xterm instance once, and tear it down when the panel closes.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: RUN_TERMINAL_THEME,
      allowProposedApi: false,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const raf = window.requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // Not measurable yet; the observer below runs once it is.
      }
    });

    return () => {
      window.cancelAnimationFrame(raf);
      connectionRef.current?.dispose();
      connectionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Keep the terminal sized to the panel.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const observer = new ResizeObserver(() => {
      const fit = fitRef.current;
      if (fit === null) return;
      try {
        fit.fit();
        const terminal = terminalRef.current;
        const connection = connectionRef.current;
        if (terminal !== null && connection !== null) {
          connection.sendResize(terminal.cols, terminal.rows);
        }
      } catch {
        // A resize during teardown is not worth surfacing.
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const stop = useCallback(async () => {
    const id = sessionRef.current;
    if (id === null) return;
    try {
      await killTerminalSession(id);
      terminalRef.current?.write('\r\n\x1b[90m[stopped]\x1b[0m\r\n');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not stop the process.');
    } finally {
      setRunning(false);
      setSessionId(null);
      sessionRef.current = null;
    }
  }, []);

  const run = useCallback(async () => {
    const terminal = terminalRef.current;
    if (terminal === null || command.trim() === '') return;

    // A previous run that is still alive would otherwise be orphaned.
    if (sessionRef.current !== null) await stop();

    terminal.reset();
    setError(null);
    setExitCode(null);
    setRunning(true);

    let created: { id: string; cols: number; rows: number };
    try {
      const cols = Math.max(terminal.cols, 40);
      const rows = Math.max(terminal.rows, 10);
      created = await createTerminalSession({
        cols,
        rows,
        cwd: directoryOf(path),
        command,
        fs,
      });
    } catch (cause) {
      setRunning(false);
      setError(cause instanceof Error ? cause.message : 'The command could not be started.');
      return;
    }

    sessionRef.current = created.id;
    setSessionId(created.id);

    const connection = new TerminalConnection(created.id, {
      onMessage: (message: TerminalServerMessage) => {
        switch (message.type) {
          case 'output':
            terminal.write(message.data);
            break;
          case 'exit':
            setExitCode(message.exitCode);
            setRunning(false);
            terminal.write(`\r\n\x1b[90m[exited with code ${message.exitCode}]\x1b[0m\r\n`);
            break;
          case 'error':
            setError(message.message);
            setRunning(false);
            break;
          case 'ready':
          case 'pong':
            break;
        }
      },
      onStateChange: () => {
        // The Run panel is a short-lived session; a dropped socket is reported
        // by the exit frame or the error frame rather than by the transport.
      },
    });

    connectionRef.current = connection;
    void connection.connect();
  }, [command, fs, path, stop]);

  /**
   * Forwards typing to whichever connection is current.
   *
   * Registered once against `connectionRef` rather than per run, so a second run
   * does not leave the first run's subscription behind writing into a socket
   * that is already gone. This is what makes the panel a real interactive
   * session: a program that prompts for input gets the keystrokes.
   */
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    const subscription = terminal.onData((data) => connectionRef.current?.sendInput(data));
    return () => subscription.dispose();
  }, []);

  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-white/10 bg-surface-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Run</span>

        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !running) void run();
          }}
          spellCheck={false}
          placeholder="Command to run in this file's directory"
          aria-label="Command to run"
          className="h-7 min-w-0 flex-1 rounded border border-white/10 bg-surface-800 px-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-accent focus:outline-none"
        />

        {running && sessionId !== null ? (
          <Button size="sm" variant="danger" onClick={() => void stop()} title="End the process">
            <Square size={12} className="mr-1 inline" aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void run()}
            disabled={command.trim() === ''}
            title="Run in a real pty, in this file's directory"
          >
            <Play size={12} className="mr-1 inline" aria-hidden="true" />
            Run
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => terminalRef.current?.clear()}
          title="Clear the output"
        >
          <Trash2 size={13} aria-hidden="true" />
        </Button>

        <Button size="sm" variant="ghost" onClick={onClose} title="Close the run panel">
          <X size={13} aria-hidden="true" />
        </Button>
      </div>

      {error !== null ? (
        <div className="border-b border-red-500/30 bg-red-950/40 px-3 py-1 text-[11px] text-red-200">
          {error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
      </div>

      <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1 text-[11px] text-slate-500">
        <span>{fs.scope === 'host' ? 'runs on the host' : 'runs in the backend workspace'}</span>
        <span className="flex-1" />
        {exitCode !== null ? <span>exit code {exitCode}</span> : null}
        {running ? <span className="text-emerald-400">running</span> : null}
      </div>
    </div>
  );
}
