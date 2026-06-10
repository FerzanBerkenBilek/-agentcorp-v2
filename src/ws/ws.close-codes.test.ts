import { describe, expect, it } from 'vitest';
import { WS_CLOSE, WS_CLOSE_REASON } from './ws.close-codes';

/**
 * Unit tests pinning the RFC 6455 close-code convention (security-engineer's
 * close-code table + R19 generic reason). These are a contract: the integration
 * suite asserts the same numeric codes on the wire, so a drift here would be a
 * security regression (e.g. leaking a specific reason or a wrong code).
 */
describe('ws.close-codes', () => {
  it('should_map_each_condition_to_the_rfc6455_code', () => {
    expect(WS_CLOSE.NORMAL).toBe(1000);
    expect(WS_CLOSE.POLICY_VIOLATION).toBe(1008);
    expect(WS_CLOSE.MESSAGE_TOO_BIG).toBe(1009);
    expect(WS_CLOSE.TRY_AGAIN_LATER).toBe(1013);
  });

  it('should_use_a_single_generic_close_reason_R19', () => {
    // R19: never reveal resource existence/internal state in the close reason.
    expect(WS_CLOSE_REASON).toBe('policy violation');
  });
});
