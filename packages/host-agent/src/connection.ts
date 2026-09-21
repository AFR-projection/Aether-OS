import os from 'node:os';

import { LIMITS, WS_CLOSE, type TerminalServerMessage } from '@aether/shared';
import WebSocket from 'ws';

import { subsystemLogger } from './logger.js';
import {
  agentCapabilities,
  errReply,
  helloPayloadSchema,
  parseAgentMessage,
  type Reply,
} from './protocol.js';
import { dispatchRequest, subscribeToSession } from './router.js';
import { AETHER_VERSION } from './version.js';

import type { AgentConfig } from './config.js';

const log = subsystemLogger('connection');

/**
 * Shape-check for a principal on a control frame.
 *
 * `terminal.subscribe` is not a routed request, so it never passes through
 * `parseAgentMessage` and its `ownerUserId` is not schema-validated. A value
 * that is present but malformed is refused rather than ignored: falling back to
 * the paired owner would silently subscribe as the wrong principal, which is the
 * class of bug this field exists to remove.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectionEvents {
  onHelloAck(ownerUserId: string): void;
  onClosed(code: number, reason: string): void;
}

interface PendingReply {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persistent WebSocket connection to the Aether backend.
 *
 * Behaviour:
 * - connects with `?agentId=…&token=…`, then sends a `hello` frame carrying
 *   the agent identity and capability list;
 * - dispatches inbound `request` frames through the router and replies;
 * - streams terminal `output`/`exit` frames for sessions the backend
 *   subscribed to with `terminal.subscribe`;
 * - reconnects with exponential backoff and full jitter when the socket drops;
 * - sends heartbeats so a half-open TCP connection is detected promptly.
 */
export class AgentConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private ownerUserId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private subscriptions = new Map<string, () => void>();
  private readonly pending = new Map<string, PendingReply>();
  private requestCounter = 0;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly events: ConnectionEvents
  ) {}

  start(): void {
    this.stopped = false;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection stopped'));
    }
    this.pending.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(WS_CLOSE.NORMAL, 'shutdown');
        setTimeout(() => resolve(), 2000).unref();
      });
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ownerUserId !== null;
  }

  private backendWsUrl(): string {
    const base = this.cfg.AETHER_BACKEND_URL.replace(/\/$/, '');
    const query = new URLSearchParams({
      agentId: this.cfg.AETHER_AGENT_ID,
      token: this.cfg.AETHER_PAIRING_TOKEN,
    });
    return `${base}/ws/agent?${query.toString()}`;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        // connectOnce resolves only when the socket closed unexpectedly.
        this.ownerUserId = null;
      } catch (error) {
        log.warn({ err: error }, 'connection attempt failed');
      }

      if (this.stopped) break;

      this.attempt += 1;
      const delay = this.backoffDelay(this.attempt);
      log.info({ attempt: this.attempt, delayMs: delay }, 'reconnecting');
      await sleep(delay);
    }
  }

  backoffDelay(attempt: number): number {
    const exponential = this.cfg.RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 8);
    const capped = Math.min(exponential, this.cfg.RECONNECT_MAX_DELAY_MS);
    // Full jitter: spread reconnection storms across the whole window.
    return Math.floor(Math.random() * capped) + 1;
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.backendWsUrl();
      log.info('connecting to backend');

      const socket = new WebSocket(url, {
        handshakeTimeout: 15_000,
        maxPayload: LIMITS.WS_MESSAGE_MAX_BYTES,
      });
      this.socket = socket;

      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        try {
          socket.terminate();
        } catch {
          // Already closed.
        }
        this.socket = null;
        reject(error);
      };

      socket.once('open', () => {
        log.info('websocket open, sending hello');
        this.sendHello(socket);
        this.startHeartbeat(socket);

        const helloTimer = setTimeout(() => {
          fail(new Error('Timed out waiting for hello acknowledgement'));
        }, 15_000);
        helloTimer.unref();
        this.pending.set('__hello__', {
          resolve: () => {
            clearTimeout(helloTimer);
            this.pending.delete('__hello__');
            this.attempt = 0;
          },
          reject: (error) => {
            clearTimeout(helloTimer);
            this.pending.delete('__hello__');
            fail(error);
          },
          timer: helloTimer,
        });
      });

      socket.on('message', (raw: WebSocket.RawData) => {
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > LIMITS.WS_MESSAGE_MAX_BYTES) {
          log.warn('oversize frame dropped');
          return;
        }
        void this.handleMessage(socket, text).catch((error) => {
          log.warn({ err: error }, 'failed to handle inbound frame');
        });
      });

      socket.once('error', (error: Error) => {
        log.warn({ err: error }, 'websocket error');
        if (!settled) fail(error);
      });

      socket.once('close', (code: number, reason: Buffer) => {
        const reasonText = reason.toString();
        log.info({ code, reason: reasonText }, 'websocket closed');
        this.cleanupAfterClose();
        if (!settled) {
          settled = true;
          this.socket = null;
          // Normal close after stop() resolves the loop; anything else
          // resolves so connectLoop() reconnects.
          resolve();
          this.events.onClosed(code, reasonText);
        } else {
          this.events.onClosed(code, reasonText);
        }
      });
    });
  }

  private sendHello(socket: WebSocket): void {
    const payload = {
      id: '__hello__',
      type: 'hello',
      agentId: this.cfg.AETHER_AGENT_ID,
      token: this.cfg.AETHER_PAIRING_TOKEN,
      version: AETHER_VERSION,
      platform: process.platform,
      hostname: os.hostname(),
      capabilities: [...agentCapabilities],
    };
    socket.send(JSON.stringify(payload));
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.ping();
      } catch (error) {
        log.debug({ err: error }, 'heartbeat ping failed');
      }
    }, this.cfg.HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private cleanupAfterClose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const unsubscribe of this.subscriptions.values()) {
      try {
        unsubscribe();
      } catch {
        // Unsubscribing must never throw during teardown.
      }
    }
    this.subscriptions.clear();
    this.ownerUserId = null;
  }

  private async handleMessage(socket: WebSocket, text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    const record = parsed as Record<string, unknown>;

    // Reply to a frame the agent itself sent (currently only terminal event acks).
    if (record['replyTo'] !== undefined && typeof record['replyTo'] === 'string') {
      const pending = this.pending.get(record['replyTo']);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(record['replyTo']);
        pending.resolve(record as unknown as Reply);
      }
      return;
    }

    // Hello acknowledgement from the backend.
    if (record['type'] === 'hello_ack') {
      const result = helloPayloadSchema
        .pick({ agentId: true })
        .extend({ ownerUserId: helloPayloadSchema.shape.agentId })
        .safeParse({ agentId: record['agentId'], ownerUserId: record['ownerUserId'] });
      const hello = this.pending.get('__hello__');
      if (hello) {
        if (result.success) {
          this.ownerUserId = result.data.ownerUserId;
          hello.resolve({ id: '__hello__', ok: true, result: {} });
          this.events.onHelloAck(this.ownerUserId);
          log.info('paired with backend');
        } else {
          hello.reject(new Error('Invalid hello acknowledgement'));
        }
      }
      return;
    }

    if (record['ok'] !== undefined && record['id'] !== undefined) {
      const pending = this.pending.get(String(record['id']));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(record['id']));
        pending.resolve(record as unknown as Reply);
      }
      return;
    }

    // Terminal subscription management from the backend.
    if (record['type'] === 'terminal.subscribe' && typeof record['id'] === 'string') {
      this.handleSubscribe(socket, String(record['id']), record);
      return;
    }
    if (record['type'] === 'terminal.unsubscribe' && typeof record['id'] === 'string') {
      const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : null;
      if (sessionId) this.subscriptions.get(sessionId)?.();
      if (sessionId) this.subscriptions.delete(sessionId);
      this.send(socket, { id: String(record['id']), ok: true, result: { unsubscribed: true } });
      return;
    }

    // Anything else must be a router request.
    let request;
    try {
      request = parseAgentMessage(text);
    } catch (error) {
      const id = typeof record['id'] === 'string' ? record['id'] : 'unknown';
      this.send(
        socket,
        errReply(
          id,
          'VALIDATION_FAILED',
          error instanceof Error ? error.message : 'Invalid message'
        )
      );
      return;
    }

    // Pairing is still required before anything is dispatched — a frame naming
    // its own principal does not stand in for a completed handshake. Only once
    // paired does a per-request principal override the connection's, which is
    // what lets one agent serve several users correctly.
    const paired = this.ownerUserId;
    if (!paired) {
      this.send(
        socket,
        errReply(request.id, 'UNAUTHENTICATED', 'Agent has not completed pairing yet')
      );
      return;
    }

    const reply = await dispatchRequest(this.cfg, request.ownerUserId ?? paired, request);
    this.send(socket, reply);
  }

  private handleSubscribe(socket: WebSocket, id: string, record: Record<string, unknown>): void {
    const paired = this.ownerUserId;
    if (!paired) {
      this.send(socket, errReply(id, 'UNAUTHENTICATED', 'Agent has not completed pairing yet'));
      return;
    }

    const requested = record['ownerUserId'];
    if (requested !== undefined && !UUID_PATTERN.test(String(requested))) {
      this.send(
        socket,
        errReply(id, 'VALIDATION_FAILED', 'ownerUserId must be a UUID when present')
      );
      return;
    }
    const owner = requested === undefined ? paired : String(requested);

    const sessionId = record['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      this.send(socket, errReply(id, 'VALIDATION_FAILED', 'sessionId is required'));
      return;
    }

    try {
      this.subscriptions.get(sessionId)?.();
      const unsubscribe = subscribeToSession(this.cfg, sessionId, owner, (message) => {
        this.sendTerminalEvent(socket, sessionId, message as TerminalServerMessage);
      });
      this.subscriptions.set(sessionId, unsubscribe);
      this.send(socket, { id, ok: true, result: { subscribed: true, sessionId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Subscribe failed';
      const code = (error as { code?: string }).code ?? 'NOT_FOUND';
      this.send(socket, errReply(id, code, message));
    }
  }

  private sendTerminalEvent(
    socket: WebSocket,
    sessionId: string,
    message: TerminalServerMessage
  ): void {
    this.requestCounter += 1;
    this.send(socket, {
      id: `evt-${Date.now()}-${this.requestCounter}`,
      type: 'terminal.event',
      sessionId,
      event: message,
    });
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      log.debug({ err: error }, 'failed to send frame');
    }
  }
}
