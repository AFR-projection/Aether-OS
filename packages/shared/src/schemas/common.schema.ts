import { z } from 'zod';

/**
 * Reusable primitive schemas.
 *
 * These are the single source of truth for input shape validation. They are
 * applied on the server for every request body, query string, and path
 * parameter. The frontend reuses them for immediate feedback, but the server
 * never trusts a client-side validation result.
 */

/** ISO-8601 timestamp with a timezone designator. */
export const isoTimestampSchema = z.string().datetime({ offset: true });

/** UUID v4 as produced by `uuid_generate_v4()` / `gen_random_uuid()`. */
export const uuidSchema = z.string().uuid();

/** Usernames: 3-32 chars, lowercase alphanumeric plus `_` and `-`. */
export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/,
    'Username may only contain lowercase letters, digits, "_" and "-"'
  );

/**
 * Passwords: at least 12 characters.
 *
 * Length is enforced because it dominates the strength of every practical
 * offline attack. Composition rules are deliberately not enforced — they push
 * users towards predictable patterns such as `Password1!`.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

export const emailSchema = z.string().email().max(254);

/** A TCP port number. */
export const portSchema = z.number().int().min(1).max(65535);

/** Cursor pagination. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * A boolean arriving in a query string.
 *
 * `z.coerce.boolean()` must not be used here: it applies JavaScript truthiness,
 * so the string `"false"` — which is what a browser actually sends for
 * `?flag=false` — coerces to `true`. Only the literals below are accepted, and
 * anything else is a validation error rather than a silent default, so a typo
 * cannot quietly flip a behaviour.
 */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

/**
 * A path relative to the workspace root.
 *
 * This is *shape* validation only. It cannot decide whether a path is safe to
 * touch — that decision requires resolving symlinks and comparing the real
 * path against the workspace root, which the backend does with `fs.realpath`.
 */
export const relativePathSchema = z
  .string()
  .max(4096, 'Path is too long')
  .refine((value) => !value.includes('\0'), 'Path must not contain NUL bytes')
  .refine((value) => !/^[a-zA-Z]:/.test(value), 'Absolute Windows paths are not allowed')
  .refine((value) => !value.startsWith('/'), 'Absolute paths are not allowed')
  .refine((value) => !value.startsWith('~'), 'Home-relative paths are not allowed')
  .refine(
    (value) => !value.split(/[\\/]+/).includes('..'),
    'Parent directory segments are not allowed'
  );
