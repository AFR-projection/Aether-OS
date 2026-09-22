import { z } from 'zod';

import {
  EXECUTION_UNIT_KINDS,
  EXECUTION_UNIT_LOG_MODES,
  RESTART_POLICIES,
} from '../execution-units.js';
import { relativePathSchema, uuidSchema } from './common.schema.js';

/**
 * Request bodies for the execution-unit API.
 *
 * The unit registry is what actually enforces these limits; the schemas here
 * exist so a malformed request is refused at the edge, in one place, with a
 * message naming the field. The bounds are deliberately the same numbers the
 * agent's own protocol uses — a value that passes here must not be rejected
 * there for being out of range, or the API would be advertising a capability it
 * cannot deliver.
 */

/**
 * Ceiling on a unit's wall-clock limit.
 *
 * A day, not "unbounded": the field exists to bound a process, and a caller who
 * wants something that runs for a week wants a service, which is not a P1 unit
 * — `service` and `worker` kinds are refused with NOT_IMPLEMENTED until the
 * supervisor that owns them exists.
 */
const MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

const envSchema = z
  .record(z.string().min(1).max(128), z.string().max(4096))
  .refine((env) => Object.keys(env).length <= 64, {
    message: 'at most 64 environment variables may be set on one unit',
  });

export const createUnitBodySchema = z.object({
  /** The host to run on. Must be an agent this user is allowed to use. */
  agentId: uuidSchema,
  kind: z.enum(EXECUTION_UNIT_KINDS),
  /** Must resolve inside the workspace root; enforced by the backend and the agent. */
  cwd: relativePathSchema.optional(),
  /** Optional shell override. Validated against the agent's allowlist. */
  shell: z.string().max(256).optional(),
  /** A command to run under the shell. Required for `command` kind, ignored by `tty`. */
  command: z.string().min(1).max(4096).optional(),
  /** Extra environment, by name. Names in `REJECTED_ENV_KEYS` are refused, not dropped. */
  env: envSchema.optional(),
  cols: z.number().int().min(1).max(1000).default(80),
  rows: z.number().int().min(1).max(1000).default(24),
  term: z.string().max(64).optional(),
  /** Longest the unit may run before Aether ends it. Null means no wall-clock bound. */
  wallClockMs: z.number().int().min(1000).max(MAX_WALL_CLOCK_MS).nullable().default(null),
  /** How long it may take to die after a polite signal before SIGKILL. */
  graceMs: z.number().int().min(100).max(120_000).default(5_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(4096)
    .max(8 * 1024 * 1024)
    .default(256 * 1024),
  restart: z
    .object({
      policy: z.enum(RESTART_POLICIES).default('never'),
      maxAttempts: z.number().int().min(0).max(20).default(0),
      backoffMs: z.number().int().min(0).max(300_000).default(1_000),
    })
    .optional(),
  /**
   * Optional resource ceilings applied with `ulimit` before the unit's command
   * runs. Every one is a *bound*, not a grant: it is set as a hard limit so the
   * process cannot raise it, and omitting a field leaves that resource at
   * whatever the host's login already sets. Bytes are the unit of currency here;
   * the agent converts to the shell's own units. See `buildRlimitPrologue`.
   *
   * `addressSpaceBytes` (RLIMIT_AS) is a virtual-memory bound and is explicitly
   * NOT a cgroup `memory.max`; a real memory cage is the P2 supervisor.
   */
  rlimits: z
    .object({
      addressSpaceBytes: z
        .number()
        .int()
        .min(16 * 1024 * 1024)
        .max(1024 * 1024 * 1024 * 1024)
        .nullable()
        .default(null),
      cpuSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
      maxOpenFiles: z.number().int().min(16).max(1_048_576).nullable().default(null),
      coreDumpBytes: z
        .number()
        .int()
        .min(0)
        .max(4 * 1024 * 1024 * 1024)
        .nullable()
        .default(null),
    })
    .optional(),
  /**
   * Idempotency token. Two creates with the same token and owner describe one
   * unit, so a retry cannot leave two shells behind.
   */
  requestId: z.string().min(8).max(64).optional(),
});
export type CreateUnitBody = z.infer<typeof createUnitBodySchema>;

export const unitIdParamSchema = z.object({
  id: uuidSchema,
});

/**
 * Names the host for a request that targets one unit by id.
 *
 * A unit id is unique to the agent that holds it, not across the fleet, so
 * `get`/`signal`/`restart`/`kill`/`log` all have to say which host they mean.
 * The backend keeps no unit bookkeeping of its own — the agent is the store —
 * so this is not a lookup key it could infer; the client that opened the unit
 * knows its host and says so.
 */
export const unitScopedQuerySchema = z.object({
  agentId: uuidSchema,
});
export type UnitScopedQuery = z.infer<typeof unitScopedQuerySchema>;

export const unitInputBodySchema = z.object({
  data: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export type UnitInputBody = z.infer<typeof unitInputBodySchema>;

export const unitResizeBodySchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type UnitResizeBody = z.infer<typeof unitResizeBodySchema>;

/**
 * Signals a caller may send.
 *
 * Wider than the terminal's three because a unit is not only a shell: `SIGHUP`
 * is how a daemon is asked to re-read its configuration, and `SIGUSR1`/`SIGUSR2`
 * are the conventional application-defined pair. Every one of them is delivered
 * to the unit's process group, so a shell and everything it started are reached
 * together.
 */
export const UNIT_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGHUP',
  'SIGUSR1',
  'SIGUSR2',
] as const;

export type UnitSignal = (typeof UNIT_SIGNALS)[number];

export const unitSignalBodySchema = z.object({
  signal: z.enum(UNIT_SIGNALS),
  /**
   * How long to wait for a graceful exit before escalating to SIGKILL.
   *
   * Only meaningful for a signal the unit may survive. Escalation is opt-in
   * because it is a real escalation: it takes away the process's chance to
   * clean up, and doing that by default would turn a polite request into a
   * forced one.
   */
  escalateAfterMs: z.number().int().min(100).max(120_000).nullable().default(null),
});
export type UnitSignalBody = z.infer<typeof unitSignalBodySchema>;

/**
 * Frames the browser may send over `/ws/units/:id`.
 *
 * One member, and that is the point: the unit stream is a read channel, so the
 * only thing a client can say on it is "are you still there". Every frame that
 * would change the unit is refused here and names the REST verb to use instead,
 * because those calls carry the permission check and the audit record this
 * channel has neither of. Widening this union is how a second control surface
 * would be introduced by accident.
 */
export const unitClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
]);
export type UnitClientMessageInput = z.infer<typeof unitClientMessageSchema>;

export const unitsQuerySchema = z.object({
  agentId: uuidSchema,
  /**
   * `mine` is every unit this user owns. `all` is every unit on the host, and
   * requires `execution:manage-others` — it exists so an administrator can see
   * what a shared instance is running, not so one user can watch another's.
   */
  scope: z.enum(['mine', 'all']).default('mine'),
});
export type UnitsQuery = z.infer<typeof unitsQuerySchema>;

export const unitLogQuerySchema = z.object({
  /** Byte offset into the retained ring. Defaults to 0, i.e. everything held. */
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(512 * 1024)
    .default(64 * 1024),
  /** Which stream to read. `stdout` and `stderr` are distinct on a pipe unit. */
  stream: z.enum(['combined', 'stdout', 'stderr']).default('combined'),
});
export type UnitLogQuery = z.infer<typeof unitLogQuerySchema>;

export const unitLogModes = EXECUTION_UNIT_LOG_MODES;
