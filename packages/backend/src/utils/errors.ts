import { ERROR_CODES, type ErrorCode } from '@aether/shared';

/**
 * Application error hierarchy.
 *
 * Every error that is allowed to reach the client is an `AppError`. Anything
 * else is treated as an internal fault, logged with its stack, and reported to
 * the client as a generic 500 with no internal detail.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(ERROR_CODES.VALIDATION_FAILED, message, 400, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCode = ERROR_CODES.UNAUTHENTICATED) {
    super(code, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super(ERROR_CODES.FORBIDDEN, message, 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super(ERROR_CODES.NOT_FOUND, message, 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(ERROR_CODES.CONFLICT, message, 409, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', details?: unknown) {
    super(ERROR_CODES.PAYLOAD_TOO_LARGE, message, 413, details);
  }
}

/**
 * Raised when a path is syntactically invalid, resolves outside the workspace
 * root, or traverses a symlink that leaves the sandbox. The client is told the
 * request was rejected; the reason is logged server-side.
 */
export class PathRejectedError extends AppError {
  constructor(message = 'Path is outside the permitted workspace', details?: unknown) {
    super(ERROR_CODES.PATH_REJECTED, message, 400, details);
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'This feature is not implemented yet', details?: unknown) {
    super(ERROR_CODES.NOT_IMPLEMENTED, message, 501, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super(ERROR_CODES.INTERNAL_ERROR, message, 503, details);
  }
}

/** Returns true for errors that are safe to expose to the client verbatim. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
