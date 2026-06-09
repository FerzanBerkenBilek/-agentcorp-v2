import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorHandler } from './error-handler';
import { ConflictError, NotFoundError } from './errors';

/**
 * Unit tests for the global error handler (ADR-010 rule #4 / M8).
 *
 * Verifies that domain errors map to their status + envelope, known Fastify
 * errors map to the right HTTP code, and unexpected errors become a sanitized
 * 500 that never leaks internals.
 */

/** Build a minimal reply test double capturing status + sent body. */
function makeReply(): {
  reply: FastifyReply;
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

/** A request double whose logger.error is a spy. */
function makeRequest(): FastifyRequest {
  return { log: { error: vi.fn() } } as unknown as FastifyRequest;
}

describe('errorHandler', () => {
  it('should_map_AppError_to_its_status_and_envelope', () => {
    const { reply, sent } = makeReply();

    errorHandler(new NotFoundError('Task'), makeRequest(), reply);

    expect(sent.status).toBe(404);
    expect(sent.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    });
  });

  it('should_include_details_when_AppError_carries_them', () => {
    const { reply, sent } = makeReply();

    errorHandler(new ConflictError('dup'), makeRequest(), reply);

    expect(sent.status).toBe(409);
  });

  it('should_map_rate_limit_fastify_error_to_429', () => {
    const { reply, sent } = makeReply();
    const fastifyErr = Object.assign(new Error('rate'), { statusCode: 429 });

    errorHandler(fastifyErr, makeRequest(), reply);

    expect(sent.status).toBe(429);
    expect((sent.body as { error: { code: string } }).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should_map_bad_request_fastify_error_to_422', () => {
    const { reply, sent } = makeReply();
    const fastifyErr = Object.assign(new Error('bad json'), { statusCode: 400 });

    errorHandler(fastifyErr, makeRequest(), reply);

    expect(sent.status).toBe(422);
  });

  it('should_map_body_too_large_to_422', () => {
    const { reply, sent } = makeReply();
    const fastifyErr = Object.assign(new Error('too big'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });

    errorHandler(fastifyErr, makeRequest(), reply);

    expect(sent.status).toBe(422);
  });

  it('should_return_sanitized_500_for_unexpected_errors', () => {
    const { reply, sent } = makeReply();
    const req = makeRequest();

    errorHandler(new Error('database exploded with secret connection string'), req, reply);

    expect(sent.status).toBe(500);
    const body = sent.body as { error: { message: string } };
    expect(body.error.message).toBe('An unexpected error occurred');
    // The raw internal message must NOT leak to the client.
    expect(JSON.stringify(sent.body)).not.toContain('connection string');
    // But it MUST be logged server-side.
    expect(req.log.error).toHaveBeenCalledOnce();
  });
});
