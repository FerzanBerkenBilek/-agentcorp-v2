import { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';
import { audit, AUDIT_ACTION, AuditAction } from '../shared/audit';
import { authGuard, requireAuth } from '../shared/auth-context';
import { HTTP_STATUS } from '../shared/errors';
import { ApiSuccess, ok } from '../shared/http';
import { chargeAdditionalUnits } from '../shared/rate-limit-weight';
import { TaskResponse, toTaskResponse } from '../shared/task-serializer';
import { parseOrThrow } from '../shared/validate';
import { BulkFailure, BulkResult, InternalErrorSink, TasksService } from './tasks.service';
import {
  bulkCreateSchema,
  bulkDeleteSchema,
  bulkUpdateSchema,
  createTaskSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  updateTaskSchema,
} from './tasks.schemas';

/** Wire shape of a bulk response (HTTP 200 even on partial failure, ADR-042). */
interface BulkResponse {
  succeeded: TaskResponse[];
  failed: BulkFailure[];
}

/**
 * Split a service {@link BulkResult} into the `{ succeeded, failed }` wire shape
 * and emit one audit line per item with its REAL outcome (L1). Keeping this in
 * one place keeps the three bulk handlers thin and free of branching logic.
 *
 * @param result The aggregated per-item outcomes from the service.
 * @param log The request logger for the audit lines.
 * @param actorId The authenticated caller (audit actor).
 * @param actionFor Picks the audit action for an item by its index (create/update/assign/delete).
 * @returns The success-enveloped bulk response.
 */
function buildBulkResponse(
  result: BulkResult,
  log: FastifyBaseLogger,
  actorId: string,
  actionFor: (index: number) => AuditAction,
): ApiSuccess<BulkResponse> {
  const succeeded: TaskResponse[] = [];
  const failed: BulkFailure[] = [];
  result.outcomes.forEach((outcome, index) => {
    if (outcome.reason !== undefined) {
      failed.push({ id: outcome.id, reason: outcome.reason });
    } else if (outcome.task) {
      // every success carries the task body (create/update/delete snapshot).
      succeeded.push(toTaskResponse(outcome.task));
    }
    audit(log, actionFor(index), {
      actorId,
      resourceId: outcome.id,
      outcome: outcome.reason !== undefined ? 'failure' : 'success',
    });
  });
  return ok({ succeeded, failed });
}

/** Dependencies injected into the tasks routes plugin. */
export interface TasksRoutesDeps {
  tasksService: TasksService;
}

/**
 * Tasks route plugin. Every route is authenticated via `authGuard`. Handlers
 * only parse input, call the service, audit, and format the response — all
 * business logic and authorization live in the service/policy.
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (tasks service).
 * @returns A promise that resolves once routes are registered.
 */
export const tasksRoutes: FastifyPluginAsync<TasksRoutesDeps> = async (
  app: FastifyInstance,
  deps: TasksRoutesDeps,
): Promise<void> => {
  const { tasksService } = deps;
  app.addHook('preHandler', authGuard);

  app.post('/tasks', async (request, reply) => {
    const { userId } = requireAuth(request);
    const input = parseOrThrow(createTaskSchema, request.body);
    const task = await tasksService.create(userId, input);
    audit(request.log, AUDIT_ACTION.TASK_CREATE, { actorId: userId, resourceId: task.id, outcome: 'success' });
    return reply.status(HTTP_STATUS.CREATED).send(ok(toTaskResponse(task)));
  });

  app.get('/tasks', async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(listTasksQuerySchema, request.query);
    const page = await tasksService.list(userId, query);
    return reply.send(ok({ items: page.items.map(toTaskResponse), pageInfo: page.pageInfo }));
  });

  app.get('/tasks/:id', async (request, reply) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(taskIdParamSchema, request.params);
    const task = await tasksService.getById(userId, id);
    return reply.send(ok(toTaskResponse(task)));
  });

  app.patch('/tasks/:id', async (request, reply) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(taskIdParamSchema, request.params);
    const input = parseOrThrow(updateTaskSchema, request.body);
    const task = await tasksService.update(userId, id, input);
    const action = 'assigneeId' in input ? AUDIT_ACTION.TASK_ASSIGN : AUDIT_ACTION.TASK_UPDATE;
    audit(request.log, action, { actorId: userId, resourceId: id, outcome: 'success' });
    return reply.send(ok(toTaskResponse(task)));
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(taskIdParamSchema, request.params);
    await tasksService.delete(userId, id);
    audit(request.log, AUDIT_ACTION.TASK_DELETE, { actorId: userId, resourceId: id, outcome: 'success' });
    return reply.status(HTTP_STATUS.NO_CONTENT).send();
  });

  // ---- Bulk operations (BULK-2026-06-11). Each handler stays thin: parse the
  // batch (M1 cap pre-DB), charge the batch as N units against the global
  // limiter (H5 / ADR-043 — AFTER cap-50 validation, BEFORE per-item DB work),
  // call the service (which loops the EXISTING per-item create/update/delete —
  // H1/H2 authz reused verbatim), then split + audit (L1) + format. HTTP 200
  // even on partial failure (ADR-042). The request.log.error sink (H4) routes
  // unmapped INTERNAL errors server-side.

  app.post('/tasks/bulk-create', async (request, reply) => {
    const { userId } = requireAuth(request);
    const input = parseOrThrow(bulkCreateSchema, request.body);
    // H5/ADR-043: an N-item batch costs N units on the global limiter, not 1.
    await chargeAdditionalUnits(request, reply, input.items.length);
    const result = await tasksService.bulkCreate(userId, input, internalSink(request.log));
    const body = buildBulkResponse(result, request.log, userId, () => AUDIT_ACTION.TASK_CREATE);
    return reply.status(HTTP_STATUS.OK).send(body);
  });

  app.patch('/tasks/bulk-update', async (request, reply) => {
    const { userId } = requireAuth(request);
    const input = parseOrThrow(bulkUpdateSchema, request.body);
    // H5/ADR-043: an N-item batch costs N units on the global limiter, not 1.
    await chargeAdditionalUnits(request, reply, input.items.length);
    const result = await tasksService.bulkUpdate(userId, input, internalSink(request.log));
    const body = buildBulkResponse(result, request.log, userId, (index) =>
      'assigneeId' in input.items[index] ? AUDIT_ACTION.TASK_ASSIGN : AUDIT_ACTION.TASK_UPDATE,
    );
    return reply.status(HTTP_STATUS.OK).send(body);
  });

  app.delete('/tasks/bulk-delete', async (request, reply) => {
    const { userId } = requireAuth(request);
    const input = parseOrThrow(bulkDeleteSchema, request.body);
    // H5/ADR-043: an N-id batch costs N units on the global limiter, not 1.
    await chargeAdditionalUnits(request, reply, input.ids.length);
    const result = await tasksService.bulkDelete(userId, input, internalSink(request.log));
    const body = buildBulkResponse(result, request.log, userId, () => AUDIT_ACTION.TASK_DELETE);
    return reply.status(HTTP_STATUS.OK).send(body);
  });
};

/**
 * Build the H4 server-side error sink from the request logger. Unmapped per-item
 * errors are logged with full detail server-side; only the flat `INTERNAL` token
 * reaches the client (mirrors error-handler.ts; no internal/Prisma text leaks).
 *
 * @param log The request-scoped logger.
 * @returns A sink the service calls for INTERNAL per-item failures.
 */
function internalSink(log: FastifyBaseLogger): InternalErrorSink {
  return (error, itemId) =>
    log.error({ event: 'BULK_ITEM_ERROR', itemId, err: error }, 'bulk item failed unexpectedly');
}
