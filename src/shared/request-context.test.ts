import { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requestContext } from './request-context';

/**
 * Unit tests for the server-derived provenance extractor (ADR-049, security
 * S2/S3/F3). The whole point of this helper is that NO field is ever read from a
 * client-controlled body: actorId is the verified JWT sub on `request.authContext`,
 * ip is Fastify `request.ip` (trustProxy-resolved), and userAgent is the header,
 * length-capped at 512 and stored opaque. These tests pin each rule.
 */

/**
 * Build a minimal FastifyRequest stand-in carrying only the fields the extractor
 * reads. Cast through unknown — the helper touches `authContext`, `ip`, and the
 * `user-agent` header only.
 *
 * @param overrides The authContext / ip / user-agent header to set.
 * @returns A request-shaped object for the extractor.
 */
function fakeRequest(overrides: {
  userId?: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}): FastifyRequest {
  return {
    authContext: overrides.userId !== undefined ? { userId: overrides.userId } : undefined,
    ip: overrides.ip,
    headers: { 'user-agent': overrides.userAgent },
  } as unknown as FastifyRequest;
}

describe('requestContext', () => {
  it('should_take_actorId_from_the_verified_auth_context_not_a_body_field', () => {
    const ctx = requestContext(
      fakeRequest({ userId: 'user-42', ip: '203.0.113.5', userAgent: 'curl/8' }),
    );
    expect(ctx.actorId).toBe('user-42');
  });

  it('should_set_actorId_null_when_the_request_is_unauthenticated', () => {
    const ctx = requestContext(fakeRequest({ ip: '203.0.113.5', userAgent: 'curl/8' }));
    expect(ctx.actorId).toBeNull();
  });

  it('should_take_ip_from_request_ip', () => {
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '198.51.100.9', userAgent: 'ua' }));
    expect(ctx.ip).toBe('198.51.100.9');
  });

  it('should_set_ip_null_when_request_ip_is_absent', () => {
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: undefined, userAgent: 'ua' }));
    expect(ctx.ip).toBeNull();
  });

  it('should_pass_a_short_user_agent_through_unchanged', () => {
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '1.1.1.1', userAgent: 'Mozilla/5.0' }));
    expect(ctx.userAgent).toBe('Mozilla/5.0');
  });

  it('should_cap_the_user_agent_at_512_chars', () => {
    const longUa = 'A'.repeat(600);
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '1.1.1.1', userAgent: longUa }));
    expect(ctx.userAgent).toHaveLength(512);
    expect(ctx.userAgent).toBe('A'.repeat(512));
  });

  it('should_keep_a_user_agent_of_exactly_512_chars_intact', () => {
    const ua = 'B'.repeat(512);
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '1.1.1.1', userAgent: ua }));
    expect(ctx.userAgent).toBe(ua);
  });

  it('should_set_userAgent_null_when_the_header_is_missing', () => {
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '1.1.1.1', userAgent: undefined }));
    expect(ctx.userAgent).toBeNull();
  });

  it('should_set_userAgent_null_for_an_empty_header_string', () => {
    const ctx = requestContext(fakeRequest({ userId: 'u', ip: '1.1.1.1', userAgent: '' }));
    expect(ctx.userAgent).toBeNull();
  });
});
