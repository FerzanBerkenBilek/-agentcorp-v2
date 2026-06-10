import { z } from 'zod';

/**
 * WebSocket wire protocol: inbound client frame schemas + the structural
 * `Connection` abstraction the hub depends on (ADR-025 / security R5, R7, R10).
 *
 * Frames are validated with Zod `.strict()` (R5/R7: unknown keys — including
 * `__proto__`/`constructor`/`prototype` pollution attempts — are rejected; the
 * `type` enum is closed). The `Connection` interface is a tiny structural type
 * that the real `@fastify/websocket` socket satisfies, so `connection-hub.ts`
 * never names a Fastify/`ws` type and stays unit-testable with a fake socket.
 */

/**
 * Max inbound frame size in bytes (R7). Subscribe/unsubscribe frames are tiny;
 * 8 KB is far below the 1 MB HTTP body limit and bounds memory/parse cost.
 */
export const MAX_FRAME_BYTES = 8 * 1024;

/**
 * Max inbound messages per connection inside the rate window (R7). Sustained
 * abuse beyond this closes the socket.
 */
export const MAX_FRAMES_PER_WINDOW = 20;

/** Inbound message-rate window in milliseconds (R7). */
export const FRAME_RATE_WINDOW_MS = 10_000;

/**
 * Subscribe frame. `userId` is OPTIONAL and, if present, MUST equal the
 * connection's authenticated identity — the hub denies cross-user subscription
 * silently (R10 / ADR-028). It is never trusted to grant visibility; the
 * per-event fan-out predicate is the actual gate.
 */
const subscribeFrameSchema = z
  .object({
    type: z.literal('subscribe'),
    userId: z.string().min(1).optional(),
  })
  .strict();

/** Unsubscribe frame (drops the connection's own feed subscription). */
const unsubscribeFrameSchema = z
  .object({
    type: z.literal('unsubscribe'),
    userId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Any valid inbound client frame. WS is read/subscribe-only (R16): there is no
 * mutation frame; any other `type` fails this closed discriminated union.
 */
export const clientFrameSchema = z.discriminatedUnion('type', [
  subscribeFrameSchema,
  unsubscribeFrameSchema,
]);

/** A validated inbound client frame. */
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/**
 * The minimal socket abstraction the hub operates on (ADR-025). The real
 * `@fastify/websocket` `ws.WebSocket` structurally satisfies `send`/`close`;
 * the hub-owned fields (`userId`, `isAlive`, `subscribed`) are attached by
 * `ws.routes.ts` after a successful handshake. Keeping the hub on this
 * interface means it imports NO Fastify/`ws` type and is testable with a stub.
 */
export interface Connection {
  /** The authenticated user id (JWT `sub`), pinned at handshake (R1). */
  userId: string;
  /** Heartbeat liveness flag, toggled by the ping/pong reaper (R9). */
  isAlive: boolean;
  /** Whether this connection has subscribed to its own feed (R10). */
  subscribed: boolean;
  /**
   * Send a text frame to the client.
   *
   * @param data The serialized frame.
   * @returns void
   */
  send(data: string): void;
  /**
   * Close the socket with an RFC 6455 code and a generic reason (R19).
   *
   * @param code The WS close code.
   * @param reason A short, generic reason string.
   * @returns void
   */
  close(code: number, reason?: string): void;
}
