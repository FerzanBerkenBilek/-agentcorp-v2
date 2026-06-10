import { describe, expect, it } from 'vitest';
import {
  clientFrameSchema,
  FRAME_RATE_WINDOW_MS,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
} from './ws.protocol';

/**
 * Unit tests for the WebSocket wire protocol (security R5/R7/R10/R16).
 *
 * The closed `.strict()` discriminated union is the first line of defence
 * against malformed/oversized/mutation/prototype-pollution frames, so every
 * accept and reject branch is asserted here against the SHIPPED schema.
 */
describe('ws.protocol — clientFrameSchema (R5/R7/R16)', () => {
  it('should_accept_subscribe_frame_without_userId', () => {
    const result = clientFrameSchema.safeParse({ type: 'subscribe' });

    expect(result.success).toBe(true);
  });

  it('should_accept_subscribe_frame_with_matching_userId', () => {
    const result = clientFrameSchema.safeParse({ type: 'subscribe', userId: 'user-1' });

    expect(result.success).toBe(true);
  });

  it('should_accept_unsubscribe_frame', () => {
    const result = clientFrameSchema.safeParse({ type: 'unsubscribe' });

    expect(result.success).toBe(true);
  });

  it('should_reject_unknown_type', () => {
    // R16: there is no mutation/other frame type in the closed union.
    const result = clientFrameSchema.safeParse({ type: 'create-task' });

    expect(result.success).toBe(false);
  });

  it('should_reject_mutation_shaped_frame', () => {
    // R16: WS is read/subscribe-only — a write-shaped frame must not parse.
    const result = clientFrameSchema.safeParse({
      type: 'task.create',
      title: 'evil',
      ownerId: 'attacker',
    });

    expect(result.success).toBe(false);
  });

  it('should_reject_extra_keys_strict_mode', () => {
    // R7: `.strict()` blocks unknown keys, the prototype-pollution vector.
    const result = clientFrameSchema.safeParse({ type: 'subscribe', extra: 'x' });

    expect(result.success).toBe(false);
  });

  it('should_reject_proto_pollution_key', () => {
    // R7: an explicit `__proto__` own-key is an extra key under `.strict()`.
    const frame = JSON.parse('{"type":"subscribe","__proto__":{"polluted":true}}') as unknown;
    const result = clientFrameSchema.safeParse(frame);

    expect(result.success).toBe(false);
  });

  it('should_reject_empty_userId', () => {
    const result = clientFrameSchema.safeParse({ type: 'subscribe', userId: '' });

    expect(result.success).toBe(false);
  });

  it('should_reject_missing_type', () => {
    const result = clientFrameSchema.safeParse({ userId: 'user-1' });

    expect(result.success).toBe(false);
  });

  it('should_reject_non_object_frame', () => {
    expect(clientFrameSchema.safeParse('subscribe').success).toBe(false);
    expect(clientFrameSchema.safeParse(42).success).toBe(false);
    expect(clientFrameSchema.safeParse(null).success).toBe(false);
  });
});

describe('ws.protocol — caps (R7)', () => {
  it('should_pin_frame_size_cap_at_8KB_below_http_body_limit', () => {
    expect(MAX_FRAME_BYTES).toBe(8 * 1024);
  });

  it('should_pin_rate_window_and_count', () => {
    expect(MAX_FRAMES_PER_WINDOW).toBe(20);
    expect(FRAME_RATE_WINDOW_MS).toBe(10_000);
  });
});
