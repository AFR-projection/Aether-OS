/**
 * Wire format for every HTTP response produced by the Aether backend.
 *
 * Success responses are wrapped as `{ data: ... }`. Errors are wrapped as
 * `{ error: ... }`. The frontend API client relies on this shape being stable.
 */

export interface ApiError {
  /** Stable, machine-readable code, e.g. `INVALID_CREDENTIALS`. */
  code: string;
  /** Human-readable message. Never contains secrets or internal stack traces. */
  message: string;
  statusCode: number;
  timestamp: string;
  requestId?: string;
  /** Optional structured detail, e.g. Zod field errors. */
  details?: unknown;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface ApiDataResponse<T> {
  data: T;
}

/** Error codes emitted by the backend. Kept in one place so clients can switch on them. */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  PATH_REJECTED: 'PATH_REJECTED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
