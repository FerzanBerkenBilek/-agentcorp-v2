import { PrismaClient, User } from '@prisma/client';
import { prisma } from '../shared/prisma';

/**
 * Public user profile — never includes passwordHash (M8: no PII/secret leak).
 */
export type PublicUser = Omit<User, 'passwordHash'>;

/** Columns selected for a public profile (single source of truth). */
const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Data required to persist a new user (passwordHash is pre-computed by auth.service). */
export interface CreateUserData {
  email: string;
  passwordHash: string;
  name: string;
}

/**
 * Read-mostly leaf repository for the User aggregate (ADR-011).
 *
 * It is the single source of truth for the users table and is depended on by
 * both `auth` and `tasks`. It is intentionally thin (one query per method, no
 * business logic) to avoid becoming a god module. All email values are assumed
 * to be already lowercased by the caller (auth.service owns that rule).
 */
export class UsersRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Find a user by id, returning the public profile (no passwordHash).
   *
   * @param id User UUID.
   * @returns The public user, or null if not found.
   */
  async findPublicById(id: string): Promise<PublicUser | null> {
    return this.db.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
  }

  /**
   * Find a full user row by email (includes passwordHash for login).
   *
   * @param email Lowercased email address.
   * @returns The full user row, or null if not found.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { email } });
  }

  /**
   * Check whether a user id exists (used for assignee validation, M5).
   *
   * @param id User UUID to check.
   * @returns True if a user with that id exists.
   */
  async existsById(id: string): Promise<boolean> {
    const found = await this.db.user.findUnique({ where: { id }, select: { id: true } });
    return found !== null;
  }

  /**
   * Create a new user. Email must already be lowercased and uniqueness-checked
   * by the caller; the DB unique constraint is the final guard.
   *
   * @param data The new user's email, passwordHash, and name.
   * @returns The created public user (no passwordHash).
   */
  async create(data: CreateUserData): Promise<PublicUser> {
    return this.db.user.create({ data, select: PUBLIC_USER_SELECT });
  }
}
