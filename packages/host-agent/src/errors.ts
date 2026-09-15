export class AgentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AgentError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

export class UnauthenticatedError extends AgentError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}

export class ForbiddenError extends AgentError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super('FORBIDDEN', message, 403, details);
  }
}

export class NotFoundError extends AgentError {
  constructor(message = 'Resource not found', details?: unknown) {
    super('NOT_FOUND', message, 404, details);
  }
}

export class ConflictError extends AgentError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super('CONFLICT', message, 409, details);
  }
}

export class PathRejectedError extends AgentError {
  constructor(message = 'Path is outside the permitted workspace', details?: unknown) {
    super('PATH_REJECTED', message, 400, details);
  }
}

export class NotImplementedError extends AgentError {
  constructor(message = 'This feature is not implemented yet', details?: unknown) {
    super('NOT_IMPLEMENTED', message, 501, details);
  }
}

export class ServiceUnavailableError extends AgentError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super('SERVICE_UNAVAILABLE', message, 503, details);
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

export function toErrorCode(error: unknown): string {
  return isAgentError(error) ? error.code : 'INTERNAL_ERROR';
}

export function toStatusCode(error: unknown): number {
  return isAgentError(error) ? error.statusCode : 500;
}
