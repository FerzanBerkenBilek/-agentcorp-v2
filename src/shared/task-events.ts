import { TaskResponse } from './task-serializer';

/**
 * The task -> WebSocket emission seam (ADR-025).
 *
 * This is a PURE-TYPES port plus one no-op constant. It imports nothing from
 * `src/ws/`, `src/tasks/`, or Fastify, so `TasksService` can depend on it
 * DOWNWARD (ADR-010 rule: services never import Fastify/transport types). The
 * concrete implementation is `ConnectionHub` (in `src/ws/`), injected at the
 * composition root (`app.ts`). With the no-op default, the tasks module and all
 * existing tests run unaffected when WebSockets are disabled / not wired.
 */

/** The three task lifecycle events pushed over WebSocket. */
export type TaskEventType = 'task.created' | 'task.updated' | 'task.deleted';

/**
 * The server-authoritative event envelope delivered to authorized sockets.
 * `task` carries the SAME wire shape as the REST response (no extra/internal
 * columns — R14); `timestamp` is ISO8601.
 */
export interface TaskEvent {
  type: TaskEventType;
  task: TaskResponse;
  timestamp: string;
}

/**
 * The emission port. `publish` is fire-and-forget (returns void): the REST
 * write path never blocks on or depends on client delivery.
 */
export interface TaskEventPublisher {
  /**
   * Emit a task event to all authorized live subscribers.
   *
   * @param event The task event envelope.
   * @returns void
   */
  publish(event: TaskEvent): void;
}

/**
 * The default publisher: does nothing. Injected into `TasksService` when no hub
 * is wired (unit tests, WS-disabled runs) so emission is a safe no-op.
 */
export const NOOP_PUBLISHER: TaskEventPublisher = {
  publish(): void {
    /* intentional no-op — real-time disabled */
  },
};
