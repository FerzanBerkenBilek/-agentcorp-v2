import { canAccessTask } from '../tasks/tasks.policy';
import { TaskEvent, TaskEventPublisher } from '../shared/task-events';
import { WS_CLOSE, WS_CLOSE_REASON } from './ws.close-codes';
import { Connection } from './ws.protocol';

/** Max concurrent WebSocket connections per user (R6 / DoS control). */
export const MAX_CONNECTIONS_PER_USER = 10;

/** Outcome of a `register` attempt (the cap is the only rejection reason). */
export type RegisterResult = 'registered' | 'cap-exceeded';

/**
 * In-process WebSocket connection registry, fan-out point, and the SINGLE
 * object-level-authz choke point on the push channel (ADR-025 / ADR-028).
 *
 * Implements `TaskEventPublisher`: `app.ts` injects this same instance into
 * both `TasksService` (as the publisher) and `ws.routes.ts` (as the registry).
 *
 * Security invariants enforced here:
 *  - R6: at most {@link MAX_CONNECTIONS_PER_USER} sockets per user, checked in
 *    `register()` — the single place the cap lives.
 *  - R13: fan-out delivers a task event to a recipient ONLY if
 *    `canAccessTask(task, userId)` (owner OR assignee) — reused from
 *    `tasks.policy`, never re-implemented. Recipients are restricted to the
 *    task's `ownerId`/`assigneeId` (no global broadcast).
 *  - R8/R11/R17: `drop()` removes the socket and deletes the empty user key, so
 *    the registry cannot leak slots or memory.
 *
 * It names NO Fastify/`ws`/Prisma type (operates on the structural
 * {@link Connection}), so it is unit-testable with a stub socket.
 */
export class ConnectionHub implements TaskEventPublisher {
  private readonly connections = new Map<string, Set<Connection>>();

  /**
   * Register an authenticated connection, enforcing the per-user cap (R6). The
   * cap is checked BEFORE inserting, so the 11th concurrent socket is never
   * added to the registry.
   *
   * @param connection The authenticated connection (its `userId` is pinned).
   * @returns `'registered'` on success, or `'cap-exceeded'` if the user is at
   *   the cap (caller closes the socket with {@link WS_CLOSE.TRY_AGAIN_LATER}).
   */
  register(connection: Connection): RegisterResult {
    const existing = this.connections.get(connection.userId);
    if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
      return 'cap-exceeded';
    }
    if (existing) {
      existing.add(connection);
    } else {
      this.connections.set(connection.userId, new Set([connection]));
    }
    return 'registered';
  }

  /**
   * Mark a connection as subscribed to its OWN feed (R10). A `userId` in the
   * frame that does not match the connection's authenticated identity is
   * cross-user subscription and is DENIED SILENTLY — the subscription state is
   * left unchanged and no error is surfaced (no existence leak).
   *
   * @param connection The authenticated connection.
   * @param requestedUserId Optional target from the frame; must equal the
   *   connection's own id to be honored.
   * @returns void
   */
  subscribe(connection: Connection, requestedUserId?: string): void {
    if (requestedUserId !== undefined && requestedUserId !== connection.userId) {
      return; // cross-user subscribe denied silently (R10 / ADR-028)
    }
    connection.subscribed = true;
  }

  /**
   * Unsubscribe a connection from its feed. Cross-user targets are ignored
   * silently, mirroring {@link subscribe} (R10).
   *
   * @param connection The authenticated connection.
   * @param requestedUserId Optional target from the frame.
   * @returns void
   */
  unsubscribe(connection: Connection, requestedUserId?: string): void {
    if (requestedUserId !== undefined && requestedUserId !== connection.userId) {
      return;
    }
    connection.subscribed = false;
  }

  /**
   * Remove a connection from the registry (R8/R17). Deletes the user's key when
   * its set empties, so the map never retains empty buckets (R11 — no leak).
   * Idempotent: safe to call on `close` AND `error` for the same socket.
   *
   * @param connection The connection to remove.
   * @returns void
   */
  drop(connection: Connection): void {
    const set = this.connections.get(connection.userId);
    if (!set) {
      return;
    }
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(connection.userId);
    }
  }

  /**
   * Fan out a task event to every authorized, subscribed socket (R13 — the IDOR
   * choke point). Recipients are limited to the task's owner and assignee
   * (never a broadcast); each is delivered ONLY if `canAccessTask` is true and
   * the connection has subscribed. Fire-and-forget per socket: a failing
   * `send` drops that one socket and never blocks the REST write path.
   *
   * @param event The task event envelope.
   * @returns void
   */
  publish(event: TaskEvent): void {
    const payload = JSON.stringify(event);
    const recipientIds = this.candidateRecipients(event);
    for (const userId of recipientIds) {
      if (!canAccessTask(event.task, userId)) {
        continue; // per-recipient authz (R13) — defense in depth over the candidate set
      }
      this.sendToUser(userId, payload);
    }
  }

  /**
   * Drive one heartbeat tick (R9): terminate sockets that did not pong since the
   * last tick (`isAlive === false`), then mark the survivors not-alive and ping
   * them. `ws.routes.ts` sets `isAlive = true` on each `pong`.
   *
   * @param ping Per-socket ping action (the route supplies the real `ws.ping`).
   * @returns void
   */
  heartbeatTick(ping: (connection: Connection) => void): void {
    for (const set of this.connections.values()) {
      for (const connection of [...set]) {
        if (!connection.isAlive) {
          connection.close(WS_CLOSE.POLICY_VIOLATION, WS_CLOSE_REASON);
          this.drop(connection);
          continue;
        }
        connection.isAlive = false;
        ping(connection);
      }
    }
  }

  /**
   * Current live connection count for a user (test/diagnostic seam).
   *
   * @param userId The user id.
   * @returns The number of registered connections (0 if none).
   */
  connectionCount(userId: string): number {
    return this.connections.get(userId)?.size ?? 0;
  }

  /**
   * The candidate recipient user ids for an event: the task's owner and (if
   * set) its assignee. Never the whole registry — bounds fan-out amplification
   * (R13). De-duplicated when owner === assignee.
   *
   * @param event The task event.
   * @returns The unique candidate user ids.
   */
  private candidateRecipients(event: TaskEvent): string[] {
    const { ownerId, assigneeId } = event.task;
    if (assigneeId && assigneeId !== ownerId) {
      return [ownerId, assigneeId];
    }
    return [ownerId];
  }

  /**
   * Send a serialized payload to every subscribed socket of one user. A failing
   * `send` drops that socket (R8) and does not affect the others or the caller.
   *
   * @param userId The recipient user id.
   * @param payload The serialized event frame.
   * @returns void
   */
  private sendToUser(userId: string, payload: string): void {
    const set = this.connections.get(userId);
    if (!set) {
      return;
    }
    for (const connection of [...set]) {
      if (!connection.subscribed) {
        continue;
      }
      try {
        connection.send(payload);
      } catch {
        this.drop(connection);
      }
    }
  }
}
