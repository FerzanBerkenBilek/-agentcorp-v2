import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODE, HTTP_STATUS } from './errors';
import { ApiError } from './http';

/**
 * Single global error handler (ADR-010 rule #4). Translates domain errors and
 * known Fastify errors into the uniform error envelope, and converts anything
 * unexpected into a sanitized 500 — never leaking stack traces or internals to
 * the client in production (M8).
 *
 * @param error The thrown error.
 * @param request The request (used for logging).
 * @param reply The reply to send the error response on.
 * @returns void
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    sendError(reply, error.statusCode, error.code, error.message, error.details);
    return;
  }

  const fastifyError = error as FastifyError;

  // Rate limiter (@fastify/rate-limit) -> 429.
  if (fastifyError.statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
    sendError(
      reply,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      ERROR_CODE.RATE_LIMIT,
      'Too many requests. Please try again later.',
    );
    return;
  }

  // Malformed JSON / body too large / Fastify schema errors -> 422.
  if (fastifyError.statusCode === HTTP_STATUS.BAD_REQUEST || fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    sendError(
      reply,
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      ERROR_CODE.VALIDATION,
      'Request could not be processed',
    );
    return;
  }

  // Unexpected: log full detail server-side, return a generic message.
  request.log.error({ err: error }, 'Unhandled error');
  sendError(
    reply,
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
    ERROR_CODE.INTERNAL,
    'An unexpected error occurred',
  );
}

/**
 * Send a uniform error envelope.
 *
 * @param reply The Fastify reply.
 * @param status HTTP status code.
 * @param code Machine-readable error code.
 * @param message Human-readable message (already safe to expose).
 * @param details Optional structured details.
 * @returns void
 */
function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiError = {
    success: false,
    error: { code, message, ...(details !== undefined && { details }) },
  };
  void reply.status(status).send(body);
}
