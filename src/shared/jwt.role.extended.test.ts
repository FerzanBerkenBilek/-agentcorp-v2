import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { AuthError } from './errors';
import { signAccessToken, verifyAccessToken } from './jwt';

/**
 * QA EXTENSION (AP-4) for the ADR-030/033 role claim. Closes the claim-shape
 * rejection branch backend-dev's jwt.role.test.ts left uncovered (jwt.ts L94-95:
 * a decoded token missing `sub` is rejected even though it carries iat/exp) and
 * pins the unforgeability property the R1/R3/R6 checklist demands: `role` is
 * signed server-side and a client cannot promote itself by stuffing a claim into
 * an UNSIGNED-by-our-secret token.
 */

const USER_ID = '11111111-1111-1111-1111-111111111111';

/** Sign a raw token with an arbitrary payload using the app's REAL secret. */
function signRaw(payload: object): string {
  return jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
}

describe('verifyAccessToken — malformed claim shapes are rejected (jwt L88-95)', () => {
  it('should_reject_a_token_with_no_sub_claim', async () => {
    // iat/exp present (added by the signer) but `sub` absent -> rejected.
    const noSub = signRaw({ role: UserRole.USER });

    expect(() => verifyAccessToken(noSub)).toThrow(AuthError);
  });

  it('should_reject_a_token_whose_sub_is_not_a_string', async () => {
    const badSub = signRaw({ sub: 12345, role: UserRole.USER });

    expect(() => verifyAccessToken(badSub)).toThrow(AuthError);
  });

  it('should_reject_a_token_decoded_to_a_bare_string_payload', async () => {
    // jwt can sign a string payload; it then has no iat/exp object claims.
    const stringPayload = jwt.sign('just-a-string', config.JWT_SECRET, { algorithm: 'HS256' });

    expect(() => verifyAccessToken(stringPayload)).toThrow(AuthError);
  });

  it('should_reject_an_expired_token_even_with_a_valid_role', async () => {
    const expired = jwt.sign({ sub: USER_ID, role: UserRole.ADMIN }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });

    expect(() => verifyAccessToken(expired)).toThrow(AuthError);
  });
});

describe('signAccessToken — role is sealed by the signature (R1/R3 unforgeability)', () => {
  it('should_produce_a_token_whose_role_cannot_be_swapped_without_breaking_the_signature', () => {
    // Sign as USER, then naively swap the role segment of the JWT to ADMIN and
    // re-encode. The HS256 signature no longer matches -> verify rejects. This is
    // the concrete proof a client cannot self-promote by editing the token body.
    const userToken = signAccessToken(USER_ID, UserRole.USER);
    const [header, payloadB64, signature] = userToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.role = UserRole.ADMIN;
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    expect(() => verifyAccessToken(tampered)).toThrow(AuthError);
  });

  it('should_verify_an_admin_role_only_when_signed_with_our_secret', () => {
    // Same admin claim, but signed with a DIFFERENT secret -> rejected (R3).
    const honest = signAccessToken(USER_ID, UserRole.ADMIN);
    const forged = jwt.sign({ sub: USER_ID, role: UserRole.ADMIN }, 'x'.repeat(40), {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    expect(verifyAccessToken(honest).role).toBe(UserRole.ADMIN);
    expect(() => verifyAccessToken(forged)).toThrow(AuthError);
  });
});
