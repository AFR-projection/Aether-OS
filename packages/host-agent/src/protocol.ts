import { z } from 'zod';

import {
  LIMITS,
  relativePathSchema,
  terminalClientMessageSchema,
  WS_CLOSE,
} from '@aether/shared';

export { LIMITS, WS_CLOSE };

const uuidSchema = z.string().uuid();

const baseEnvelope = z.object({
  /** Correlation id echoed in the reply. */
  id: z.string().min(1).max(128),
  type: z.string().min(1),
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
  'files.write',
  'files.delete',
  'files.mkdir',
  'terminal.create',
  'terminal.input',
  'terminal.resize',
  'terminal.signal',
  'terminal.kill',
  'terminal.list',
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

export const filesListParamsSchema = z
  .object({ path: relativePathSchema.default('') })
  .strict();

export const filesReadParamsSchema = z.object({ path: relativePathSchema }).strict();

export const filesWriteParamsSchema = z
  .object({ path: relativePathSchema, contentBase64: z.string().max(LIMITS.MAX_FILE_READ_BYTES * 2) })
  .strict();

export const filesDeleteParamsSchema = z.object({ path: relativePathSchema }).strict();

export const filesMkdirParamsSchema = z.object({ path: relativePathSchema }).strict();

export const terminalCreateParamsSchema = z
  .object({
    cols: z.number().int().min(1).max(1000).default(80),
    rows: z.number().int().min(1).max(1000).default(24),
    cwd: relativePathSchema.optional(),
    shell: z.string().max(256).optional(),
  })
  .strict();

export const terminalIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const terminalInputParamsSchema = z
  .object({ id: uuidSchema, data: z.string().min(1).max(64 * 1024) })
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

const requestParamsByType: Record<string, z.ZodTypeAny> = {
  'system.info': systemInfoParamsSchema,
  'processes.list': processListParamsSchema,
  'processes.signal': processSignalParamsSchema,
  'files.list': filesListParamsSchema,
  'files.read': filesReadParamsSchema,
  'files.write': filesWriteParamsSchema,
  'files.delete': filesDeleteParamsSchema,
  'files.mkdir': filesMkdirParamsSchema,
  'terminal.create': terminalCreateParamsSchema,
  'terminal.input': terminalInputParamsSchema,
  'terminal.resize': terminalResizeParamsSchema,
  'terminal.signal': terminalSignalParamsSchema,
  'terminal.kill': terminalIdParamsSchema,
  'terminal.list': emptyParams,
};

export type RequestType = keyof typeof requestParamsByType;

export interface ParsedRequest {
  id: string;
  type: RequestType;
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

  return { id: envelope.data.id, type: envelope.data.type as RequestType, params: params.data };
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
