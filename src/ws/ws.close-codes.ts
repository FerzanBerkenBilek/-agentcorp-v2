/**
 * RFC 6455 WebSocket close codes used across the WS module (security-engineer's
 * close-code convention; no magic numbers at call sites). Reasons are kept
 * GENERIC (R19): a close frame never reveals resource existence or internal
 * state.
 */
export const WS_CLOSE = {
  /** Normal client disconnect. */
  NORMAL: 1000,
  /**
   * Policy violation — used for ALL security rejections (auth failure, Origin
   * not allowlisted, frame abuse, token expiry). Generic on purpose (R19).
   */
  POLICY_VIOLATION: 1008,
  /** Message too large (oversized inbound frame, R7). */
  MESSAGE_TOO_BIG: 1009,
  /** Try again later — per-user connection cap exceeded (R6). */
  TRY_AGAIN_LATER: 1013,
} as const;

/** Generic, non-revealing close reason (R19). */
export const WS_CLOSE_REASON = 'policy violation';
