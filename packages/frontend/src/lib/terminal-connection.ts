/**
 * Terminal transport.
 *
 * The socket handshake cannot carry an `Authorization` header, so the flow is:
 *
 *   1. `POST /api/terminal/sessions/:id/ticket` over normal authenticated HTTP,
 *   2. open `WS /ws/terminal/:id?ticket=…` with that single-use ticket.
 *
 * Tickets are consumed on redeem and expire after 30 seconds, so every
 * reconnect fetches a new one. A ticket that leaks into a proxy access log is
 * therefore useless almost immediately.
 *
 * Input is coalesced before it is sent. `xterm.js` emits one `onData` callback
 * per keystroke, and a fast typist pasting a large block would otherwise burn
 * the server's per-connection frame budget; batching on a short timer keeps the
 * frame count low without adding perceptible latency.
 */

import { apiRequest } from './api-client.js';

import type { TerminalClientMessage, TerminalServerMessage } from '@aether/shared';


/** WebSocket close codes used by the backend; mirrored from `WS_CLOSE`. */
const CLOSE_UNAUTHENTICATED = 4001;
const CLOSE_FORBIDDEN = 4003;
const CLOSE_SESSION_NOT_FOUND = 4004;
const CLOSE_RATE_LIMITED = 4029;

/** Codes after which reconnecting cannot succeed. */
const TERMINAL_CLOSE_CODES: readonly number[] = [
  CLOSE_UNAUTHENTICATED,
  CLOSE_FORBIDDEN,
  CLOSE_SESSION_NOT_FOUND,
];

const INPUT_FLUSH_INTERVAL_MS = 8;
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

export type TerminalConnectionState =
  'idle' | 'requesting-ticket' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TerminalConnectionEvents {
  onMessage: (message: TerminalServerMessage) => void;
  onStateChange: (state: TerminalConnectionState, detail?: string) => void;
}

export class TerminalConnection {
  private readonly sessionId: string;
  private readonly events: TerminalConnectionEvents;

  private socket: WebSocket | null = null;
  private state: TerminalConnectionState = 'idle';
  private disposed = false;
  private attempt = 0;

  private readonly pendingInput: string[] = [];
  private flushTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;

  constructor(sessionId: string, events: TerminalConnectionEvents) {
    this.sessionId = sessionId;
    this.events = events;
  }

  get currentState(): TerminalConnectionState {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.setState('requesting-ticket');
    await this.openSocket();
  }

  private setState(state: TerminalConnectionState, detail?: string): void {
    this.state = state;
    this.events.onStateChange(state, detail);
  }

  private async openSocket(): Promise<void> {
    let ticket: string;
    try {
      const issued = await apiRequest<{ ticket: string; expiresIn: number }>(
        `/api/terminal/sessions/${this.sessionId}/ticket`,
        { method: 'POST' }
      );
      ticket = issued.ticket;
    } catch (error) {
      if (this.disposed) return;

      // A 404 means the shell is gone for good; anything else may be transient.
      const notFound =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? (error as { statusCode: number }).statusCode === 404
          : false;

      if (notFound) {
        this.setState('closed', 'This terminal session no longer exists.');
        return;
      }

      this.scheduleReconnect('Could not obtain a terminal ticket.');
      return;
    }

    if (this.disposed) return;
    this.setState('connecting');

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}/ws/terminal/${this.sessionId}?ticket=${encodeURIComponent(ticket)}`;

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as TerminalServerMessage;
        this.events.onMessage(message);
      } catch {
        // A frame that is not valid JSON cannot be interpreted; dropping it is
        // safer than guessing at its meaning.
      }
    };

    socket.onerror = () => {
      // `onerror` carries no detail by design (it would leak cross-origin
      // information). The close handler reports the actionable reason.
    };

    socket.onclose = (event) => {
      this.stopHeartbeat();
      this.socket = null;
      if (this.disposed) return;

      if (TERMINAL_CLOSE_CODES.includes(event.code)) {
        this.setState('closed', describeClose(event.code));
        return;
      }

      if (event.code === CLOSE_RATE_LIMITED) {
        this.scheduleReconnect('Too many connection attempts. Waiting before retrying.');
        return;
      }

      this.scheduleReconnect(`Connection lost (${event.code}).`);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.reconnectTimer !== null) return;

    this.attempt += 1;
    // Exponential backoff with jitter: a backend restart would otherwise bring
    // every open terminal back in the same millisecond.
    const base = Math.min(500 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    const delay = base + Math.floor(Math.random() * 250);

    this.setState('reconnecting', reason);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(message: TerminalClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  /** Queues keystrokes; they are flushed as one frame shortly afterwards. */
  sendInput(data: string): void {
    this.pendingInput.push(data);
    if (this.flushTimer !== null) return;

    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flushInput();
    }, INPUT_FLUSH_INTERVAL_MS);
  }

  private flushInput(): void {
    if (this.pendingInput.length === 0) return;
    const data = this.pendingInput.join('');
    this.pendingInput.length = 0;
    this.send({ type: 'input', data });
  }

  sendResize(cols: number, rows: number): void {
    // A resize is only meaningful once the socket is open, and sending it while
    // connecting would be dropped silently by `send`.
    this.send({ type: 'resize', cols, rows });
  }

  sendSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    this.flushInput();
    this.send({ type: 'signal', signal });
  }

  /** Closes the socket. The server-side shell is deliberately left running. */
  dispose(): void {
    this.disposed = true;
    this.flushInput();

    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();

    this.flushTimer = null;
    this.reconnectTimer = null;

    // 1000 ("normal closure") rather than 1001: the reason is intentional and
    // the backend must not treat it as a server-initiated shutdown.
    this.socket?.close(1000, 'client detached');
    this.socket = null;
    this.setState('closed');
  }
}

function describeClose(code: number): string {
  switch (code) {
    case CLOSE_UNAUTHENTICATED:
      return 'Your session expired. Sign in again to reconnect.';
    case CLOSE_FORBIDDEN:
      return 'You do not have permission to attach to this terminal.';
    case CLOSE_SESSION_NOT_FOUND:
      return 'This terminal session no longer exists.';
    default:
      return `Connection closed (${code}).`;
  }
}
