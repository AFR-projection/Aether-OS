import { z } from 'zod';

import { relativePathSchema, uuidSchema } from './common.schema.js';

export const createTerminalBodySchema = z.object({
  cols: z.number().int().min(1).max(1000).default(80),
  rows: z.number().int().min(1).max(1000).default(24),
  /** Must resolve inside the workspace root; enforced by the backend. */
  cwd: relativePathSchema.optional(),
  /** Optional shell override. Validated against an allowlist on the server. */
  shell: z.string().max(256).optional(),
});
export type CreateTerminalBody = z.infer<typeof createTerminalBodySchema>;

export const terminalIdParamSchema = z.object({
  id: uuidSchema,
});

export const resizeBodySchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type ResizeBody = z.infer<typeof resizeBodySchema>;

/**
 * Body for the non-WebSocket input endpoint.
 *
 * The terminal's normal input path is the WebSocket; this exists so a client
 * that cannot open a socket (or is scripting the API) still has a way to send
 * keystrokes. 64 KiB per call mirrors the WebSocket frame limit.
 */
export const terminalInputBodySchema = z.object({
  data: z.string().min(1).max(64 * 1024),
});
export type TerminalInputBody = z.infer<typeof terminalInputBodySchema>;

/**
 * WebSocket payloads. Each frame is JSON; anything that fails this schema is
 * rejected and the frame is dropped (never forwarded to the PTY).
 */
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']) }),
  z.object({ type: z.literal('ping') }),
]);
export type TerminalClientMessageInput = z.infer<typeof terminalClientMessageSchema>;
