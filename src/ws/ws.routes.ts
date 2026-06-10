import fastifyWebsocket, { WebSocket as WsSocket } from '@fastify/websocket';
import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { audit, AUDIT_ACTION } from '../shared/audit';
import { ConnectionHub } from './connection-hub';
import { authenticateHandshake, msUntilExpiry } from './ws.handshake';
import { WS_CLOSE, WS_CLOSE_REASON } from './ws.close-codes';
import {
  clientFrameSchema,
  Connection,
  FRAME_RATE_WINDOW_MS,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_WINDOW,
} from './ws.protocol';

/** Dependencies injected into the WS routes plugin (ADR-025 — one shared hub). */
export interface WsRoutesDeps {
  hub: ConnectionHub;
}

/** Heartbeat interval in ms (R9): ping every 30s; a socket that missed the prior pong is reaped. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The token query-param key. The raw value is NEVER logged (ADR-026 / R4): this
 * plugin emits only `audit()` lines keyed by `userId`, and we replace the
 * request log serializer below so a `?token=` URL cannot reach the logger.
 */
const TOKEN_QUERY_KEY = 'token';

/** Internal per-connection state the hub does not own (rate-limit bookkeeping, socket handle). */
interface WsConnectionState extends Connection {
  socket: WsSocket;
  windowStart: number;
  framesInWindow: number;
}

/**
 * WebSocket route plugin (ADR-025) — the ONLY file that imports
 * `@fastify/websocket`/`ws`. It is a thin transport adapter: it runs the JWT +
 * Origin handshake (R1-R4), enforces the per-user cap via the hub (R6), routes
 * Zod-validated inbound frames to the hub (R5/R7/R10/R16), runs the heartbeat
 * reaper (R9), schedules a token-expiry close (R18), and cleans up on
 * close/error (R8/R17). All authz/fan-out logic lives in the hub/policy.
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (the shared connection hub).
 * @returns A promise that resolves once the WS route is registered.
 */
export const wsRoutes: FastifyPluginAsync<WsRoutesDeps> = async (
  app: FastifyInstance,
  deps: WsRoutesDeps,
): Promise<void> => {
  const { hub } = deps;
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_FRAME_BYTES } });

  // R4: scrub the token query-param from the request log serializer so a
  // `?token=<jwt>` upgrade URL never reaches the logger (CWE-532 / ADR-026).
  redactTokenFromRequestLog(app);

  // R9: a single heartbeat timer drives the reaper for all connections; it must
  // not keep the process alive (unref) and is cleared on server close (R17).
  const heartbeat = setInterval(() => {
    hub.heartbeatTick((c) => (c as WsConnectionState).socket.ping());
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  app.addHook('onClose', async () => clearInterval(heartbeat));

  app.get('/ws', { websocket: true }, (socket: WsSocket, request: FastifyRequest) => {
    const result = authenticateHandshake({
      origin: request.headers.origin,
      referer: request.headers.referer,
      subprotocolHeader: request.headers['sec-websocket-protocol'],
      queryToken: readTokenQuery(request),
    });

    if (!result.ok) {
      // R2/R3/R19: close (never an HTTP body); generic reason; audit the failure.
      audit(request.log, AUDIT_ACTION.WS_AUTH_FAILURE, { actorId: null, outcome: 'failure' });
      socket.close(WS_CLOSE.POLICY_VIOLATION, WS_CLOSE_REASON);
      return;
    }

    const userId = result.payload.sub;
    const connection = buildConnection(socket, userId);

    // R6: enforce the per-user cap AT handshake, before registering.
    if (hub.register(connection) === 'cap-exceeded') {
      audit(request.log, AUDIT_ACTION.WS_CAP_EXCEEDED, { actorId: userId, outcome: 'failure' });
      socket.close(WS_CLOSE.TRY_AGAIN_LATER, WS_CLOSE_REASON);
      return;
    }

    // RFC 6455 subprotocol echo (ADR-026): when the token arrives via the
    // `access_token.<jwt>` subprotocol, the `ws` server selects and echoes it
    // automatically from the client's offer during the upgrade handshake — no
    // explicit echo is needed here. The query-param transport offers none.
    audit(request.log, AUDIT_ACTION.WS_CONNECT, { actorId: userId, outcome: 'success' });

    wireConnection({ socket, connection, hub, log: request.log });
    scheduleExpiryClose(socket, msUntilExpiry(result.payload), request, userId);
  });
};

/**
 * Build the hub-facing connection view over a raw socket. The hub operates on
 * the structural {@link Connection}; the extra fields support rate-limiting and
 * pinging without the hub knowing the socket type.
 *
 * @param socket The raw WebSocket.
 * @param userId The authenticated user id (pinned, R1).
 * @returns The connection state.
 */
function buildConnection(socket: WsSocket, userId: string): WsConnectionState {
  return {
    userId,
    isAlive: true,
    subscribed: false,
    socket,
    windowStart: Date.now(),
    framesInWindow: 0,
    send: (data: string): void => socket.send(data),
    close: (code: number, reason?: string): void => socket.close(code, reason),
  };
}

/**
 * Attach the socket event handlers: pong (liveness), message (frame routing),
 * and close/error (deterministic cleanup — R8/R17).
 *
 * @param ctx The socket, its connection view, the hub, and the request logger.
 * @returns void
 */
function wireConnection(ctx: {
  socket: WsSocket;
  connection: WsConnectionState;
  hub: ConnectionHub;
  log: FastifyRequest['log'];
}): void {
  const { socket, connection, hub, log } = ctx;

  socket.on('pong', () => {
    connection.isAlive = true; // R9: client answered the heartbeat
  });

  socket.on('message', (raw: Buffer) => {
    handleFrame({ raw, connection, hub, log });
  });

  // R8/R17: cleanup is idempotent and runs on BOTH close and error.
  socket.on('close', () => hub.drop(connection));
  socket.on('error', () => {
    hub.drop(connection);
    socket.close(WS_CLOSE.POLICY_VIOLATION, WS_CLOSE_REASON);
  });
}

/**
 * Validate and route one inbound frame (R5/R7/R10/R16). Enforces the size cap
 * and per-connection message-rate cap, Zod-parses the frame, and dispatches to
 * the hub. Any violation closes the socket with a generic reason (R19).
 *
 * @param ctx The raw frame, its connection, the hub, and the logger.
 * @returns void
 */
function handleFrame(ctx: {
  raw: Buffer;
  connection: WsConnectionState;
  hub: ConnectionHub;
  log: FastifyRequest['log'];
}): void {
  const { raw, connection, hub, log } = ctx;

  if (raw.byteLength > MAX_FRAME_BYTES) {
    connection.close(WS_CLOSE.MESSAGE_TOO_BIG, WS_CLOSE_REASON); // R7
    hub.drop(connection);
    return;
  }
  if (exceedsRate(connection)) {
    audit(log, AUDIT_ACTION.WS_FRAME_ABUSE, { actorId: connection.userId, outcome: 'failure' });
    connection.close(WS_CLOSE.POLICY_VIOLATION, WS_CLOSE_REASON); // R7
    hub.drop(connection);
    return;
  }

  const parsed = safeParseJson(raw);
  const frame = parsed === undefined ? undefined : clientFrameSchema.safeParse(parsed);
  if (!frame || !frame.success) {
    // R5/R16: malformed, unknown-type, or mutation frame — ignore silently
    // (generic; no error frame that confirms internal state, R19).
    return;
  }

  if (frame.data.type === 'subscribe') {
    hub.subscribe(connection, frame.data.userId); // R10
  } else {
    hub.unsubscribe(connection, frame.data.userId);
  }
}

/**
 * Count this frame against the per-connection rate window (R7). Resets the
 * window when it elapses.
 *
 * @param connection The connection bookkeeping its own rate.
 * @returns True iff the connection has exceeded the allowed frame rate.
 */
function exceedsRate(connection: WsConnectionState): boolean {
  const now = Date.now();
  if (now - connection.windowStart > FRAME_RATE_WINDOW_MS) {
    connection.windowStart = now;
    connection.framesInWindow = 0;
  }
  connection.framesInWindow += 1;
  return connection.framesInWindow > MAX_FRAMES_PER_WINDOW;
}

/**
 * Parse a frame buffer as JSON, returning undefined on any error (R5 — never
 * let `JSON.parse` throw on an unbounded/garbage buffer).
 *
 * @param raw The raw frame.
 * @returns The parsed value, or undefined if not valid JSON.
 */
function safeParseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Schedule a forced close at token expiry (R18) so a live socket never outlives
 * its access token. The timer is cleared if the socket closes first; it does
 * not keep the process alive.
 *
 * @param socket The raw socket.
 * @param delayMs Milliseconds until `exp`.
 * @param request The request (for audit logging).
 * @param userId The authenticated user id.
 * @returns void
 */
function scheduleExpiryClose(
  socket: WsSocket,
  delayMs: number,
  request: FastifyRequest,
  userId: string,
): void {
  const timer = setTimeout(() => {
    audit(request.log, AUDIT_ACTION.WS_TOKEN_EXPIRED, { actorId: userId, outcome: 'success' });
    socket.close(WS_CLOSE.POLICY_VIOLATION, WS_CLOSE_REASON);
  }, delayMs);
  timer.unref();
  socket.on('close', () => clearTimeout(timer));
}

/**
 * Read the `token` query param off the request without logging it. Fastify has
 * already parsed the querystring; we touch only the single field.
 *
 * @param request The upgrade request.
 * @returns The token string, or undefined.
 */
function readTokenQuery(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[TOKEN_QUERY_KEY];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Replace the request-log URL serializer so a `?token=<jwt>` upgrade URL is
 * redacted before it reaches Pino (R4 / ADR-026 — CWE-532). Applies to this
 * encapsulated plugin scope only.
 *
 * @param app The (child) Fastify instance for the WS plugin.
 * @returns void
 */
function redactTokenFromRequestLog(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (typeof request.raw.url === 'string' && request.raw.url.includes(`${TOKEN_QUERY_KEY}=`)) {
      // Strip the querystring entirely from the logged URL; routing still uses
      // the parsed `request.query`, so functionality is unaffected.
      request.raw.url = request.raw.url.split('?')[0];
    }
  });
}
