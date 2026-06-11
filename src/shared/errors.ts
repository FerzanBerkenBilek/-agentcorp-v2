/**
 * Domain error types.
 *
 * Services throw these framework-agnostic errors (they know nothing about
 * HTTP). The single global error handler (app layer) translates each to an
 * HTTP status + JSON envelope (ADR-010 rule #4). Every error carries a
 * machine-readable `code`, a human-readable `message`, the HTTP `statusCode`,
 * and optional structured `details`.
 */

/** Machine-readable error codes (no magic strings at call sites). */
export const ERROR_CODE = {
  VALIDATION: 'VALIDATION_ERROR',
  AUTH: 'AUTH_ERROR',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

/** HTTP status codes used by the domain errors (no magic numbers). */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/**
 * Base class for all expected, handled application errors.
 * Anything that is NOT an AppError is treated as an unexpected internal error
 * by the global handler and is never leaked to the client.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  /**
   * @param code Machine-readable error code (see ERROR_CODE).
   * @param message Human-readable message safe to return to the client.
   * @param statusCode HTTP status code (see HTTP_STATUS).
   * @param details Optional structured details (e.g., Zod field issues).
   */
  constructor(code: string, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    // Restore prototype chain when extending built-in Error in TS.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 422 — request body/query failed schema validation. */
export class ValidationError extends AppError {
  /**
   * @param message Human-readable validation summary.
   * @param details Optional per-field issues.
   */
  constructor(message: string, details?: unknown) {
    super(ERROR_CODE.VALIDATION, message, HTTP_STATUS.UNPROCESSABLE_ENTITY, details);
    this.name = 'ValidationError';
  }
}

/** 401 — missing/invalid credentials or token. Message is intentionally generic. */
export class AuthError extends AppError {
  /** @param message Generic message (must not reveal whether a user exists). */
  constructor(message = 'Authentication required') {
    super(ERROR_CODE.AUTH, message, HTTP_STATUS.UNAUTHORIZED);
    this.name = 'AuthError';
  }
}

/** 403 — authenticated but not permitted. Rarely used for tasks (we prefer 404, H1). */
export class ForbiddenError extends AppError {
  /** @param message Human-readable reason. */
  constructor(message = 'Access denied') {
    super(ERROR_CODE.FORBIDDEN, message, HTTP_STATUS.FORBIDDEN);
    this.name = 'ForbiddenError';
  }
}

/** 404 — resource does not exist OR caller is not authorized to see it (H1). */
export class NotFoundError extends AppError {
  /** @param resource Human-readable resource name, e.g. "Task". */
  constructor(resource: string) {
    super(ERROR_CODE.NOT_FOUND, `${resource} not found`, HTTP_STATUS.NOT_FOUND);
    this.name = 'NotFoundError';
  }
}

/** 409 — conflict with existing state (e.g., duplicate email). */
export class ConflictError extends AppError {
  /** @param message Human-readable conflict description. */
  constructor(message: string) {
    super(ERROR_CODE.CONFLICT, message, HTTP_STATUS.CONFLICT);
    this.name = 'ConflictError';
  }
}

/** 500 — unexpected internal error. Details are never sent to the client. */
export class InternalError extends AppError {
  /** @param message Human-readable message (generic in production). */
  constructor(message = 'Internal server error') {
    super(ERROR_CODE.INTERNAL, message, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    this.name = 'InternalError';
  }
}
