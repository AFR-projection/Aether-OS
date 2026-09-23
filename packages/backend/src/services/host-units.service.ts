import {
  DEFAULT_EXECUTION_UNIT_LIMITS,
  LIMITS,
  isExecutionUnitState,
  type CreateUnitBody,
  type ExecutionUnit,
  type UnitLogQuery,
  type UnitServerMessage,
  type UnitSignal,
} from '@aether/shared';

import { listAgents } from './agent-pairing.service.js';
import { isAgentRpcConnected, sendAgentRequest, subscribeAgentUnit } from './agent-rpc.service.js';
import { ForbiddenError, NotFoundError, ServiceUnavailableError } from '../utils/errors.js';
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
 * ## Why the REST surface is stateless, unlike `host-terminal.service`
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
 * The one piece of state here is the live-stream registry in
 * `subscribeHostUnit`, and it is the same kind of state for the same reason:
 * routing a stream needs somewhere to remember who is listening. It holds no
 * unit state — only which browsers are watching a unit that the agent owns — so
 * every argument above still holds, and a backend restart loses nothing but the
 * streams themselves, which the browsers re-open.
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
 * Refuses an agent the caller may not use — the DoD-#5 check, on the one verb
 * that needs it: create.
 *
 * A unit id is owned, so `get`/`signal`/`kill`/`restart`/`log` are already safe
 * — the agent answers a stranger's unit id with the same 404 a missing one gets.
 * `create` has no prior unit to own-check against, so without this a user who
 * holds `execution:create` and knows another user's *paired* agent id could
 * spawn a process on that machine. `listAgents(ownerUserId)` returns exactly the
 * agents this user may use — their own, plus every instance-scoped local agent
 * (`owner_user_id IS NULL`), which is usable by everyone by design — so an agent
 * absent from that set is one the caller has no claim to.
 *
 * Answered as a 404, not a 403: an agent the caller may not use is, to them,
 * indistinguishable from one that does not exist — the same not-found-not-
 * forbidden rule the unit ownership check follows, so the two cannot be told
 * apart to probe for another user's agents.
 */
async function assertMayUseAgent(agentId: string, ownerUserId: string): Promise<void> {
  const allowed = await listAgents(ownerUserId);
  if (!allowed.some((agent) => agent.agentId === agentId)) {
    throw new NotFoundError('Host agent not found');
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
      "Raising a unit's retained output above the instance default requires the " +
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
      "Raising a unit's restart ceiling above the instance default requires the " +
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
  await assertMayUseAgent(body.agentId, ownerUserId);
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
      ...(body.rlimits !== undefined ? { rlimits: body.rlimits } : {}),
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

/** A stream selector the agent may report, or the pipe default when it does not. */
function toOutputStream(value: unknown): 'pty' | 'stdout' | 'stderr' {
  return value === 'pty' || value === 'stderr' ? value : 'stdout';
}

/**
 * Narrows one agent `unit.event` into the frame the browser is sent, or `null`
 * when it is not a frame this surface carries.
 *
 * The agent's `UnitEvent` union and `UnitServerMessage`'s event members are the
 * same four shapes, so this looks like a formality — it is not. The agent is a
 * separate process reached over a socket, and the backend's job at that boundary
 * is to hand the browser only what it has actually checked. A frame that does
 * not match is dropped rather than forwarded on faith, which is also what makes
 * a future agent-side event *invisible* here until it is deliberately added,
 * instead of arriving in browsers that do not know what it means.
 */
export function toUnitServerMessage(event: unknown): UnitServerMessage | null {
  if (typeof event !== 'object' || event === null) return null;
  const record = event as Record<string, unknown>;

  switch (record.type) {
    case 'output':
      return typeof record.data === 'string'
        ? { type: 'output', data: record.data, stream: toOutputStream(record.stream) }
        : null;
    case 'state':
      return isExecutionUnitState(record.state) ? { type: 'state', state: record.state } : null;
    case 'exit':
      return isExecutionUnitState(record.state) && typeof record.normalized === 'number'
        ? {
            type: 'exit',
            exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
            signal: typeof record.signal === 'number' ? record.signal : null,
            normalized: record.normalized,
            state: record.state,
          }
        : null;
    case 'restart':
      return typeof record.attempt === 'number'
        ? { type: 'restart', attempt: record.attempt }
        : null;
    default:
      return null;
  }
}

export interface HostUnitSubscription {
  /** The unit as it was when the subscription was established. */
  unit: ExecutionUnit;
  unsubscribe: () => void;
}

/**
 * One live agent subscription, shared by every browser watching that unit.
 *
 * The fan-out is not an optimisation. The agent keeps **one** subscription per
 * unit and replaces it when a `units.subscribe` arrives, replaying the output
 * again as it does — so a second attach that simply sent a second subscribe
 * would hand the first viewer the whole stream twice and then, when either
 * viewer left, stop the stream for both. A viewer that believes it is attached
 * and receives nothing is exactly the failure this model exists to prevent, so
 * the unit is subscribed once here and the browsers are fanned out from it.
 */
interface LiveUnitStream {
  listeners: Set<(message: UnitServerMessage) => void>;
  /** The agent's release, once the subscribe has answered. Null while attaching. */
  release: (() => void) | null;
  /** The in-flight attach, so two viewers arriving together share one subscribe. */
  attaching: Promise<() => void> | null;
}

/** Keyed by agent *and* unit: a unit id is only unique within its own host. */
const liveStreams = new Map<string, LiveUnitStream>();

function streamKey(agentId: string, unitId: string): string {
  return `${agentId}:${unitId}`;
}

/**
 * Drops every live-stream entry. **Tests only** — never called in production.
 *
 * The registry is module state that outlives a single test, so two tests that
 * attach to the same unit would have the second reuse the first's entry and skip
 * its own `units.subscribe` — and with it the agent's replay. Clearing between
 * tests (alongside re-registering the agent socket, which resets the agent-rpc
 * channel) is what keeps each test attaching from a clean slate. It only forgets
 * the map; a test re-registers its agent socket, which drops the matching
 * subscribers, so nothing is left streaming into a released entry.
 */
export function resetUnitStreamsForTests(): void {
  liveStreams.clear();
}

/**
 * Attaches to a live unit's event stream.
 *
 * The unit is read *before* the subscribe is sent, so a caller can be told what
 * it is attaching to — and be refused if there is nothing to attach to — without
 * having already consumed part of a stream it may not be allowed to have. The
 * read is also the ownership check: the agent answers a stranger's unit exactly
 * as it answers one that does not exist, and it runs on *every* attach rather
 * than only the first, so a later viewer cannot ride in on an open stream.
 *
 * The subscribe then replays everything the agent still retains, which is what
 * makes a late attach (a page reload, a window reopened) show the output so far
 * rather than starting from an empty screen. Events can therefore begin arriving
 * before this function resolves — the agent writes its replay ahead of the
 * subscribe reply — which is the caller's problem to order, not something
 * silently dropped here. `ws/units.ws.ts` holds them until it has sent `ready`.
 */
export async function subscribeHostUnit(
  agentId: string,
  unitId: string,
  ownerUserId: string,
  onEvent: (message: UnitServerMessage) => void
): Promise<HostUnitSubscription> {
  requireConnected(agentId);
  const unit = await getHostUnit(agentId, unitId, ownerUserId);

  const key = streamKey(agentId, unitId);
  const existing = liveStreams.get(key);
  const stream: LiveUnitStream = existing ?? {
    listeners: new Set(),
    release: null,
    attaching: null,
  };
  if (!existing) liveStreams.set(key, stream);
  stream.listeners.add(onEvent);

  if (stream.release === null) {
    // One subscribe per unit, however many viewers. The callback fans out to
    // whoever is listening *now*, so a viewer that joins mid-attach still
    // receives the replay.
    stream.attaching ??= subscribeAgentUnit(agentId, unitId, ownerUserId, (event) => {
      const message = toUnitServerMessage(event);
      if (message === null) return;
      for (const listener of stream.listeners) listener(message);
    });
    try {
      stream.release = await stream.attaching;
      stream.attaching = null;
    } catch (error) {
      // Nothing was opened, so nothing is left holding the entry: the next
      // caller starts a fresh attach rather than inheriting a dead one.
      stream.attaching = null;
      releaseListener(key, stream, onEvent);
      throw error;
    }
  }

  let detached = false;
  return {
    unit,
    unsubscribe: () => {
      // Idempotent: the socket's close and error handlers both call this, and a
      // second call must not release a subscription someone else now holds.
      if (detached) return;
      detached = true;
      releaseListener(key, stream, onEvent);
    },
  };
}

/**
 * Removes one listener, and releases the agent subscription with the last one.
 *
 * The release is what makes this honest rather than merely tidy: a stream nobody
 * reads should not keep the agent sending frames, and the agent's own replay
 * means a later viewer loses nothing by it.
 */
function releaseListener(
  key: string,
  stream: LiveUnitStream,
  listener: (message: UnitServerMessage) => void
): void {
  stream.listeners.delete(listener);
  if (stream.listeners.size > 0) return;

  liveStreams.delete(key);
  const release = stream.release;
  stream.release = null;
  if (release !== null) {
    release();
    return;
  }
  // Still attaching: the last viewer left before the agent answered. The
  // subscription is released the moment it exists, rather than being left to
  // stream into a map that no longer holds it.
  void stream.attaching
    ?.then((releasePending) => {
      if (stream.listeners.size === 0) releasePending();
    })
    .catch(() => undefined);
}
