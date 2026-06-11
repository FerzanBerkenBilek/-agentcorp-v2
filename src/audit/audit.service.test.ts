import { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION, AuditFields } from '../shared/audit';
import { RequestContext } from '../shared/audit-sink';
import { AuditInsert, AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import { AuditQuery } from './audit.schemas';

/**
 * Unit tests for AuditService. Mocks the repository (the layer below) and the
 * app logger. Covers the two halves of the port:
 *  - record(): row build from server-derived ctx + the ADR-046 metadata allowlist
 *    / forbidden-key redaction; and the fire-and-forget guarantee (S5/S8) — it
 *    returns void, never throws, never awaits the INSERT, and logs
 *    AUDIT_WRITE_FAILED (never silently) when the detached INSERT rejects.
 *  - query(): filter passthrough (snake→camel), 1-based→skip/take pagination, and
 *    the row→DTO mapping (only intended fields, S11).
 */

const ACTOR = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

const CTX: RequestContext = { actorId: ACTOR, ip: '203.0.113.4', userAgent: 'ua/1' };

/** A logger stub capturing error() calls (the AUDIT_WRITE_FAILED path). */
function makeLogger(): { logger: FastifyBaseLogger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  const logger = { error } as unknown as FastifyBaseLogger;
  return { logger, error };
}

/** A repository stub with insert + findMany as spies. */
function makeRepo(): {
  repo: AuditRepository;
  insert: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn().mockResolvedValue(undefined);
  const findMany = vi.fn().mockResolvedValue({ rows: [], total: 0 });
  const repo = { insert, findMany } as unknown as AuditRepository;
  return { repo, insert, findMany };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditService.record — row build + provenance', () => {
  it('should_build_the_row_from_server_derived_ctx_and_typed_fields', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    service.record(AUDIT_ACTION.TASK_CREATE, CTX, {
      actorId: ACTOR,
      resourceId: TARGET,
      targetType: 'task',
      outcome: 'success',
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as AuditInsert;
    expect(row.eventType).toBe(AUDIT_ACTION.TASK_CREATE);
    expect(row.actorId).toBe(ACTOR); // from ctx, never from fields
    expect(row.targetId).toBe(TARGET); // resourceId → targetId
    expect(row.targetType).toBe('task');
    expect(row.ipAddress).toBe('203.0.113.4');
    expect(row.userAgent).toBe('ua/1');
  });

  it('should_use_ctx_actorId_even_when_fields_actorId_differs', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    // A caller passes a different (spoofed) actorId in fields; ctx must win.
    service.record(AUDIT_ACTION.LOGIN, CTX, { actorId: 'spoofed-id', outcome: 'success' });

    const row = insert.mock.calls[0][0] as AuditInsert;
    expect(row.actorId).toBe(ACTOR);
  });

  it('should_null_targetId_and_targetType_when_no_resource_is_given', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    service.record(AUDIT_ACTION.LOGOUT, CTX, { actorId: ACTOR, outcome: 'success' });

    const row = insert.mock.calls[0][0] as AuditInsert;
    expect(row.targetId).toBeNull();
    expect(row.targetType).toBeNull();
  });
});

describe('AuditService.record — ADR-046 metadata allowlist + redaction', () => {
  it('should_persist_only_the_allowlisted_non_sensitive_fields', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    service.record(AUDIT_ACTION.TOKEN_REUSE_DETECTED, CTX, {
      actorId: ACTOR,
      outcome: 'failure',
      family: 'fam-1',
      jti: 'jti-9',
      reason: 'reuse',
      count: 3,
    });

    const row = insert.mock.calls[0][0] as AuditInsert;
    expect(row.metadata).toEqual({
      outcome: 'failure',
      family: 'fam-1',
      jti: 'jti-9',
      reason: 'reuse',
      count: 3,
    });
  });

  it('should_drop_a_forbidden_secret_key_that_leaks_into_fields', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    // A careless caller spreads a body carrying secrets onto the typed fields.
    const leaky = {
      actorId: ACTOR,
      outcome: 'success',
      password: 'hunter2',
      accessToken: 'eyJ...',
      code_verifier: 'pkce-secret',
      sub: 'google-sub-123',
      client_secret: 'shh',
    } as unknown as AuditFields;

    service.record(AUDIT_ACTION.OAUTH_CALLBACK, CTX, leaky);

    const row = insert.mock.calls[0][0] as AuditInsert;
    const metadata = row.metadata as Record<string, unknown>;
    // Only the allowlisted, non-forbidden field survives.
    expect(metadata).toEqual({ outcome: 'success' });
    for (const forbidden of ['password', 'accessToken', 'code_verifier', 'sub', 'client_secret']) {
      expect(metadata).not.toHaveProperty(forbidden);
    }
  });

  it('should_omit_undefined_optional_fields_from_metadata', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    service.record(AUDIT_ACTION.LOGIN, CTX, { actorId: ACTOR, outcome: 'success' });

    const row = insert.mock.calls[0][0] as AuditInsert;
    expect(row.metadata).toEqual({ outcome: 'success' });
  });
});

describe('AuditService.record — fire-and-forget (S5/S8)', () => {
  it('should_return_void_and_not_await_the_insert', () => {
    const { repo, insert } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    const result = service.record(AUDIT_ACTION.TASK_CREATE, CTX, { actorId: ACTOR, outcome: 'success' });

    expect(result).toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('should_not_throw_and_should_log_AUDIT_WRITE_FAILED_when_the_insert_rejects', async () => {
    const { repo, insert } = makeRepo();
    const dbError = new Error('db is down');
    insert.mockRejectedValueOnce(dbError);
    const { logger, error } = makeLogger();
    const service = new AuditService(repo, logger);

    // The synchronous call must NOT throw even though the detached insert rejects.
    expect(() =>
      service.record(AUDIT_ACTION.TASK_DELETE, CTX, { actorId: ACTOR, resourceId: TARGET, targetType: 'task', outcome: 'success' }),
    ).not.toThrow();

    // Let the detached insert reject and its .catch run.
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

    const [payload, message] = error.mock.calls[0];
    expect(payload).toMatchObject({
      event: 'AUDIT_WRITE_FAILED',
      action: AUDIT_ACTION.TASK_DELETE,
      actorId: ACTOR,
      err: dbError,
    });
    expect(message).toMatch(/audit write failed/i);
  });

  it('should_not_log_when_the_insert_resolves', async () => {
    const { repo } = makeRepo();
    const { logger, error } = makeLogger();
    const service = new AuditService(repo, logger);

    service.record(AUDIT_ACTION.LOGIN, CTX, { actorId: ACTOR, outcome: 'success' });
    // Give any (erroneous) detached .catch ample time to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(error).not.toHaveBeenCalled();
  });
});

describe('AuditService.query — filter passthrough + pagination', () => {
  it('should_map_snake_case_query_to_the_camelCase_repository_filter', async () => {
    const { repo, findMany } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    const query: AuditQuery = {
      event_type: AUDIT_ACTION.LOGIN,
      actor_id: ACTOR,
      target_id: TARGET,
      from,
      to,
      page: 1,
      limit: 20,
    };

    await service.query(query);

    expect(findMany).toHaveBeenCalledTimes(1);
    const [filter, page] = findMany.mock.calls[0];
    expect(filter).toEqual({ eventType: AUDIT_ACTION.LOGIN, actorId: ACTOR, targetId: TARGET, from, to });
    expect(page).toEqual({ skip: 0, take: 20 });
  });

  it('should_translate_a_1_based_page_into_the_correct_skip', async () => {
    const { repo, findMany } = makeRepo();
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    await service.query({ page: 3, limit: 25 } as AuditQuery);

    const [, page] = findMany.mock.calls[0];
    expect(page).toEqual({ skip: 50, take: 25 });
  });

  it('should_map_rows_to_the_response_DTO_and_build_page_meta', async () => {
    const { repo, findMany } = makeRepo();
    findMany.mockResolvedValueOnce({
      rows: [
        {
          id: 'row-1',
          eventType: 'auth.login',
          actorId: ACTOR,
          targetId: null,
          targetType: null,
          ipAddress: '203.0.113.4',
          userAgent: 'ua/1',
          metadata: { outcome: 'success' },
          createdAt: new Date('2026-01-05T12:00:00Z'),
        },
      ],
      total: 1,
    });
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    const result = await service.query({ page: 1, limit: 20 } as AuditQuery);

    expect(result.pageInfo).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: 'row-1',
      eventType: 'auth.login',
      actorId: ACTOR,
      targetId: null,
      targetType: null,
      ipAddress: '203.0.113.4',
      userAgent: 'ua/1',
      metadata: { outcome: 'success' },
      createdAt: '2026-01-05T12:00:00.000Z',
    });
  });

  it('should_compute_totalPages_from_the_total_and_limit', async () => {
    const { repo, findMany } = makeRepo();
    findMany.mockResolvedValueOnce({ rows: [], total: 45 });
    const { logger } = makeLogger();
    const service = new AuditService(repo, logger);

    const result = await service.query({ page: 1, limit: 20 } as AuditQuery);

    expect(result.pageInfo.totalPages).toBe(3); // ceil(45/20)
  });
});
