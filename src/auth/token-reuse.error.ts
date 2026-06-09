import { AuthError } from '../shared/errors';

/**
 * Client-facing message for a reuse-detected 401. Intentionally identical to the
 * message a normal unknown/expired refresh token produces in AuthService.refresh
 * ('Invalid refresh token'), so an attacker replaying a consumed token cannot
 * distinguish reuse from any other invalid token by reading the message (P2.3,
 * info-disclosure hardening). The reuse signal lives only in the audit log.
 */
const GENERIC_INVALID_REFRESH_MESSAGE = 'Invalid refresh token';

/**
 * Raised when a consumed refresh token is presented again (assumed theft, H2,
 * ADR-012). Extends AuthError, so the global handler still maps it to a generic
 * 401 — the client learns nothing extra. Its client-facing message is the same
 * generic 'Invalid refresh token' string a normal invalid token returns (P2.3),
 * so reuse is NOT distinguishable from the response. It additionally carries the
 * reuse context (userId/family/jti/timestamp) so the route layer, which owns the
 * request-scoped logger, can emit the TOKEN_REUSE_DETECTED audit event before
 * the response is sanitized. The service stays framework-agnostic (no logger).
 */
export class TokenReuseError extends AuthError {
  /** The owner of the reused token, if it resolved to a known row. */
  public readonly reuseUserId: string | null;
  /** The rotation family that was revoked in response to the reuse. */
  public readonly reuseFamily: string;
  /** The jti of the reused token. */
  public readonly reuseJti: string;
  /** When the reuse was detected. */
  public readonly reuseDetectedAt: Date;

  /**
   * @param context The reuse context surfaced to the audit call.
   */
  constructor(context: { userId: string | null; family: string; jti: string }) {
    // Generic client message (P2.3): identical to a normal invalid refresh token
    // so reuse is indistinguishable to the client. Reuse context below is still
    // preserved for the TOKEN_REUSE_DETECTED audit event.
    super(GENERIC_INVALID_REFRESH_MESSAGE);
    this.name = 'TokenReuseError';
    this.reuseUserId = context.userId;
    this.reuseFamily = context.family;
    this.reuseJti = context.jti;
    this.reuseDetectedAt = new Date();
  }
}
