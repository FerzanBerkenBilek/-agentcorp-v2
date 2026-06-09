import jwt, { JwtPayload as LibJwtPayload, SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { AuthError } from './errors';

/**
 * JWT signing/verification utilities (H3 — JWT hardening).
 *
 * Hardening guarantees:
 *  - Algorithm is pinned to HS256 on both sign AND verify.
 *  - `algorithms: ['HS256']` on verify means an attacker-supplied
 *    `alg: none` (or RS256 confusion) token is rejected.
 *  - Secrets come from validated env config (>= 32 bytes; see config.ts).
 *  - Access payload is exactly { sub, iat, exp }; iat/exp are added by the lib.
 *  - Expired tokens are rejected (lib validates `exp`) and surfaced as AuthError.
 */

/** The only permitted JWT algorithm (H3: pin HS256, reject 'none'). */
const JWT_ALGORITHM = 'HS256' as const;

/** Decoded access-token payload. */
export interface AccessTokenPayload {
  /** Subject = user id. */
  sub: string;
  /** Issued-at (epoch seconds), set by the signer. */
  iat: number;
  /** Expiry (epoch seconds), set by the signer. */
  exp: number;
}

/**
 * Sign a short-lived access token for a user.
 *
 * @param userId The authenticated user's id (becomes `sub`).
 * @returns A signed HS256 JWT string.
 */
export function signAccessToken(userId: string): string {
  // TTL is a validated env string (e.g. "15m"); cast to the lib's ms StringValue type.
  const options: SignOptions = {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  };
  return jwt.sign({ sub: userId }, config.JWT_SECRET, options);
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
 * @throws AuthError if required claims are missing.
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
  return { sub: decoded.sub, iat: decoded.iat, exp: decoded.exp };
}
