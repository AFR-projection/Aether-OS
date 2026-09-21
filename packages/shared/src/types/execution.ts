import type { ExecutionUnit } from '../execution-units.js';

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
