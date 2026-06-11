import bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { AuthError, ConflictError } from '../shared/errors';
import { TokenReuseError } from './token-reuse.error';
import { signAccessToken } from '../shared/jwt';
import { UsersRepository, PublicUser } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import { LoginInput, RegisterInput } from './auth.schemas';

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
