import { z } from 'zod';

/**
 * Desktop window-layout persistence.
 *
 * This is the *shape of the layout*, not application state. A persisted window
 * records which app it is, where it sits, and whether it is minimised — never
 * the app's own data (a terminal's session, a file's contents), which is
 * deliberately ephemeral in the window manager. The backend stores one layout
 * per user, keyed server-side by the authenticated user's id, so one user's
 * layout can never be read or written by another.
 */

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});
export type PersistedBounds = z.infer<typeof boundsSchema>;

export const persistedWindowSchema = z.object({
  /** The app registry id this window hosts. */
  appId: z.string().min(1).max(128),
  title: z.string().max(512),
  bounds: boundsSchema,
  /** Geometry to return to when un-maximising; null when not maximised. */
  restoreBounds: boundsSchema.nullable(),
  minimized: z.boolean(),
});
export type PersistedWindow = z.infer<typeof persistedWindowSchema>;

/**
 * `version` is a literal so a future format change is a schema change, not a
 * silent reinterpretation of old data. `windows` is capped so a client cannot
 * push an unbounded blob into the settings row; array order is the z-order,
 * back to front.
 */
export const desktopLayoutSchema = z.object({
  version: z.literal(1),
  windows: z.array(persistedWindowSchema).max(64),
});
export type DesktopLayout = z.infer<typeof desktopLayoutSchema>;

export const DESKTOP_LAYOUT_VERSION = 1 as const;
