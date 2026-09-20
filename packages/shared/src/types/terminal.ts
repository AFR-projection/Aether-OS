/** Lifecycle state of a server-side PTY session. */
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'killed';

export interface TerminalSession {
  id: string;
  /** OS process id of the shell. `null` until the PTY has spawned. */
  pid: number | null;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  lastActivityAt: string;
  /** Number of WebSocket clients currently attached. */
  attachedClients: number;
}

/**
 * A session as the listing endpoint reports it.
 *
 * `GET /api/terminal/sessions` merges workspace and host sessions, and a client
 * that wants to re-open a window bound to one needs to know which scope it lives
 * in — and, for a host session, which agent owns it. Those two fields are
 * backend bookkeeping that the bare `TerminalSession` does not carry, so they
 * are added here rather than onto the session the PTY layer produces.
 */
export interface TerminalSessionSummary extends TerminalSession {
  scope: 'workspace' | 'host';
  /** The owning agent, for a host session. Absent for a workspace session. */
  agentId?: string;
}

export interface CreateTerminalRequest {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
}

/** Messages sent by the browser to the backend over `/ws/terminal/:id`. */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }
  | { type: 'ping' };

/** Messages sent by the backend to the browser over `/ws/terminal/:id`. */
export type TerminalServerMessage =
  | { type: 'ready'; sessionId: string; pid: number; shell: string; cwd: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal: number | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: string };
