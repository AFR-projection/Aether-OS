import { ValidationError } from './errors.js';

import type { z } from 'zod';

/**
 * Validates `value` against `schema`, throwing a `ValidationError` with
 * field-level detail when it does not match.
 *
 * Every client-supplied value in this codebase passes through here. Route
 * handlers therefore receive already-typed, already-checked data and never read
 * `request.body` directly.
 */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  context?: string
): z.output<TSchema> {
  const result = schema.safeParse(value) as z.SafeParseReturnType<unknown, z.output<TSchema>>;

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    }));

    throw new ValidationError(context ? `Invalid ${context}` : 'Request validation failed', issues);
  }

  // Zod's generic `parse` return is exposed as `any` by its v3 type surface;
  // the schema instance is the source of truth for this output type.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return schema.parse(value) as z.output<TSchema>;
}
