import jwt, { JwtPayload as LibJwtPayload, SignOptions } from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { AuthError } from './errors';

/**
 * JWT signing/verification utilities (H3 — JWT hardening + ADR-033 role claim).
 *
 * Hardening guarantees:
 *  - Algorithm is pinned to HS256 on both sign AND verify.
 *  - `algorithms: ['HS256']` on verify means an attacker-supplied
 *    `alg: none` (or RS256 confusion) token is rejected.
 *  - Secrets come from validated env config (>= 32 bytes; see config.ts).
 *  - Access payload is { sub, role, iat, exp }; iat/exp are added by the lib.
 *  - Expired tokens are rejected (lib validates `exp`) and surfaced as AuthError.
 *
 * Role claim (ADR-030/033): `role` is signed into the token from the persisted
 * `users.role` column at issue time ONLY — it is never read from a request body,
 * so a client cannot self-promote (the HS256 signature also covers it, so a
 * forged/`alg:none` token is rejected). Back-compat (R6): a legacy token that
 * predates this feature has NO `role` claim; it verifies and defaults to USER,
 * NOT an error. Only an INVALID role *value* (a string that is neither USER nor
 * ADMIN) is rejected.
 */

/** The only permitted JWT algorithm (H3: pin HS256, reject 'none'). */
const JWT_ALGORITHM = 'HS256' as const;

/** Decoded access-token payload. */
export interface AccessTokenPayload {
  /** Subject = user id. */
  sub: string;
  /** Authorization role (ADR-030/033), defaulted to USER for legacy tokens (R6). */
  role: UserRole;
  /** Issued-at (epoch seconds), set by the signer. */
  iat: number;
  /** Expiry (epoch seconds), set by the signer. */
  exp: number;
}

/**
 * Sign a short-lived access token for a user.
 *
 * @param userId The authenticated user's id (becomes `sub`).
 * @param role The user's role read from the persisted `users.role` column
 *   (ADR-030/033 — NEVER from a request body). Re-read on every issue/refresh
 *   so a demotion takes effect within one access-token TTL (R5).
 * @returns A signed HS256 JWT string carrying `{ sub, role }`.
 */
export function signAccessToken(userId: string, role: UserRole): string {
  // TTL is a validated env string (e.g. "15m"); cast to the lib's ms StringValue type.
  const options: SignOptions = {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: userId, role }, config.JWT_SECRET, options);
}

/**
 * Verify and decode an access token.
 *
 * @param token The raw bearer token from the Authorization header.
 * @returns The decoded, validated access-token payload.
 * @throws AuthError if the token is malformed, expired, or fails signature/alg checks.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    });
    return assertAccessPayload(decoded);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw new AuthError('Invalid or expired access token');
  }
}

/**
 * Narrow a decoded JWT to a well-formed AccessTokenPayload.
 *
 * @param decoded The value returned by jwt.verify.
 * @returns The payload typed as AccessTokenPayload.
 * @throws AuthError if required claims are missing or the role value is invalid.
 */
function assertAccessPayload(decoded: string | LibJwtPayload): AccessTokenPayload {
  if (
    typeof decoded === 'string' ||
    typeof decoded.sub !== 'string' ||
    typeof decoded.iat !== 'number' ||
    typeof decoded.exp !== 'number'
  ) {
    throw new AuthError('Invalid access token claims');
  }
  return { sub: decoded.sub, role: normalizeRole(decoded.role), iat: decoded.iat, exp: decoded.exp };
}

/**
 * Resolve the `role` claim to a valid UserRole (ADR-033, R6).
 *
 * Back-compat: a MISSING role (legacy `{sub,iat,exp}` tokens issued before this
 * feature) defaults to USER — it is NOT an error, so the existing token corpus
 * keeps verifying as non-admin. An INVALID role *value* (present but neither
 * USER nor ADMIN) IS rejected, since a token carrying an unrecognized role is
 * malformed/tampered and must not be silently downgraded.
 *
 * @param raw The raw `role` claim from the decoded token (unknown shape).
 * @returns The validated UserRole.
 * @throws AuthError if `role` is present but not a valid UserRole value.
 */
function normalizeRole(raw: unknown): UserRole {
  if (raw === undefined) {
    return UserRole.USER;
  }
  if (raw === UserRole.USER || raw === UserRole.ADMIN) {
    return raw;
  }
  throw new AuthError('Invalid access token claims');
}
