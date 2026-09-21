import {
  DEFAULT_EXECUTION_UNIT_LIMITS,
  LIMITS,
  type CreateUnitBody,
  type ExecutionUnit,
  type UnitLogQuery,
  type UnitSignal,
} from '@aether/shared';

import { isAgentRpcConnected, sendAgentRequest } from './agent-rpc.service.js';
import { ForbiddenError, ServiceUnavailableError } from '../utils/errors.js';
import { subsystemLogger } from '../utils/logger.js';

const log = subsystemLogger('host-units');

/**
 * Host-scope execution units.
 *
 * A unit is a real process on a connected agent's machine — an interactive
 * shell, a one-shot command, and (once their supervisors exist) a worker or a
 * service. This module is the backend's half of the `units.*` RPC surface: it
 * originates the request against the agent that holds the process and returns
 * the agent's answer.
 *
 * ## Why this is stateless, unlike `host-terminal.service`
 *
 * The terminal service keeps a per-process map because it has to *bridge a live
 * stream*: output arrives as `terminal.event` frames and has to be routed to a
 * browser socket, so it needs to remember which agent owns which session and
 * hold the subscription. The units REST surface streams nothing — logs are
 * pulled by offset — so it needs to remember nothing. Every call already names
 * the agent (the client carries `agentId`, which every unit record and the list
 * response include) and the principal, and the agent is the authority on its own
 * units: it reconciles them on every read (`reconcileAllUnits`), so a unit that
 * vanished is reported `stale` rather than running.
 *
 * That statelessness is not a shortcut — it is the right answer to two of the
 * dimensions this foundation has to cover. **Backend restart recovery**: there
 * is no backend state to lose, so a backend restart is invisible to a unit that
 * is still running on the agent. **Adoption/reconciliation**: the agent owns it,
 * and a `units.list` after any restart returns exactly what is still there. The
 * backend cannot drift from the agent because it caches nothing to drift with.
 *
 * ## The one thing it is NOT honest about, and does not pretend to be
 *
 * A unit does not survive its *agent* restarting — the PTYs and child processes
 * die with the agent that owns their file descriptors. Nothing here claims
 * otherwise; see `docs/status/KNOWN-LIMITATIONS.md`. What survives an agent
 * restart is nothing, and this module reports that faithfully (the agent has no
 * record, so `units.list` is empty and `units.get` is 404) rather than showing a
 * unit that is gone.
 *
 * ## Ownership
 *
 * Every request names the user it is made on behalf of. The agent keys its units
 * on that principal and answers a unit belonging to someone else exactly as it
 * answers one that does not exist (404-not-403). A request that named nobody
 * would be answered as the agent's paired owner — and an instance-scoped local
 * agent pairs as itself, one identity shared by every user of the instance — so
 * passing the principal on every call is what makes the agent's own check
 * meaningful. `scope: 'all'` is the sole exception: it drops the owner filter,
 * and the route gates it behind `execution:manage-others` before it is sent.
 */

/** Guards the top-level shape of an agent reply that should carry a unit. */
function expectUnit(value: unknown, context: string): ExecutionUnit {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { unit?: unknown }).unit !== 'object'
  ) {
    throw new ServiceUnavailableError(`The host agent returned an unexpected ${context} reply`);
  }
  const unit = (value as { unit: unknown }).unit as ExecutionUnit;
  if (typeof unit.id !== 'string' || typeof unit.ownerUserId !== 'string') {
    throw new ServiceUnavailableError(`The host agent returned an invalid ${context} unit`);
  }
  return unit;
}

function requireConnected(agentId: string): void {
  if (!isAgentRpcConnected(agentId)) {
    throw new ServiceUnavailableError('The selected host agent is not connected');
  }
}

/**
 * Refuses limits above the instance defaults unless the caller may raise them.
 *
 * `execution:limits:raise` is what makes the instance's default output ring and
 * restart ceiling a floor a normal user cannot exceed: a bigger ring is a way to
 * spend the host's memory, and a higher restart count is a way to keep it busy,
 * and the point of the permission is that someone with it decided that was
 * wanted. Checked here rather than as a route guard because it is conditional —
 * a request that stays within the defaults needs no permission at all — and a
 * static `requirePermission` cannot express "only when you asked for more".
 *
 * Refused before the unit is created, naming which limit and the ceiling, so the
 * caller is told what to change rather than being handed a smaller unit than it
 * asked for silently (which would be the fake-success failure §40 forbids).
 */
export function assertMayUseRequestedLimits(
  body: Pick<CreateUnitBody, 'maxOutputBytes' | 'restart'>,
  mayRaiseLimits: boolean
): void {
  if (mayRaiseLimits) return;

  if (body.maxOutputBytes > DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes) {
    throw new ForbiddenError(
      'Raising a unit\'s retained output above the instance default requires the ' +
        '"execution:limits:raise" permission',
      {
        requiredPermission: 'execution:limits:raise',
        limit: 'maxOutputBytes',
        default: DEFAULT_EXECUTION_UNIT_LIMITS.maxOutputBytes,
        requested: body.maxOutputBytes,
      }
    );
  }

  const requestedAttempts = body.restart?.maxAttempts ?? 0;
  if (requestedAttempts > LIMITS.EXECUTION_UNIT_MAX_RESTART_ATTEMPTS) {
    throw new ForbiddenError(
      'Raising a unit\'s restart ceiling above the instance default requires the ' +
        '"execution:limits:raise" permission',
      {
        requiredPermission: 'execution:limits:raise',
        limit: 'restart.maxAttempts',
        default: LIMITS.EXECUTION_UNIT_MAX_RESTART_ATTEMPTS,
        requested: requestedAttempts,
      }
    );
  }
}

export async function createHostUnit(
  ownerUserId: string,
  body: CreateUnitBody
): Promise<ExecutionUnit> {
  requireConnected(body.agentId);

  const reply = await sendAgentRequest(
    body.agentId,
    'units.create',
    {
      kind: body.kind,
      ...(body.command !== undefined ? { command: body.command } : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.shell !== undefined ? { shell: body.shell } : {}),
      ...(body.env !== undefined ? { env: body.env } : {}),
      cols: body.cols,
      rows: body.rows,
      ...(body.term !== undefined ? { term: body.term } : {}),
      wallClockMs: body.wallClockMs,
      graceMs: body.graceMs,
      maxOutputBytes: body.maxOutputBytes,
      ...(body.restart !== undefined ? { restart: body.restart } : {}),
      ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
    },
    ownerUserId
  );

  // The agent answers `units.create` with the bare unit, not `{ unit }`.
  const unit = reply as ExecutionUnit;
  if (unit === null || typeof unit !== 'object' || typeof unit.id !== 'string') {
    throw new ServiceUnavailableError('The host agent returned an invalid execution unit');
  }
  log.info({ unitId: unit.id, agentId: body.agentId, kind: unit.kind }, 'host unit created');
  return unit;
}

export async function listHostUnits(
  agentId: string,
  ownerUserId: string,
  scope: 'mine' | 'all'
): Promise<ExecutionUnit[]> {
  requireConnected(agentId);

  const reply = await sendAgentRequest(agentId, 'units.list', { scope }, ownerUserId);
  const units = (reply as { units?: unknown } | null)?.units;
  if (!Array.isArray(units)) {
    throw new ServiceUnavailableError('The host agent returned an invalid unit list');
  }
  return units as ExecutionUnit[];
}

export async function getHostUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string
): Promise<ExecutionUnit> {
  requireConnected(agentId);
  const reply = await sendAgentRequest(agentId, 'units.get', { id: unitId }, ownerUserId);
  return expectUnit(reply, 'unit');
}

export interface SignalHostUnitResult {
  delivered: boolean;
  escalated: boolean;
}

export async function signalHostUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string,
  signal: UnitSignal,
  escalateAfterMs: number | null
): Promise<SignalHostUnitResult> {
  requireConnected(agentId);
  const reply = await sendAgentRequest(
    agentId,
    'units.signal',
    { id: unitId, signal, escalateAfterMs },
    ownerUserId
  );
  const record = (reply ?? {}) as { delivered?: unknown; escalated?: unknown };
  return {
    delivered: record.delivered === true,
    escalated: record.escalated === true,
  };
}

export async function restartHostUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string
): Promise<ExecutionUnit> {
  requireConnected(agentId);
  const reply = await sendAgentRequest(agentId, 'units.restart', { id: unitId }, ownerUserId);
  return expectUnit(reply, 'restarted unit');
}

/**
 * Ends a unit. Answers whether a unit was ended, never why it was not.
 *
 * A unit owned by someone else and a unit that never existed both answer
 * `false`, because the agent gives both the same 404 and this does not
 * distinguish them: whether another user's unit exists is not this caller's
 * business.
 */
export async function killHostUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string
): Promise<boolean> {
  requireConnected(agentId);
  const reply = await sendAgentRequest(agentId, 'units.kill', { id: unitId }, ownerUserId);
  return (reply as { killed?: unknown } | null)?.killed === true;
}

export interface HostUnitLogRead {
  contentBase64: string;
  offset: number;
  retainedBytes: number;
  droppedBytes: number;
  totalBytes: number;
  ended: boolean;
}

export async function readHostUnitLog(
  agentId: string,
  unitId: string,
  ownerUserId: string,
  query: UnitLogQuery
): Promise<HostUnitLogRead> {
  requireConnected(agentId);
  const reply = expectRecord(
    await sendAgentRequest(
      agentId,
      'units.log',
      { id: unitId, offset: query.offset, limit: query.limit, stream: query.stream },
      ownerUserId
    ),
    'unit log'
  );

  return {
    contentBase64: typeof reply.contentBase64 === 'string' ? reply.contentBase64 : '',
    offset: typeof reply.offset === 'number' ? reply.offset : query.offset,
    retainedBytes: typeof reply.retainedBytes === 'number' ? reply.retainedBytes : 0,
    droppedBytes: typeof reply.droppedBytes === 'number' ? reply.droppedBytes : 0,
    totalBytes: typeof reply.totalBytes === 'number' ? reply.totalBytes : 0,
    ended: reply.ended === true,
  };
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ServiceUnavailableError(`The host agent returned an unexpected ${context} reply`);
  }
  return value as Record<string, unknown>;
}
