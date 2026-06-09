import { Task } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { audit, AUDIT_ACTION } from '../shared/audit';
import { authGuard, requireAuth } from '../shared/auth-context';
import { HTTP_STATUS } from '../shared/errors';
import { ok } from '../shared/http';
import { parseOrThrow } from '../shared/validate';
import { TasksService } from './tasks.service';
import {
  createTaskSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  updateTaskSchema,
} from './tasks.schemas';

/** Dependencies injected into the tasks routes plugin. */
export interface TasksRoutesDeps {
  tasksService: TasksService;
}

/** Wire shape of a task (Dates serialized to ISO strings). */
interface TaskResponse {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  ownerId: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map an internal Task to its wire DTO.
 *
 * @param task The task entity.
 * @returns The serializable task response.
 */
function toTaskResponse(task: Task): TaskResponse {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    ownerId: task.ownerId,
    assigneeId: task.assigneeId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
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
};
