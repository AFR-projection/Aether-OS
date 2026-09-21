import { LIMITS, relativePathSchema, terminalClientMessageSchema, WS_CLOSE } from '@aether/shared';
import { z } from 'zod';

export { LIMITS, WS_CLOSE };

const uuidSchema = z.string().uuid();

/**
 * A unit's limits, as they arrive over the wire.
 *
 * The same numbers the REST schema uses. A value that passes one check and
 * fails the other would mean the API advertising something the agent refuses,
 * which is worse than either refusing it.
 */
const unitLimitsShape = {
  wallClockMs: z.number().int().min(1000).nullable().default(null),
  graceMs: z.number().int().min(100).max(120_000).default(5_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(4096)
    .max(8 * 1024 * 1024)
    .default(262_144),
};

const unitRestartSchema = z
  .object({
    policy: z.enum(['never', 'on-failure', 'always']).default('never'),
    maxAttempts: z.number().int().min(0).max(20).default(0),
    backoffMs: z.number().int().min(0).max(300_000).default(1_000),
  })
  .strict();

const baseEnvelope = z.object({
  /** Correlation id echoed in the reply. */
  id: z.string().min(1).max(128),
  type: z.string().min(1),
  /**
   * The principal this request is made on behalf of.
   *
   * Optional, and absent means "the connection's paired owner" — the behaviour
   * before this field existed. The backend sends it on every request because a
   * single agent can serve several users (an instance-scoped local agent is
   * listed for every owner), and one owner per *connection* cannot express
   * that: the agent keyed every session on whoever paired first, so on a local
   * agent one user's `terminal.list` returned another user's shells.
   *
   * Only the backend sets this, and only over the authenticated agent socket.
   * The agent trusts it for the same reason it trusts `hello_ack`: it has no
   * user database, so the backend is the identity authority and the agent's job
   * is containment — see `dispatchRequest` and `killOwnedSession`.
   */
  ownerUserId: uuidSchema.optional(),
});

export const helloPayloadSchema = z.object({
  agentId: uuidSchema,
  token: z.string().min(16),
  version: z.string().min(1),
  platform: z.string().min(1),
  hostname: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
});

export type HelloPayload = z.infer<typeof helloPayloadSchema>;

export const agentCapabilities = [
  'system.info',
  'processes.list',
  'processes.signal',
  'files.list',
  'files.read',
  'files.readChunk',
  'files.write',
  'files.writeChunk',
  'files.delete',
  'files.mkdir',
  'files.rename',
  'ports.list',
  'ports.open',
  'ports.read',
  'ports.write',
  'ports.close',
  'terminal.create',
  'terminal.input',
  'terminal.resize',
  'terminal.signal',
  'terminal.kill',
  'terminal.list',
  'units.create',
  'units.list',
  'units.get',
  'units.signal',
  'units.kill',
  'units.restart',
  'units.log',
] as const;

export type AgentCapability = (typeof agentCapabilities)[number];

const emptyParams = z.object({}).strict();

export const systemInfoParamsSchema = emptyParams;

const processListParamsShape = {
  limit: z.number().int().min(1).max(500).default(100),
  sortBy: z.enum(['memory', 'pid', 'name']).optional(),
  search: z.string().max(256).optional(),
};

export const processListParamsSchema = z.object(processListParamsShape).strict();

export const processSignalParamsSchema = z
  .object({
    pid: z.number().int().min(1),
    signal: z.enum(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']),
  })
  .strict();

export const filesListParamsSchema = z.object({ path: relativePathSchema.default('') }).strict();

export const filesReadParamsSchema = z.object({ path: relativePathSchema }).strict();

/**
 * A byte range within one file.
 *
 * `offset` is a plain non-negative integer and `length` is capped at the frame
 * budget, so a single request can never be answered with a reply too large to
 * send. Reaching the end of a file is not an error: the reply simply carries
 * fewer bytes than were asked for.
 */
export const filesReadChunkParamsSchema = z
  .object({
    path: relativePathSchema,
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(LIMITS.HOST_STREAM_CHUNK_BYTES),
  })
  .strict();

export const filesWriteParamsSchema = z
  .object({
    path: relativePathSchema,
    contentBase64: z.string().max(LIMITS.MAX_FILE_READ_BYTES * 2),
  })
  .strict();

export const filesWriteChunkParamsSchema = z
  .object({
    path: relativePathSchema,
    offset: z.number().int().min(0),
    // The base64 ceiling is the encoded size of the largest legal chunk, with
    // room for the padding characters that push it a few bytes over 4/3.
    contentBase64: z.string().max(Math.ceil((LIMITS.HOST_STREAM_CHUNK_BYTES * 4) / 3) + 8),
    /** Truncate before writing. Only the first chunk of an upload sets this. */
    truncate: z.boolean().default(false),
  })
  .strict();

export const filesDeleteParamsSchema = z
  .object({ path: relativePathSchema, recursive: z.boolean().default(false) })
  .strict();

export const filesMkdirParamsSchema = z.object({ path: relativePathSchema }).strict();

export const filesRenameParamsSchema = z
  .object({
    from: relativePathSchema,
    to: relativePathSchema,
    overwrite: z.boolean().default(false),
  })
  .strict();

export const portsListParamsSchema = emptyParams;

export const portsOpenParamsSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    /**
     * Where to connect. Defaults to loopback on the agent side, because the
     * tunnel exists for servers only this machine can reach — a server already
     * bound to a public interface does not need Aether to reach it.
     */
    host: z.string().max(255).optional(),
  })
  .strict();

export const portsReadParamsSchema = z
  .object({
    tunnelId: uuidSchema,
    maxBytes: z.number().int().min(1).max(LIMITS.PORT_TUNNEL_CHUNK_BYTES),
  })
  .strict();

export const portsWriteParamsSchema = z
  .object({
    tunnelId: uuidSchema,
    // The encoded size of the largest legal chunk, plus room for the padding
    // characters that push base64 a few bytes over 4/3.
    contentBase64: z.string().max(Math.ceil((LIMITS.PORT_TUNNEL_CHUNK_BYTES * 4) / 3) + 8),
  })
  .strict();

export const portsCloseParamsSchema = z.object({ tunnelId: uuidSchema }).strict();

export const terminalCreateParamsSchema = z
  .object({
    cols: z.number().int().min(1).max(1000).default(80),
    rows: z.number().int().min(1).max(1000).default(24),
    cwd: relativePathSchema.optional(),
    shell: z.string().max(256).optional(),
    command: z.string().max(4096).optional(),
  })
  .strict();

export const terminalIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const terminalInputParamsSchema = z
  .object({
    id: uuidSchema,
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const terminalResizeParamsSchema = z
  .object({
    id: uuidSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

export const terminalSignalParamsSchema = z
  .object({ id: uuidSchema, signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']) })
  .strict();

/**
 * `units.create` — the general form of `terminal.create`.
 *
 * Wider than the terminal's because a unit is not only a shell: a command unit
 * has piped streams and no terminal, and any unit may carry a wall-clock bound,
 * a log budget and a restart policy. `kind` picks which of those apply, and the
 * agent refuses a kind it has no supervisor for rather than starting something
 * nothing will look after.
 */
export const unitsCreateParamsSchema = z
  .object({
    kind: z.enum(['tty', 'command', 'service', 'worker']),
    command: z.string().max(4096).optional(),
    cwd: relativePathSchema.optional(),
    shell: z.string().max(256).optional(),
    /**
     * Extra environment, by name.
     *
     * Refused, not filtered, when it names anything in `REJECTED_ENV_KEYS`: a
     * caller that asked for `LD_PRELOAD` and silently did not get it would be
     * running something other than what it described.
     */
    env: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
    cols: z.number().int().min(1).max(1000).default(80),
    rows: z.number().int().min(1).max(1000).default(24),
    term: z.string().max(64).optional(),
    ...unitLimitsShape,
    restart: unitRestartSchema.optional(),
    requestId: z.string().min(8).max(64).optional(),
  })
  .strict();

/**
 * `units.list`.
 *
 * `scope: 'all'` drops the owner filter. The agent accepts it because only the
 * backend can send it — the pairing token authenticates the backend to the
 * agent, and the agent has no user database of its own, so the backend is the
 * authorization authority and the agent enforces containment. The permission
 * that makes `all` legitimate (`execution:manage-others`) is checked there,
 * where the roles are.
 */
export const unitsListParamsSchema = z
  .object({
    kind: z.enum(['tty', 'command', 'service', 'worker']).optional(),
    scope: z.enum(['mine', 'all']).default('mine'),
  })
  .strict();

export const unitsIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const unitsInputParamsSchema = z
  .object({
    id: uuidSchema,
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const unitsResizeParamsSchema = z
  .object({
    id: uuidSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

export const unitsSignalParamsSchema = z
  .object({
    id: uuidSchema,
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGUSR1', 'SIGUSR2']),
    /** Null means never escalate to SIGKILL — a polite request and nothing more. */
    escalateAfterMs: z.number().int().min(100).max(120_000).nullable().default(null),
  })
  .strict();

export const unitsLogParamsSchema = z
  .object({
    id: uuidSchema,
    offset: z.number().int().min(0).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024)
      .default(64 * 1024),
    stream: z.enum(['combined', 'stdout', 'stderr']).default('combined'),
  })
  .strict();

const requestParamsByType: Record<string, z.ZodTypeAny> = {
  'system.info': systemInfoParamsSchema,
  'processes.list': processListParamsSchema,
  'processes.signal': processSignalParamsSchema,
  'files.list': filesListParamsSchema,
  'files.read': filesReadParamsSchema,
  'files.readChunk': filesReadChunkParamsSchema,
  'files.write': filesWriteParamsSchema,
  'files.writeChunk': filesWriteChunkParamsSchema,
  'files.delete': filesDeleteParamsSchema,
  'files.mkdir': filesMkdirParamsSchema,
  'files.rename': filesRenameParamsSchema,
  'ports.list': portsListParamsSchema,
  'ports.open': portsOpenParamsSchema,
  'ports.read': portsReadParamsSchema,
  'ports.write': portsWriteParamsSchema,
  'ports.close': portsCloseParamsSchema,
  'terminal.create': terminalCreateParamsSchema,
  'terminal.input': terminalInputParamsSchema,
  'terminal.resize': terminalResizeParamsSchema,
  'terminal.signal': terminalSignalParamsSchema,
  'terminal.kill': terminalIdParamsSchema,
  'terminal.list': emptyParams,
  'units.create': unitsCreateParamsSchema,
  'units.list': unitsListParamsSchema,
  'units.get': unitsIdParamsSchema,
  'units.signal': unitsSignalParamsSchema,
  'units.kill': unitsIdParamsSchema,
  'units.restart': unitsIdParamsSchema,
  'units.log': unitsLogParamsSchema,
};

export type RequestType = keyof typeof requestParamsByType;

export interface ParsedRequest {
  id: string;
  type: RequestType;
  /**
   * The principal to act as, when the frame named one. `undefined` means the
   * connection's paired owner — see `baseEnvelope`. The `| undefined` is what
   * lets this be assigned under `exactOptionalPropertyTypes`.
   */
  ownerUserId?: string | undefined;
  params: unknown;
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((i) => i.message).join('; ');
  return error instanceof Error ? error.message : 'Invalid message';
}

export function parseAgentMessage(raw: string): ParsedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Message is not valid JSON');
  }

  const envelope = baseEnvelope.safeParse(parsed);
  if (!envelope.success) {
    throw new Error(`Invalid message envelope: ${errorMessage(envelope.error)}`);
  }

  const schema = requestParamsByType[envelope.data.type];
  if (!schema) {
    throw new Error(`Unsupported message type: ${envelope.data.type}`);
  }

  const body = (parsed as Record<string, unknown>).params ?? {};
  const params = schema.safeParse(body);
  if (!params.success) {
    throw new Error(`Invalid params for ${envelope.data.type}: ${errorMessage(params.error)}`);
  }

  return {
    id: envelope.data.id,
    type: envelope.data.type,
    ownerUserId: envelope.data.ownerUserId,
    params: params.data,
  };
}

export interface ReplyOk {
  id: string;
  ok: true;
  result: unknown;
}

export interface ReplyErr {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export type Reply = ReplyOk | ReplyErr;

export function okReply(id: string, result: unknown): ReplyOk {
  return { id, ok: true, result };
}

export function errReply(id: string, code: string, message: string): ReplyErr {
  return { id, ok: false, error: { code, message } };
}

/**
 * True when `parsed` is a valid browser-style terminal client frame.
 *
 * Exposed so the gateway that forwards browser frames to an agent can reuse
 * the same schema without duplicating it.
 */
export function isTerminalClientFrame(parsed: unknown): boolean {
  return terminalClientMessageSchema.safeParse(parsed).success;
}
