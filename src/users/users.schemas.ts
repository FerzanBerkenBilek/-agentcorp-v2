import { PublicUser } from './users.repository';

/**
 * Response DTO for the current-user profile endpoint.
 * Explicitly enumerated so passwordHash can never accidentally leak (M8).
 */
export interface UserProfileResponse {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map an internal PublicUser to the wire DTO (Dates -> ISO strings).
 *
 * @param user The public user from the repository.
 * @returns The serializable profile response.
 */
export function toUserProfileResponse(user: PublicUser): UserProfileResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
