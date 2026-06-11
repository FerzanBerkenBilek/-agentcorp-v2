import jwt, { SignOptions } from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the Fastify-free handshake logic (R1-R4, R18 / ADR-026/027).
 *
 * `isOriginAllowed`'s behaviour depends on config.CORS_ORIGINS + isProduction,
 * both parsed once at config import time. Like csrf.test.ts we load a FRESH
 * handshake module (vi.resetModules + per-test env override) to exercise the
 * dev-skip vs prod-fail-closed branches deterministically. Tokens are real
 * HS256 JWTs signed with the test secret, so verifyAccessToken behaves exactly
 * as in production (no mocking of the crypto path).
 */

const SECRET = process.env.JWT_SECRET!;

/** Sign a real HS256 access token (optionally already expired). */
function signToken(sub: string, expiresIn: string | number = '15m'): string {
  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: expiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign({ sub }, SECRET, options);
}

/**
 * Load a fresh ws.handshake module bound to the given CORS allowlist + env.
 *
 * @param origins Comma-separated CORS allowlist for this test.
 * @param nodeEnv NODE_ENV to drive config.isProduction.
 */
async function loadHandshake(origins: string, nodeEnv: 'test' | 'production' = 'test') {
  vi.resetModules();
  process.env.CORS_ORIGINS = origins;
  process.env.NODE_ENV = nodeEnv;
  return import('./ws.handshake');
}

afterEach(() => {
  vi.resetModules();
  process.env.CORS_ORIGINS = '';
  process.env.NODE_ENV = 'test';
});

describe('extractToken (R4 — subprotocol preferred, query fallback)', () => {
  it('should_extract_token_from_subprotocol_and_echo_it', async () => {
    const { extractToken } = await loadHandshake('');

    const result = extractToken('access_token.abc.def.ghi', undefined);

    expect(result.token).toBe('abc.def.ghi');
    expect(result.subprotocol).toBe('access_token.abc.def.ghi');
  });

  it('should_pick_the_access_token_subprotocol_among_several', async () => {
    const { extractToken } = await loadHandshake('');

    const result = extractToken('chat, access_token.jwt123 , other', undefined);

    expect(result.token).toBe('jwt123');
    expect(result.subprotocol).toBe('access_token.jwt123');
  });

  it('should_fall_back_to_query_token_when_no_subprotocol', async () => {
    const { extractToken } = await loadHandshake('');

    const result = extractToken(undefined, 'querytoken');

    expect(result.token).toBe('querytoken');
    expect(result.subprotocol).toBeUndefined();
  });

  it('should_prefer_subprotocol_over_query_token', async () => {
    const { extractToken } = await loadHandshake('');

    const result = extractToken('access_token.sub', 'query');

    expect(result.token).toBe('sub');
  });

  it('should_fall_back_to_query_when_subprotocol_lacks_access_token_prefix', async () => {
    const { extractToken } = await loadHandshake('');

    const result = extractToken('chat, json', 'query');

    expect(result.token).toBe('query');
  });

  it('should_return_empty_when_neither_present', async () => {
    const { extractToken } = await loadHandshake('');

    expect(extractToken(undefined, undefined)).toEqual({});
  });

  it('should_treat_empty_query_token_as_absent', async () => {
    const { extractToken } = await loadHandshake('');

    expect(extractToken(undefined, '')).toEqual({});
  });
});

describe('isOriginAllowed (R3 / ADR-027 — fail closed in prod)', () => {
  it('should_skip_check_with_empty_allowlist_in_non_production', async () => {
    const { isOriginAllowed } = await loadHandshake('', 'test');

    expect(isOriginAllowed('https://evil.example', undefined)).toBe(true);
  });

  it('should_fail_closed_with_empty_allowlist_in_production', async () => {
    // The WS-only deviation from csrfOriginGuard's skip-on-empty (CSWSH hole).
    const { isOriginAllowed } = await loadHandshake('', 'production');

    expect(isOriginAllowed('https://anything.example', undefined)).toBe(false);
  });

  it('should_allow_an_allowlisted_origin', async () => {
    const { isOriginAllowed } = await loadHandshake('https://app.example', 'production');

    expect(isOriginAllowed('https://app.example', undefined)).toBe(true);
  });

  it('should_reject_a_non_allowlisted_origin', async () => {
    const { isOriginAllowed } = await loadHandshake('https://app.example', 'production');

    expect(isOriginAllowed('https://evil.example', undefined)).toBe(false);
  });

  it('should_derive_origin_from_referer_when_origin_absent', async () => {
    const { isOriginAllowed } = await loadHandshake('https://app.example', 'production');

    expect(isOriginAllowed(undefined, 'https://app.example/page')).toBe(true);
  });

  it('should_reject_missing_origin_and_referer_when_allowlist_set', async () => {
    const { isOriginAllowed } = await loadHandshake('https://app.example', 'production');

    expect(isOriginAllowed(undefined, undefined)).toBe(false);
  });
});

describe('authenticateHandshake (R1/R2/R3)', () => {
  it('should_succeed_with_a_valid_subprotocol_token', async () => {
    const { authenticateHandshake } = await loadHandshake('', 'test');
    const token = signToken('user-1');

    const result = authenticateHandshake({
      origin: undefined,
      referer: undefined,
      subprotocolHeader: `access_token.${token}`,
      queryToken: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-1');
      expect(result.subprotocol).toBe(`access_token.${token}`);
    }
  });

  it('should_succeed_with_a_valid_query_token', async () => {
    const { authenticateHandshake } = await loadHandshake('', 'test');
    const token = signToken('user-2');

    const result = authenticateHandshake({
      origin: undefined,
      referer: undefined,
      subprotocolHeader: undefined,
      queryToken: token,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-2');
    }
  });

  it('should_reject_with_origin_reason_when_origin_disallowed', async () => {
    // Origin is checked FIRST, before token extraction.
    const { authenticateHandshake } = await loadHandshake('https://app.example', 'production');
    const token = signToken('user-1');

    const result = authenticateHandshake({
      origin: 'https://evil.example',
      referer: undefined,
      subprotocolHeader: `access_token.${token}`,
      queryToken: undefined,
    });

    expect(result).toEqual({ ok: false, reason: 'origin' });
  });

  it('should_reject_with_auth_reason_when_token_missing', async () => {
    const { authenticateHandshake } = await loadHandshake('', 'test');

    const result = authenticateHandshake({
      origin: undefined,
      referer: undefined,
      subprotocolHeader: undefined,
      queryToken: undefined,
    });

    expect(result).toEqual({ ok: false, reason: 'auth' });
  });

  it('should_reject_with_auth_reason_when_token_invalid', async () => {
    const { authenticateHandshake } = await loadHandshake('', 'test');

    const result = authenticateHandshake({
      origin: undefined,
      referer: undefined,
      subprotocolHeader: undefined,
      queryToken: 'not-a-real-jwt',
    });

    expect(result).toEqual({ ok: false, reason: 'auth' });
  });

  it('should_reject_an_expired_token', async () => {
    const { authenticateHandshake } = await loadHandshake('', 'test');
    const expired = signToken('user-1', -10); // expired 10s ago

    const result = authenticateHandshake({
      origin: undefined,
      referer: undefined,
      subprotocolHeader: undefined,
      queryToken: expired,
    });

    expect(result).toEqual({ ok: false, reason: 'auth' });
  });
});

describe('msUntilExpiry (R18)', () => {
  it('should_return_positive_ms_for_a_future_expiry', async () => {
    const { msUntilExpiry } = await loadHandshake('', 'test');
    const payload = { sub: 'u', role: UserRole.USER, iat: 1000, exp: 2000 };

    // exp 2000s, now 1500s -> 500_000 ms.
    expect(msUntilExpiry(payload, 1_500_000)).toBe(500_000);
  });

  it('should_floor_at_zero_for_an_already_expired_token', async () => {
    const { msUntilExpiry } = await loadHandshake('', 'test');
    const payload = { sub: 'u', role: UserRole.USER, iat: 1000, exp: 1500 };

    expect(msUntilExpiry(payload, 2_000_000)).toBe(0);
  });
});
