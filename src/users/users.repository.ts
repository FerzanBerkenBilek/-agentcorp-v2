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
  // Authorization role (ADR-030). Part of the public profile: the JWT `role`
  // claim is derived from this column at token issue, so callers that build the
  // session/principal read it here. Never a secret (unlike passwordHash).
  role: true,
  // Google OAuth identity (ADR-041). Both are part of the public profile and
  // NOT secret (unlike passwordHash): PublicUser = Omit<User,'passwordHash'>
  // includes them in the TYPE, so the runtime select must include them too or
  // PublicUser drifts. googleId is the public identity join key; googleEmail is
  // audit/display. NULL for every password-only account.
  googleId: true,
  googleEmail: true,
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
 * Data required to create a user from a Google OAuth identity (ADR-036 §3, G3).
 * `passwordHash` is a non-matching dummy supplied by auth.service so the new
 * passwordless account fails closed on any password login (G7); `googleId` is
 * the immutable Google `sub`, `googleEmail` the verified email Google returned.
 */
export interface CreateOAuthUserData {
  email: string;
  passwordHash: string;
  name: string;
  googleId: string;
  googleEmail: string;
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

  /**
   * Find a user by their Google `sub` (the immutable OAuth join key, ADR-036 §1).
   * This is the hot path on every OAuth callback for a returning Google user;
   * it probes the `users_google_id_key` UNIQUE index (data-lead ADR-041).
   *
   * @param googleId The Google `sub` claim (opaque string).
   * @returns The public user linked to that Google identity, or null.
   */
  async findByGoogleId(googleId: string): Promise<PublicUser | null> {
    return this.db.user.findUnique({ where: { googleId }, select: PUBLIC_USER_SELECT });
  }

  /**
   * Create a new account from a verified Google identity (ADR-036 §3, G3).
   * Email must already be lowercased by the caller. The DB UNIQUE(email) and
   * UNIQUE(google_id) constraints are the final guards (the latter is the G6
   * takeover backstop). The supplied `passwordHash` is a non-matching dummy so
   * the account cannot password-login (G7).
   *
   * @param data Email, dummy passwordHash, name, googleId, googleEmail.
   * @returns The created public user (no passwordHash).
   */
  async createFromOAuth(data: CreateOAuthUserData): Promise<PublicUser> {
    return this.db.user.create({ data, select: PUBLIC_USER_SELECT });
  }

  /**
   * Link a Google identity to an EXISTING account, first-time-only (ADR-036 §5,
   * G5). The write is conditional — `WHERE id = $id AND google_id IS NULL` — so
   * two concurrent first-logins cannot both bind, and an already-linked row is
   * never overwritten. Returns the linked public user, or null if the guard
   * matched no row (already linked / lost the race), which the service maps to a
   * conflict (G6).
   *
   * @param userId The id of the existing account to link.
   * @param googleId The Google `sub` to bind (immutable join key).
   * @param googleEmail The verified Google email, stored for audit/display.
   * @returns The linked public user, or null if the conditional guard did not match.
   */
  async linkGoogleAccount(
    userId: string,
    googleId: string,
    googleEmail: string,
  ): Promise<PublicUser | null> {
    // updateMany lets the WHERE include the `google_id IS NULL` guard (a plain
    // `update` requires a unique-only where and cannot express the guard). The
    // returned count is the optimistic-concurrency signal: 1 = we bound it,
    // 0 = a concurrent first-login already bound it (G5/G6 race backstop).
    const { count } = await this.db.user.updateMany({
      where: { id: userId, googleId: null },
      data: { googleId, googleEmail },
    });
    if (count === 0) {
      return null;
    }
    return this.findPublicById(userId);
  }
}
