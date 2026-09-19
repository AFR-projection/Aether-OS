import { z } from 'zod';

/**
 * Ports schemas.
 *
 * `agentId` is required rather than defaulted: a port belongs to one machine,
 * and picking one on the user's behalf would make "open this port" ambiguous the
 * moment a second agent is paired.
 */

const agentIdSchema = z.string().min(1).max(128);

const portSchema = z.number().int().min(1).max(65_535);

export const portsQuerySchema = z.object({
  agentId: agentIdSchema,
});

export const previewBodySchema = z.object({
  agentId: agentIdSchema,
  port: portSchema,
  /**
   * Interface to connect to on the host. Absent means loopback, which is where
   * frameworks put a dev server unless told otherwise.
   */
  host: z.string().min(1).max(255).optional(),
});

export const releasePreviewQuerySchema = z.object({
  agentId: agentIdSchema,
  // Query parameters arrive as strings; the body carries a real number.
  port: z.coerce.number().int().min(1).max(65_535),
});
