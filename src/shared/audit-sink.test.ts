import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, AuditFields } from './audit';
import { NOOP_AUDIT_SINK, RequestContext } from './audit-sink';

/**
 * Unit tests for the NOOP_AUDIT_SINK default (ADR-049). The no-op sink is what
 * keeps the 558 existing tests green: route plugins get it unless app.ts wires
 * the real AuditService, so emission must be a safe, side-effect-free no-op that
 * returns void and never throws — even with adversarial inputs.
 */

const CTX: RequestContext = {
  actorId: '11111111-1111-1111-1111-111111111111',
  ip: '203.0.113.7',
  userAgent: 'vitest/1.0',
};

const FIELDS: AuditFields = { actorId: CTX.actorId, outcome: 'success' };

describe('NOOP_AUDIT_SINK.record', () => {
  it('should_return_undefined_and_not_throw_for_a_normal_call', () => {
    expect(NOOP_AUDIT_SINK.record(AUDIT_ACTION.LOGIN, CTX, FIELDS)).toBeUndefined();
  });

  it('should_be_a_no_op_with_a_null_actor_context', () => {
    const anon: RequestContext = { actorId: null, ip: null, userAgent: null };
    expect(() =>
      NOOP_AUDIT_SINK.record(AUDIT_ACTION.OAUTH_START, anon, { actorId: null, outcome: 'failure' }),
    ).not.toThrow();
  });

  it('should_remain_callable_repeatedly_without_accumulating_state', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(NOOP_AUDIT_SINK.record(AUDIT_ACTION.TASK_CREATE, CTX, FIELDS)).toBeUndefined();
    }
  });
});
