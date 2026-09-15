import type { z } from 'zod';

import { ValidationError } from './errors.js';

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
  context?: string,
): z.infer<TSchema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    }));

    throw new ValidationError(
      context ? `Invalid ${context}` : 'Request validation failed',
      issues,
    );
  }

  return result.data;
}
