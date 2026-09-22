import {
  ERROR_CODES,
  LIMITS,
  WS_CLOSE,
  unitClientMessageSchema,
  type UnitServerMessage,
} from '@aether/shared';

import { redeemTicket } from '../security/ws-ticket.js';
import { subscribeHostUnit } from '../services/host-units.service.js';
import { AppError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

import type { FastifyInstance } from 'fastify';

const log = subsystemLogger('units-ws');

/**
 * Per-connection rate limit for inbound frames.
 *
 * Far lower than the terminal's 200/s, because this channel carries exactly one
 * kind of frame. A client sending anything at volume here is either broken or
 * probing; neither deserves the benefit of a generous ceiling.
 */
const MAX_FRAMES_PER_SECOND = 20;

/**
 * The unit stream — `/ws/units/:id`.
 *
 * The live half of the execution-unit surface. REST can say what a unit *is*
 * (`/api/units/:id`) and what it has printed so far (`/api/units/:id/log`), but
 * only a socket can say what it is doing *now*: output as it arrives, the state
 * change when it ends, a restart attempt. That is what this carries.
 *
 * ## What it does, end to end
 *
 * browser → `/ws/units/:id?agentId=…&ticket=…` → ticket redeem → `units.get`
 * (ownership enforced by the agent) → `units.subscribe` → the agent's retained
 * replay, then live `unit.event` frames → one frame per event to the browser.
 * Every hop is the real one: the process is on the host, the events come from
 * the agent that owns it, and nothing here invents a state the agent did not
 * report.
 *
 * ## Read-only on purpose
 *
 * A client cannot signal, kill or restart a unit over this socket — the schema
 * admits `ping` and nothing else. Those acts live on the REST routes, where they
 * pass a permission check and write an audit event; a frame that performed one
 * would be the same act with neither, and would make the audit log a record of
 * what was done over HTTP rather than what was done. The refusal names the route
 * to use so a client is not left guessing.
 *
 * ## Why the client names the agent
 *
 * The backend keeps no unit bookkeeping (see `host-units.service` for why that
 * is what makes a backend restart invisible to a running unit), so it cannot map
 * a unit id to a host. The client already holds the unit, which carries its
 * `agentId`, and says which host it means — the same contract every REST call on
 * a single unit follows. Naming the wrong host is answered as "no such unit",
 * not as a stream of someone else's process.
 */
export function registerUnitWebSocket(app: FastifyInstance): void {
  app.get('/ws/units/:id', { websocket: true }, (socket, request) => {
    const params = request.params as { id?: string };
    const unitId = params.id;

    if (!unitId) {
      socket.close(WS_CLOSE.POLICY_VIOLATION, 'Missing unit id');
      return;
    }

    const query = request.query as { ticket?: string; agentId?: string };
    const ticket = query.ticket;
    const agentId = query.agentId;

    if (!agentId) {
      socket.close(WS_CLOSE.POLICY_VIOLATION, 'Missing agent id');
      return;
    }

    if (!ticket) {
      socket.close(WS_CLOSE.UNAUTHENTICATED, 'Missing ticket');
      return;
    }

    // The handshake completes before the ticket is redeemed because
    // `@fastify/websocket` gives no pre-upgrade hook. An unauthenticated client
    // therefore learns nothing and can send nothing: the socket stays silent
    // until the ticket checks out, and closes immediately when it does not.
    void (async () => {
      let userId: string;
      try {
        ({ userId } = await redeemTicket(ticket, unitId));
      } catch (error) {
        log.warn({ err: error, unitId }, 'unit stream ticket rejected');
        socket.close(WS_CLOSE.UNAUTHENTICATED, 'Invalid ticket');
        return;
      }

      const frameBudget = { count: 0, windowStart: Date.now() };

      /**
       * Events that arrived before `ready` was sent.
       *
       * The agent writes its replayed output *before* it answers the subscribe,
       * so events can beat the reply back. They are held rather than dropped or
       * forwarded: a client must see `ready` first — it is what tells the client
       * which unit it is looking at — and losing the replay would defeat the
       * point of a late attach. The backlog is bounded by the agent's output
       * ring, which is what the agent replays from.
       */
      const backlog: UnitServerMessage[] = [];
      let ready = false;

      const emit = (message: UnitServerMessage): void => {
        if (ready) send(socket, message);
        else backlog.push(message);
      };

      let unsubscribe: (() => void) | null = null;
      try {
        const attached = await subscribeHostUnit(agentId, unitId, userId, emit);
        unsubscribe = attached.unsubscribe;

        // A socket that closed while the attach was in flight has already fired
        // its last event, and the `close` listener below was not registered in
        // time to hear it. Releasing here is what keeps the subscription from
        // outliving the client that asked for it.
        if (socket.readyState !== socket.OPEN) {
          unsubscribe();
          return;
        }

        send(socket, {
          type: 'ready',
          unitId: attached.unit.id,
          agentId,
          unit: attached.unit,
        });
      } catch (error) {
        // The agent answers a unit that is not this user's exactly as it answers
        // one that does not exist, and this does not try to tell them apart. It
        // does not invent a message either: an `AppError`'s own text and code are
        // carried through, because they are what the same refusal says over REST,
        // and a client that gets "the host agent is not connected" learns
        // something true that a generic "not available" would have hidden.
        const code = error instanceof AppError ? error.code : ERROR_CODES.INTERNAL_ERROR;
        const message =
          error instanceof AppError ? error.message : 'The unit stream could not be established';
        log.warn({ err: error, unitId, agentId }, 'unit stream attach failed');
        send(socket, { type: 'error', code, message });
        socket.close(closeCodeFor(code), 'Unit stream refused');
        return;
      }

      ready = true;
      for (const message of backlog) send(socket, message);
      backlog.length = 0;

      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const now = Date.now();
        if (now - frameBudget.windowStart >= 1_000) {
          frameBudget.windowStart = now;
          frameBudget.count = 0;
        }
        frameBudget.count += 1;

        if (frameBudget.count > MAX_FRAMES_PER_SECOND) {
          send(socket, {
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'Too many messages',
          });
          socket.close(WS_CLOSE.RATE_LIMITED, 'Rate limited');
          return;
        }

        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');

        if (Buffer.byteLength(text, 'utf8') > LIMITS.WS_MESSAGE_MAX_BYTES) {
          send(socket, { type: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Message too large' });
          socket.close(WS_CLOSE.POLICY_VIOLATION, 'Message too large');
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Malformed frames are dropped, never acted on.
          return;
        }

        const result = unitClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          // Names the route that *can* do it. The likely mistake here is a
          // client trying to stop a unit over the stream, and "unsupported
          // message" alone would send it looking for the bug in the wrong place.
          send(socket, {
            type: 'error',
            code: 'UNSUPPORTED_MESSAGE',
            message:
              'This channel streams unit events. Use POST /api/units/:id/signal, ' +
              '/api/units/:id/restart or DELETE /api/units/:id to control a unit.',
          });
          return;
        }

        if (result.data.type === 'ping') {
          send(socket, { type: 'pong', at: new Date().toISOString() });
        }
      });

      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        send(socket, { type: 'pong', at: new Date().toISOString() });
      }, 30_000);
      heartbeat.unref();

      socket.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      socket.on('error', (error: Error) => {
        log.warn({ err: error, unitId }, 'unit websocket error');
        unsubscribe?.();
      });

      // Closing the socket detaches the stream, it does not end the unit: a
      // reload should re-attach to a process that is still running.
      log.debug({ unitId, agentId, userId }, 'unit websocket attached');
    })();
  });
}

function send(
  socket: { readyState: number; OPEN: number; send(data: string): void },
  message: UnitServerMessage
): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    log.debug({ err: error }, 'failed to send websocket frame');
  }
}

/**
 * The close code for an attach that was refused, taken from the refusal itself.
 *
 * A client reconnecting needs to tell "that unit is gone" from "that host is
 * unreachable": the first is final and the second is worth retrying. Collapsing
 * both onto one close code would make every reconnect decision a guess.
 */
function closeCodeFor(code: string): number {
  switch (code) {
    case ERROR_CODES.NOT_FOUND:
      return WS_CLOSE.SESSION_NOT_FOUND;
    case ERROR_CODES.FORBIDDEN:
      return WS_CLOSE.FORBIDDEN;
    case ERROR_CODES.UNAUTHENTICATED:
      return WS_CLOSE.UNAUTHENTICATED;
    default:
      return WS_CLOSE.INTERNAL_ERROR;
  }
}
