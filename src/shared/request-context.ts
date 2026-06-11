import { FastifyRequest } from 'fastify';
import { RequestContext } from './audit-sink';

/** Maximum stored User-Agent length (security S3 — opaque, capped). */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * Extract server-derived audit provenance from a request (ADR-049, security
 * S2/S3/F3). This is the SINGLE, consistent provenance extractor so no call
 * site can accidentally trust client input:
 *  - `actorId` is the verified JWT `sub` (`request.authContext.userId`) set by
 *    `authGuard`, or null on an unauthenticated route — NEVER a body field.
 *  - `ip` is Fastify `request.ip`, which honours the app's
 *    `trustProxy: config.isProduction` (app.ts): behind the prod proxy it is the
 *    real client, locally it is the socket IP. We do NOT hand-parse
 *    `x-forwarded-for` (spoofable when trustProxy is off).
 *  - `userAgent` is the raw `User-Agent` header, length-capped and stored
 *    opaque (data, never interpolated/executed).
 *
 * Lives in `shared/` and is called from the ROUTE layer (which already owns
 * Fastify); the resulting POJO is what gets passed down to the sink, so the
 * service layer stays Fastify-free (ADR-010 rule #2).
 *
 * @param request The incoming Fastify request (post-authGuard on protected routes).
 * @returns The server-derived `{ actorId, ip, userAgent }` provenance.
 */
export function requestContext(request: FastifyRequest): RequestContext {
  const userAgentHeader = request.headers['user-agent'];
  const userAgent =
    typeof userAgentHeader === 'string' && userAgentHeader.length > 0
      ? userAgentHeader.slice(0, MAX_USER_AGENT_LENGTH)
      : null;
  return {
    actorId: request.authContext?.userId ?? null,
    ip: request.ip ?? null,
    userAgent,
  };
}
