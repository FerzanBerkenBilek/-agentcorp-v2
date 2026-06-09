import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authGuard, requireAuth } from '../shared/auth-context';
import { NotFoundError } from '../shared/errors';
import { ok } from '../shared/http';
import { UsersRepository } from './users.repository';
import { toUserProfileResponse } from './users.schemas';

/** Dependencies injected into the users routes plugin. */
export interface UsersRoutesDeps {
  usersRepository: UsersRepository;
}

/**
 * Users route plugin.
 *
 * GET /users/me — returns the authenticated user's profile (no passwordHash).
 * This module has no service layer because there is no business logic: it is a
 * thin authorized read of the User aggregate (ADR-011 users is a read leaf).
 *
 * @param app The Fastify instance to register routes on.
 * @param deps Injected dependencies (users repository).
 * @returns A promise that resolves once routes are registered.
 */
export const usersRoutes: FastifyPluginAsync<UsersRoutesDeps> = async (
  app: FastifyInstance,
  deps: UsersRoutesDeps,
): Promise<void> => {
  app.get('/users/me', { preHandler: authGuard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const user = await deps.usersRepository.findPublicById(userId);
    if (!user) {
      // Token is valid but the account was deleted — treat as not found.
      throw new NotFoundError('User');
    }
    return reply.send(ok(toUserProfileResponse(user)));
  });
};
