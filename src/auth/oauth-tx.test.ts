import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  newOAuthTx,
  openOAuthTx,
  OAUTH_TX_COOKIE_PATH,
  OAUTH_TX_MAX_AGE_SECONDS,
  oauthTxCookieOptions,
  sealOAuthTx,
  statesMatch,
} from './oauth-tx';

/**
 * Re-implement the module's private HMAC-SHA256 sign with the known test secret
 * (src/test/setup.ts sets JWT_SECRET) so we can forge a VALIDLY-SIGNED cookie
 * over an arbitrary payload. This lets us reach the JSON.parse-boundary guards
 * in openOAuthTx (a signed value whose decoded body is the wrong shape or is not
 * JSON must STILL be rejected) — a real behavior the route relies on, not a pad.
 */
const TEST_JWT_SECRET = 'test-jwt-secret-value-0123456789-abcdef';
function signedCookie(rawPayloadBytes: Buffer): string {
  const payload = rawPayloadBytes.toString('base64url');
  const sig = createHmac('sha256', TEST_JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Unit tests for the transient OAuth state cookie (ADR-037 §4, G8–G11).
 * These cover the crypto-integrity contract the route relies on. The
 * exhaustive route-level matrix is OA-5 (qa-engineer); this is self-verify
 * smoke + the security-critical edges (forgery, tamper, single-use compare).
 */
describe('oauth-tx', () => {
  it('should_roundtrip_a_sealed_tx', () => {
    const tx = newOAuthTx();
    const opened = openOAuthTx(sealOAuthTx(tx));
    expect(opened).toEqual(tx);
  });

  it('should_generate_distinct_high_entropy_state_and_verifier', () => {
    const a = newOAuthTx();
    const b = newOAuthTx();
    expect(a.state).not.toEqual(b.state);
    expect(a.verifier).not.toEqual(b.verifier);
    expect(a.state).not.toEqual(a.verifier);
    // 32 random bytes base64url ≈ 43 chars.
    expect(a.state.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('should_return_null_when_cookie_absent', () => {
    expect(openOAuthTx(undefined)).toBeNull();
    expect(openOAuthTx('')).toBeNull();
  });

  it('should_reject_a_forged_signature', () => {
    const sealed = sealOAuthTx(newOAuthTx());
    const [payload] = sealed.split('.');
    const forged = `${payload}.not-a-valid-signature`;
    expect(openOAuthTx(forged)).toBeNull();
  });

  it('should_reject_a_tampered_payload', () => {
    const tx = newOAuthTx();
    const sealed = sealOAuthTx(tx);
    const sig = sealed.slice(sealed.indexOf('.') + 1);
    const tamperedPayload = Buffer.from(
      JSON.stringify({ state: 'attacker', verifier: 'attacker' }),
      'utf8',
    ).toString('base64url');
    expect(openOAuthTx(`${tamperedPayload}.${sig}`)).toBeNull();
  });

  it('should_reject_a_value_with_no_signature_separator', () => {
    expect(openOAuthTx('justpayloadnodot')).toBeNull();
  });

  it('should_reject_a_value_whose_signature_is_empty_after_the_dot', () => {
    const sealed = sealOAuthTx(newOAuthTx());
    const [payload] = sealed.split('.');
    expect(openOAuthTx(`${payload}.`)).toBeNull();
  });

  it('should_reject_a_correctly_signed_cookie_whose_payload_is_the_wrong_shape', () => {
    // Validly signed (passes the HMAC check) but decodes to an object missing the
    // state/verifier strings → isOAuthTx guard rejects it (defends JSON boundary).
    const forged = signedCookie(Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8'));
    expect(openOAuthTx(forged)).toBeNull();
    // Also a signed JSON primitive (not an object) must be rejected.
    const primitive = signedCookie(Buffer.from(JSON.stringify('just-a-string'), 'utf8'));
    expect(openOAuthTx(primitive)).toBeNull();
  });

  it('should_reject_a_correctly_signed_cookie_whose_payload_is_not_valid_json', () => {
    // Validly signed but the decoded bytes are not parseable JSON → the catch in
    // openOAuthTx returns null (no throw escapes to the route).
    const forged = signedCookie(Buffer.from('not-json{', 'utf8'));
    expect(openOAuthTx(forged)).toBeNull();
  });

  it('should_constant_time_compare_states', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch('', '')).toBe(true);
  });

  it('should_scope_the_cookie_to_the_oauth_path_with_lax_samesite_and_bounded_ttl', () => {
    const opts = oauthTxCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax'); // G9: Lax, NOT Strict
    expect(opts.path).toBe(OAUTH_TX_COOKIE_PATH);
    expect(opts.path).toBe('/auth/google');
    expect(opts.maxAge).toBe(OAUTH_TX_MAX_AGE_SECONDS);
    expect(opts.maxAge).toBeLessThanOrEqual(600); // G9: ≤ 600s
  });
});
