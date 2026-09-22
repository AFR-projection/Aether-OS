import type { ExecutionUnit, ExecutionUnitState } from '../execution-units.js';

/**
 * Wire shapes for the execution-unit API.
 *
 * Every response carries the unit itself, so a client never has to combine two
 * answers to know what it is looking at. The log endpoint is the one exception:
 * output is bytes, it is the largest thing here, and repeating the unit record
 * alongside every poll would make the common case — read what the process just
 * printed — pay for data the caller already has.
 */

export interface UnitResponse {
  unit: ExecutionUnit;
}

export interface UnitListResponse {
  units: ExecutionUnit[];
  total: number;
  /** The host these were read from, echoed so a stale window can notice it moved. */
  agentId: string;
}

export interface UnitLogResponse {
  unitId: string;
  /** Base64 so the bytes survive JSON unchanged; a terminal stream is not always UTF-8. */
  contentBase64: string;
  /** Byte offset this chunk starts at, within the retained ring. */
  offset: number;
  /** Total bytes currently retained. */
  retainedBytes: number;
  /** Bytes the ring dropped because it was full; non-zero means output was lost. */
  droppedBytes: number;
  /** True when the unit has ended, so a caller knows not to wait for more. */
  ended: boolean;
}

/** What a unit ended as, summarised — the one line a caller shows in a list. */
export interface UnitOutcome {
  state: ExecutionUnit['state'];
  exitCode: number | null;
  signal: number | null;
  normalized: number | null;
}

/**
 * Messages sent by the browser to the backend over `/ws/units/:id`.
 *
 * This channel is a **read stream**, and the one frame type says so. Every verb
 * that changes a unit — signal, kill, restart — is a REST call, because those
 * are the calls that carry a permission check and an audit record; a frame that
 * quietly did the same thing would be the same act with neither. The stream is
 * deliberately not a second, unaudited control channel.
 *
 * `ping` exists so a client can prove the socket is alive on demand, rather than
 * waiting for the server's heartbeat to fail to arrive.
 */
export type UnitClientMessage = { type: 'ping' };

/**
 * Messages sent by the backend to the browser over `/ws/units/:id`.
 *
 * The event frames are the agent's own `UnitEvent` vocabulary (`output`,
 * `state`, `exit`, `restart`), narrowed and forwarded rather than translated —
 * one model, carried to the browser. `ready` and `error` are transport-level and
 * have no agent counterpart.
 *
 * `output` carries `data` as a plain string, not base64 as the log endpoint
 * does: a log read is a byte range that may begin mid-character, while a stream
 * event is a whole chunk the agent already decoded. Encoding it here would be
 * ceremony that changes nothing.
 */
export type UnitServerMessage =
  | {
      type: 'ready';
      unitId: string;
      agentId: string;
      /**
       * The unit as it was when the subscription was established. Sent before
       * any event, so a client can render immediately and has a baseline to
       * apply the following events to — including the replayed output, which the
       * agent sends on subscribe and which is everything still retained from
       * before the client arrived.
       */
      unit: ExecutionUnit;
    }
  | { type: 'output'; data: string; stream: 'pty' | 'stdout' | 'stderr' }
  | { type: 'state'; state: ExecutionUnitState }
  | {
      type: 'exit';
      exitCode: number | null;
      signal: number | null;
      normalized: number;
      state: ExecutionUnitState;
    }
  | { type: 'restart'; attempt: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: string };
