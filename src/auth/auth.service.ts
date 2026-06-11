import bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { AuthError, ConflictError } from '../shared/errors';
import { TokenReuseError } from './token-reuse.error';
import { signAccessToken } from '../shared/jwt';
import { UsersRepository, PublicUser } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import { LoginInput, RegisterInput } from './auth.schemas';
import { GoogleIdentity } from './google-oauth.client';

/**
 * A dummy bcrypt hash compared against when no user is found, so that login
 * takes constant time whether or not the email exists (H4: no enumeration).
 * Generated once for a throwaway value; never matches a real password.
 */
const DUMMY_BCRYPT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO3Jq3K3qZ3qZ3qZ3qZ3qZ3qZ3qZ3qZ3q';

/** Result of a successful authentication (tokens + public user). */
export interface AuthResult {
  accessToken: string;
  /** Raw refresh token — the route sets this as an HttpOnly cookie, never JSON. */
  refreshToken: string;
  user: PublicUser;
}

/**
 * Which branch of the create-or-link ladder (ADR-036, G1–G3) produced the
 * session, so the route can emit the right audit event (G24):
 *  - `login`  — returning Google user matched by google_id (G1),
 *  - `link`   — verified email matched an existing account, now bound (G2),
 *  - `create` — new passwordless account created (G3).
 */
export type GoogleLoginKind = 'login' | 'link' | 'create';

/** A successful Google login plus the branch that produced it (for auditing). */
export interface GoogleLoginResult extends AuthResult {
  kind: GoogleLoginKind;
}

/**
 * A dummy non-matching bcrypt hash stamped on OAuth-created (passwordless)
 * accounts (ADR-036 §3, G7). It is a real bcrypt hash of a throwaway value, so
 * `bcrypt.compare` in the password-login path runs in constant time and ALWAYS
 * fails — a Google-only account can never password-login. Reuses the same
 * fail-closed discipline as DUMMY_BCRYPT_HASH on the login path.
 */
const OAUTH_PLACEHOLDER_PASSWORD_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEeO3Jq3K3qZ3qZ3qZ3qZ3qZ3qZ3qZ3qZ3q';

/**
 * Authentication business logic: registration, login, refresh-token rotation
 * with reuse detection (ADR-012, H2), and logout. Framework-agnostic — it
 * knows nothing about HTTP, cookies, or Fastify.
 */
export class AuthService {
  /**
   * @param users Users repository (read/create users; ADR-011 ownership).
   * @param authRepo Refresh-token repository (rotation/reuse state).
   */
  constructor(
    private readonly users: UsersRepository,
    private readonly authRepo: AuthRepository,
  ) {}

  /**
   * Register a new account, then issue an initial token pair.
   *
   * @param input Validated registration data.
   * @returns Access token, refresh token, and the public user.
   * @throws ConflictError if the (lowercased) email is already registered.
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    const email = input.email.toLowerCase();
    if (await this.users.findByEmail(email)) {
      throw new ConflictError('Email address is already registered');
    }
    const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_ROUNDS);
    const user = await this.users.create({ email, passwordHash, name: input.name });
    return this.issueNewSession(user);
  }

  /**
   * Authenticate with email + password (timing-safe; generic error on failure).
   *
   * @param input Validated login credentials.
   * @returns Access token, refresh token, and the public user.
   * @throws AuthError ("Invalid email or password") on any credential mismatch.
   */
  async login(input: LoginInput): Promise<AuthResult> {
    const email = input.email.toLowerCase();
    const user = await this.users.findByEmail(email);
    // Always run bcrypt to keep response time constant whether or not the
    // account exists (H4: prevent user enumeration via timing).
    const hash = user?.passwordHash ?? DUMMY_BCRYPT_HASH;
    const passwordMatches = await bcrypt.compare(input.password, hash);
    if (!user || !passwordMatches) {
      throw new AuthError('Invalid email or password');
    }
    const { passwordHash: _omit, ...publicUser } = user;
    return this.issueNewSession(publicUser);
  }

  /**
   * Create-or-link a user from a verified Google identity, then issue the SAME
   * session as /auth/login (ADR-036, G1–G7, G22). The identity MUST already be
   * the back-channel-verified one from GoogleOAuthClient — this method does NOT
   * talk to Google; it owns the takeover-defense policy only.
   *
   * The ladder (ADR-036):
   *  1. google_id match → returning OAuth user → issue session (G1).
   *  2. else if email_verified && primary-email matches an existing account →
   *     LINK first-time-only (conditional write) → issue session (G2/G5).
   *  3. else if email_verified && no match → CREATE a passwordless USER → issue
   *     session (G3).
   *  4. else (email NOT verified) → REJECT — never link, never create-separate
   *     (G4, the takeover defense).
   *
   * @param identity The Google identity from the server-side exchange.
   * @returns The session (tokens + user) and the branch taken (for auditing).
   * @throws AuthError if email_verified is false/absent (G4), or generically on
   *   any failure (no enumeration).
   * @throws ConflictError if a concurrent first-login already bound this account
   *   or a second Google identity claims a linked row (G6).
   */
  async loginWithGoogle(identity: GoogleIdentity): Promise<GoogleLoginResult> {
    // G1: a returning Google user resolves by google_id ONLY, never by email.
    const linked = await this.users.findByGoogleId(identity.sub);
    if (linked) {
      return this.completeGoogleLogin(linked, 'login');
    }
    // G4 (takeover defense): an unverified Google email may NOT link or create.
    // This gate sits AFTER the google_id lookup (an already-linked account is a
    // trusted prior decision) but BEFORE any email-based branch.
    if (!identity.emailVerified) {
      throw new AuthError('Google account email is not verified');
    }
    const email = identity.email.toLowerCase();
    const existing = await this.users.findByEmail(email);
    if (existing) {
      return this.linkExistingAccount(existing.id, identity, email);
    }
    return this.createOAuthAccount(identity, email);
  }

  /**
   * LINK a verified Google identity to an existing account, first-time-only
   * (ADR-036 §2/§5, G2/G5/G6). A null result from the conditional repo write
   * means the row was already linked (race lost / re-point attempt) → conflict.
   *
   * @param userId The existing account id.
   * @param identity The verified Google identity.
   * @param email The lowercased primary email (matched target).
   * @returns The session + 'link' kind.
   * @throws ConflictError if the account is already linked (G6).
   */
  private async linkExistingAccount(
    userId: string,
    identity: GoogleIdentity,
    email: string,
  ): Promise<GoogleLoginResult> {
    const user = await this.guardUniqueGoogleId(() =>
      this.users.linkGoogleAccount(userId, identity.sub, email),
    );
    if (!user) {
      throw new ConflictError('This account is already linked to a different Google identity');
    }
    return this.completeGoogleLogin(user, 'link');
  }

  /**
   * CREATE a new passwordless USER from a verified Google identity (ADR-036 §3,
   * G3/G7). A UNIQUE(google_id) violation (a concurrent create of the same
   * identity) surfaces as a conflict (G6 backstop).
   *
   * @param identity The verified Google identity.
   * @param email The lowercased email used as both primary email and googleEmail.
   * @returns The session + 'create' kind.
   * @throws ConflictError on a unique-constraint race (G6).
   */
  private async createOAuthAccount(
    identity: GoogleIdentity,
    email: string,
  ): Promise<GoogleLoginResult> {
    const user = await this.guardUniqueGoogleId(() =>
      this.users.createFromOAuth({
        email,
        // G7: a non-matching dummy hash → the account can never password-login.
        passwordHash: OAUTH_PLACEHOLDER_PASSWORD_HASH,
        name: identity.name ?? email,
        googleId: identity.sub,
        googleEmail: email,
      }),
    );
    return this.completeGoogleLogin(user, 'create');
  }

  /**
   * Run a repo write that may hit UNIQUE(google_id) (or UNIQUE(email)) and
   * translate a Prisma P2002 into a generic ConflictError (G6) — the takeover
   * backstop. Any other Prisma/unexpected error propagates unchanged.
   *
   * @param write The repo operation to guard.
   * @returns The operation's result.
   * @throws ConflictError on a P2002 unique-constraint violation.
   */
  private async guardUniqueGoogleId<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('This Google account cannot be linked');
      }
      throw err;
    }
  }

  /**
   * Issue the standard session for a Google login and tag the branch (G22).
   * Delegates to the SAME issueNewSession token path as password login — no fork.
   *
   * @param user The resolved/linked/created public user.
   * @param kind The ladder branch (for the route's audit event).
   * @returns The session result plus the kind.
   */
  private async completeGoogleLogin(
    user: PublicUser,
    kind: GoogleLoginKind,
  ): Promise<GoogleLoginResult> {
    const session = await this.issueNewSession(user);
    return { ...session, kind };
  }

  /**
   * Rotate a presented refresh token: validate, detect reuse, and issue a new
   * pair (H2). Reuse of a consumed token revokes the whole family.
   *
   * @param rawToken The refresh token presented from the HttpOnly cookie.
   * @returns A fresh access + refresh token pair and the public user.
   * @throws AuthError if the token is unknown, expired, or reused.
   */
  async refresh(rawToken: string): Promise<AuthResult> {
    const record = await this.authRepo.findByHash(this.hashToken(rawToken));
    if (!record) {
      throw new AuthError('Invalid refresh token');
    }
    await this.assertTokenUsable(record);
    // Consume the presented token, then mint the next one in the same family.
    await this.authRepo.revokeById(record.id);
    const user = await this.users.findPublicById(record.userId);
    if (!user) {
      throw new AuthError('Invalid refresh token');
    }
    const refreshToken = await this.persistRefreshToken(user.id, record.family);
    // ADR-030/033: derive the `role` claim from the freshly re-read persisted
    // user, never from any request input. Re-reading here means a demotion takes
    // effect on the next refresh (R5).
    return { accessToken: signAccessToken(user.id, user.role), refreshToken, user };
  }

  /**
   * Log out by revoking the entire family of the presented refresh token.
   * Idempotent: unknown tokens succeed silently (logout must never fail).
   *
   * @param rawToken The refresh token from the HttpOnly cookie (may be absent).
   * @returns The resolved owner's userId, or null if the token was absent or
   *   unknown — surfaced so the route can audit the real actor (P1.2).
   */
  async logout(rawToken: string | undefined): Promise<string | null> {
    if (!rawToken) {
      return null;
    }
    const record = await this.authRepo.findByHash(this.hashToken(rawToken));
    if (record) {
      await this.authRepo.revokeFamily(record.family);
      return record.userId;
    }
    return null;
  }

  /**
   * Guard a refresh-token record: reject expired tokens and, on reuse of a
   * consumed token, revoke the whole family (assumed theft, H2).
   *
   * @param record The refresh-token row being validated.
   * @throws TokenReuseError if the token was already consumed (reused); carries
   *   the reuse context so the route can audit TOKEN_REUSE_DETECTED (ADR-012).
   * @throws AuthError if the token is expired.
   */
  private async assertTokenUsable(record: {
    revokedAt: Date | null;
    expiresAt: Date;
    family: string;
    jti: string;
    userId: string;
  }): Promise<void> {
    if (record.revokedAt !== null) {
      // A consumed token presented again => theft => kill the family.
      await this.authRepo.revokeFamily(record.family);
      throw new TokenReuseError({
        userId: record.userId,
        family: record.family,
        jti: record.jti,
      });
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AuthError('Refresh token expired');
    }
  }

  /**
   * Issue a brand-new session (new family) for a user.
   *
   * @param user The authenticated public user.
   * @returns Access token, refresh token, and the user.
   */
  private async issueNewSession(user: PublicUser): Promise<AuthResult> {
    const refreshToken = await this.persistRefreshToken(user.id, randomUUID());
    // ADR-030/033: `role` is signed from the persisted column on the public user,
    // never client-supplied — closes the self-promotion / role-in-body path (R1).
    return { accessToken: signAccessToken(user.id, user.role), refreshToken, user };
  }

  /**
   * Mint a random refresh token, persist its SHA-256 hash under the given
   * family, and return the raw value (only the hash is stored, H2).
   *
   * @param userId Token owner.
   * @param family Rotation family this token belongs to.
   * @returns The raw refresh token to hand to the client.
   */
  private async persistRefreshToken(userId: string, family: string): Promise<string> {
    const jti = randomUUID();
    const signOptions: SignOptions = {
      algorithm: 'HS256',
      expiresIn: config.REFRESH_TOKEN_TTL as SignOptions['expiresIn'],
    };
    const rawToken = jwt.sign({ sub: userId, jti }, config.JWT_REFRESH_SECRET, signOptions);
    await this.authRepo.createToken({
      hashedToken: this.hashToken(rawToken),
      family,
      jti,
      userId,
      expiresAt: this.decodeExpiry(rawToken),
    });
    return rawToken;
  }

  /**
   * Compute the SHA-256 hex digest of a token for storage/lookup.
   *
   * @param token Raw token string.
   * @returns 64-char hex digest.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Read the absolute expiry from a signed refresh JWT's `exp` claim.
   *
   * @param token The signed refresh token.
   * @returns The expiry Date.
   */
  private decodeExpiry(token: string): Date {
    const decoded = jwt.decode(token);
    const exp = typeof decoded === 'object' && decoded?.exp ? decoded.exp : 0;
    return new Date(exp * 1000);
  }
}
