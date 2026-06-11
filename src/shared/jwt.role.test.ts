import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { AuthError } from './errors';
import { signAccessToken, verifyAccessToken } from './jwt';

/**
 * Unit tests for the ADR-030/033 `role` claim on the access token.
 *
 * Real HS256 signing/verification (no mocking the crypto path) so back-compat,
 * tamper-rejection, and the default-USER rule are exercised exactly as in prod.
 */

const USER_ID = '11111111-1111-1111-1111-111111111111';

/** Sign a raw token with an arbitrary payload using the app's secret. */
function signRaw(payload: object): string {
  return jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
}

describe('signAccessToken + verifyAccessToken — role round-trip', () => {
  it('should_round_trip_an_admin_role', () => {
    const token = signAccessToken(USER_ID, UserRole.ADMIN);

    expect(verifyAccessToken(token).role).toBe(UserRole.ADMIN);
  });

  it('should_round_trip_a_user_role', () => {
    const token = signAccessToken(USER_ID, UserRole.USER);

    expect(verifyAccessToken(token).role).toBe(UserRole.USER);
  });
});

describe('verifyAccessToken — back-compat (R6)', () => {
  it('should_default_a_legacy_token_without_a_role_claim_to_USER', () => {
    // A pre-feature token shaped {sub} only (the 282 legacy corpus).
    const legacy = signRaw({ sub: USER_ID });

    expect(verifyAccessToken(legacy).role).toBe(UserRole.USER);
  });
});

describe('verifyAccessToken — tamper / invalid role (R3/R6)', () => {
  it('should_reject_a_token_with_an_invalid_role_value', () => {
    const bad = signRaw({ sub: USER_ID, role: 'SUPERADMIN' });

    expect(() => verifyAccessToken(bad)).toThrow(AuthError);
  });

  it('should_reject_a_token_signed_with_a_different_secret_even_if_it_claims_admin', () => {
    const forged = jwt.sign({ sub: USER_ID, role: UserRole.ADMIN }, 'a'.repeat(40), {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(forged)).toThrow(AuthError);
  });

  it('should_reject_an_alg_none_token_claiming_admin', () => {
    const none = jwt.sign({ sub: USER_ID, role: UserRole.ADMIN }, '', { algorithm: 'none' });

    expect(() => verifyAccessToken(none)).toThrow(AuthError);
  });
});
