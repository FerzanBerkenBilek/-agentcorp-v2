import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskEvent } from '../shared/task-events';
import { TaskResponse } from '../shared/task-serializer';
import { ConnectionHub, MAX_CONNECTIONS_PER_USER } from './connection-hub';
import { WS_CLOSE, WS_CLOSE_REASON } from './ws.close-codes';
import { Connection } from './ws.protocol';

/**
 * Unit tests for the ConnectionHub — the registry, the per-user cap (R6), the
 * IDOR fan-out choke point (R13), subscribe own-feed-only (R10), deterministic
 * cleanup (R8/R11/R17), and the heartbeat reaper (R9).
 *
 * The hub names NO Fastify/`ws` type (operates on the structural `Connection`),
 * so it is driven here by a fully synchronous stub socket that records `send`
 * and `close` calls. No timers, no network, no randomness — zero flake surface.
 */

const OWNER_ID = 'owner-1';
const ASSIGNEE_ID = 'assignee-1';
const STRANGER_ID = 'stranger-1';

/** A stub Connection that records sent payloads and close calls. */
interface StubConnection extends Connection {
  sent: string[];
  closed: Array<{ code: number; reason?: string }>;
}

/** Build a subscribed-by-default stub connection for a user. */
function makeConnection(userId: string, opts: { subscribed?: boolean } = {}): StubConnection {
  const conn: StubConnection = {
    userId,
    isAlive: true,
    subscribed: opts.subscribed ?? true,
    sent: [],
    closed: [],
    send(data: string): void {
      conn.sent.push(data);
    },
    close(code: number, reason?: string): void {
      conn.closed.push({ code, reason });
    },
  };
  return conn;
}

/** Build a task event whose task has the given owner/assignee. */
function taskEvent(
  type: TaskEvent['type'],
  ownerId: string,
  assigneeId: string | null = null,
): TaskEvent {
  const task: TaskResponse = {
    id: 'task-1',
    title: 'T',
    description: null,
    status: 'TODO',
    priority: 'MEDIUM',
    ownerId,
    assigneeId,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
  return { type, task, timestamp: '2026-06-10T00:00:00.000Z' };
}

let hub: ConnectionHub;

beforeEach(() => {
  hub = new ConnectionHub();
});

describe('ConnectionHub.register — per-user cap (R6)', () => {
  it('should_register_up_to_the_cap', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      expect(hub.register(makeConnection(OWNER_ID))).toBe('registered');
    }

    expect(hub.connectionCount(OWNER_ID)).toBe(MAX_CONNECTIONS_PER_USER);
  });

  it('should_reject_the_11th_connection_and_not_add_it', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      hub.register(makeConnection(OWNER_ID));
    }

    expect(hub.register(makeConnection(OWNER_ID))).toBe('cap-exceeded');
    expect(hub.connectionCount(OWNER_ID)).toBe(MAX_CONNECTIONS_PER_USER);
  });

  it('should_cap_per_user_independently', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      hub.register(makeConnection(OWNER_ID));
    }

    // A different user is unaffected by another user's full bucket.
    expect(hub.register(makeConnection(ASSIGNEE_ID))).toBe('registered');
    expect(hub.connectionCount(ASSIGNEE_ID)).toBe(1);
  });
});

describe('ConnectionHub.subscribe / unsubscribe (R10 / ADR-028)', () => {
  it('should_subscribe_to_own_feed_when_no_userId_given', () => {
    const conn = makeConnection(OWNER_ID, { subscribed: false });

    hub.subscribe(conn);

    expect(conn.subscribed).toBe(true);
  });

  it('should_subscribe_when_userId_equals_own_identity', () => {
    const conn = makeConnection(OWNER_ID, { subscribed: false });

    hub.subscribe(conn, OWNER_ID);

    expect(conn.subscribed).toBe(true);
  });

  it('should_deny_cross_user_subscribe_silently', () => {
    // R10: a `userId` naming another identity is ignored — no error, no flag flip.
    const conn = makeConnection(OWNER_ID, { subscribed: false });

    hub.subscribe(conn, STRANGER_ID);

    expect(conn.subscribed).toBe(false);
  });

  it('should_unsubscribe_own_feed', () => {
    const conn = makeConnection(OWNER_ID, { subscribed: true });

    hub.unsubscribe(conn);

    expect(conn.subscribed).toBe(false);
  });

  it('should_unsubscribe_when_userId_equals_own_identity', () => {
    const conn = makeConnection(OWNER_ID, { subscribed: true });

    hub.unsubscribe(conn, OWNER_ID);

    expect(conn.subscribed).toBe(false);
  });

  it('should_ignore_cross_user_unsubscribe_silently', () => {
    const conn = makeConnection(OWNER_ID, { subscribed: true });

    hub.unsubscribe(conn, STRANGER_ID);

    expect(conn.subscribed).toBe(true);
  });
});

describe('ConnectionHub.publish — fan-out IDOR choke point (R13)', () => {
  it('should_deliver_to_subscribed_owner', () => {
    const owner = makeConnection(OWNER_ID);
    hub.register(owner);

    hub.publish(taskEvent('task.created', OWNER_ID));

    expect(owner.sent).toHaveLength(1);
    expect(JSON.parse(owner.sent[0])).toMatchObject({
      type: 'task.created',
      task: { ownerId: OWNER_ID },
    });
  });

  it('should_deliver_to_owner_and_assignee_but_not_stranger', () => {
    const owner = makeConnection(OWNER_ID);
    const assignee = makeConnection(ASSIGNEE_ID);
    const stranger = makeConnection(STRANGER_ID);
    hub.register(owner);
    hub.register(assignee);
    hub.register(stranger);

    hub.publish(taskEvent('task.updated', OWNER_ID, ASSIGNEE_ID));

    expect(owner.sent).toHaveLength(1);
    expect(assignee.sent).toHaveLength(1);
    // R13: a stranger (neither owner nor assignee) receives nothing.
    expect(stranger.sent).toHaveLength(0);
  });

  it('should_not_deliver_to_unsubscribed_authorized_socket', () => {
    const owner = makeConnection(OWNER_ID, { subscribed: false });
    hub.register(owner);

    hub.publish(taskEvent('task.created', OWNER_ID));

    expect(owner.sent).toHaveLength(0);
  });

  it('should_fan_out_to_all_of_a_users_connections', () => {
    const a = makeConnection(OWNER_ID);
    const b = makeConnection(OWNER_ID);
    hub.register(a);
    hub.register(b);

    hub.publish(taskEvent('task.created', OWNER_ID));

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('should_send_only_once_when_owner_equals_assignee', () => {
    // candidateRecipients de-dupes owner===assignee so no double delivery.
    const owner = makeConnection(OWNER_ID);
    hub.register(owner);

    hub.publish(taskEvent('task.updated', OWNER_ID, OWNER_ID));

    expect(owner.sent).toHaveLength(1);
  });

  it('should_authorize_task_deleted_against_the_passed_snapshot_R15', () => {
    // R15: the deleted row is gone from the DB; authz runs on the event snapshot.
    const owner = makeConnection(OWNER_ID);
    const assignee = makeConnection(ASSIGNEE_ID);
    hub.register(owner);
    hub.register(assignee);

    hub.publish(taskEvent('task.deleted', OWNER_ID, ASSIGNEE_ID));

    expect(owner.sent).toHaveLength(1);
    expect(assignee.sent).toHaveLength(1);
    expect(JSON.parse(owner.sent[0]).type).toBe('task.deleted');
  });

  it('should_deliver_nothing_when_no_one_is_connected', () => {
    // Candidate has no live connections — sendToUser short-circuits cleanly.
    expect(() => hub.publish(taskEvent('task.created', OWNER_ID))).not.toThrow();
  });

  it('should_drop_only_the_failing_socket_when_send_throws', () => {
    // R8: a throwing send drops just that socket; siblings still receive.
    const healthy = makeConnection(OWNER_ID);
    const broken = makeConnection(OWNER_ID);
    broken.send = (): void => {
      throw new Error('socket gone');
    };
    hub.register(healthy);
    hub.register(broken);

    hub.publish(taskEvent('task.created', OWNER_ID));

    expect(healthy.sent).toHaveLength(1);
    // The broken socket was dropped, leaving only the healthy one registered.
    expect(hub.connectionCount(OWNER_ID)).toBe(1);
  });
});

describe('ConnectionHub.drop — cleanup (R8/R11/R17)', () => {
  it('should_remove_the_socket_and_delete_the_empty_user_key', () => {
    const conn = makeConnection(OWNER_ID);
    hub.register(conn);

    hub.drop(conn);

    expect(hub.connectionCount(OWNER_ID)).toBe(0);
  });

  it('should_be_idempotent_when_called_twice', () => {
    const conn = makeConnection(OWNER_ID);
    hub.register(conn);

    hub.drop(conn);
    expect(() => hub.drop(conn)).not.toThrow();
    expect(hub.connectionCount(OWNER_ID)).toBe(0);
  });

  it('should_no_op_when_dropping_an_unregistered_socket', () => {
    const conn = makeConnection(OWNER_ID);

    expect(() => hub.drop(conn)).not.toThrow();
  });

  it('should_keep_the_user_key_while_another_connection_remains', () => {
    const a = makeConnection(OWNER_ID);
    const b = makeConnection(OWNER_ID);
    hub.register(a);
    hub.register(b);

    hub.drop(a);

    expect(hub.connectionCount(OWNER_ID)).toBe(1);
  });
});

describe('ConnectionHub.heartbeatTick — reaper (R9)', () => {
  it('should_close_and_drop_a_socket_that_missed_the_pong', () => {
    const dead = makeConnection(OWNER_ID);
    dead.isAlive = false;
    hub.register(dead);
    const ping = vi.fn();

    hub.heartbeatTick(ping);

    expect(dead.closed).toEqual([{ code: WS_CLOSE.POLICY_VIOLATION, reason: WS_CLOSE_REASON }]);
    expect(hub.connectionCount(OWNER_ID)).toBe(0);
    expect(ping).not.toHaveBeenCalledWith(dead);
  });

  it('should_mark_survivors_not_alive_and_ping_them', () => {
    const alive = makeConnection(OWNER_ID);
    alive.isAlive = true;
    hub.register(alive);
    const ping = vi.fn();

    hub.heartbeatTick(ping);

    // The survivor is pinged and flipped to not-alive until its next pong.
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith(alive);
    expect(alive.isAlive).toBe(false);
    expect(hub.connectionCount(OWNER_ID)).toBe(1);
  });

  it('should_reap_a_socket_across_two_ticks_without_a_pong', () => {
    const conn = makeConnection(OWNER_ID);
    hub.register(conn);
    const ping = vi.fn();

    hub.heartbeatTick(ping); // marks not-alive + pings
    hub.heartbeatTick(ping); // still not-alive (no pong) -> reaped

    expect(conn.closed).toHaveLength(1);
    expect(hub.connectionCount(OWNER_ID)).toBe(0);
  });
});

describe('ConnectionHub.connectionCount', () => {
  it('should_return_zero_for_an_unknown_user', () => {
    expect(hub.connectionCount('nobody')).toBe(0);
  });
});
