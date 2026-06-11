import { UserRole } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireRole } from './auth-context';
import { AuthError, ForbiddenError } from './errors';

/**
 * Unit tests for the ADR-033 role guard (R7/R8). `requireRole` is a Fastify
 * preHandler factory; we drive it with a minimal request stub carrying the
 * `authContext` that `authGuard` would have set, asserting default-deny + the
 * 403 ruling (a role failure is 403, distinct from the object-level 404).
 */

const reply = {} as FastifyReply;

/** Build a request stub with (or without) an authContext. */
function req(authContext?: { userId: string; role: UserRole }): FastifyRequest {
  return { authContext } as unknown as FastifyRequest;
}

describe('requireRole', () => {
  it('should_allow_an_admin_through', async () => {
    const guard = requireRole(UserRole.ADMIN);

    await expect(
      guard(req({ userId: 'u1', role: UserRole.ADMIN }), reply),
    ).resolves.toBeUndefined();
  });

  it('should_throw_ForbiddenError_403_for_a_non_admin', async () => {
    const guard = requireRole(UserRole.ADMIN);

    await expect(guard(req({ userId: 'u1', role: UserRole.USER }), reply)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('should_default_deny_when_the_auth_guard_did_not_run', async () => {
    const guard = requireRole(UserRole.ADMIN);

    // No authContext -> requireAuth throws AuthError (401), never silently passes.
    await expect(guard(req(undefined), reply)).rejects.toBeInstanceOf(AuthError);
  });
});
