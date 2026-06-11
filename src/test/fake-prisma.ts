import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { FlagState, UserRole } from '@prisma/client';
import type {
  BlockedDomain,
  FlaggedUrl,
  PrismaClient,
  RefreshToken,
  ShortUrl,
  Task,
  TaskPriority,
  TaskStatus,
  User,
} from '@prisma/client';

/**
 * Minimal in-memory stand-in for the Prisma client used by the HTTP
 * integration tests, so the suite needs no live PostgreSQL (CI constraint).
 *
 * It implements ONLY the methods the three repositories actually call and
 * mimics the relevant Prisma semantics:
 *  - `findUnique` honours `select` (returns only selected columns) and unique
 *    constraint lookups by id / email / hashedToken.
 *  - `create` enforces the User.email unique constraint (throws P2002 shape).
 *  - `update`/`delete` throw a P2025 ("record not found") shape when missing.
 *  - `$transaction([...])` runs the array of promises (findMany + count).
 *
 * This is a deliberate, behaviour-explicit fake — not an "accept anything"
 * mock. Each method asserts on real arguments and returns real, consistent
 * data so that tests fail when the code under test is broken.
 */

interface UserRow extends User {}
interface TaskRow extends Task {}
interface RefreshTokenRow extends RefreshToken {}
interface ShortUrlRow extends ShortUrl {}
interface BlockedDomainRow extends BlockedDomain {}
interface FlaggedUrlRow extends FlaggedUrl {}

/** Thrown to mimic Prisma's known-request-error envelope (code + meta). */
class FakePrismaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly meta?: unknown,
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}

/** In-memory store shared by the fake delegates within one client instance. */
export interface FakeStore {
  users: Map<string, UserRow>;
  tasks: Map<string, TaskRow>;
  refreshTokens: Map<string, RefreshTokenRow>;
  /** Keyed by short code (the unique business key), mirroring UNIQUE(code). */
  shortUrls: Map<string, ShortUrlRow>;
  /** Keyed by canonical domain (UNIQUE(domain)), mirroring the blocklist. */
  blockedDomains: Map<string, BlockedDomainRow>;
  /** Keyed by UUID id, mirroring flagged_urls. */
  flaggedUrls: Map<string, FlaggedUrlRow>;
}

/**
 * Build a REAL `Prisma.PrismaClientKnownRequestError` (not just a look-alike) so
 * that `error instanceof Prisma.PrismaClientKnownRequestError` checks in the
 * code under test (e.g. UrlsService collision-retry) behave exactly as they do
 * against a live database.
 *
 * @param code The Prisma error code (e.g. 'P2002', 'P2025').
 * @param message Human-readable message.
 * @param meta Optional Prisma `meta` (e.g. the violated `target`).
 * @returns A genuine PrismaClientKnownRequestError instance.
 */
function prismaKnownError(
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
    meta,
  });
}

/**
 * Pick only the keys whose `select` flag is true (mimics Prisma `select`).
 *
 * @param row The full row.
 * @param select The select map (column -> boolean).
 * @returns A new object with only the selected columns.
 */
function applySelect<T extends Record<string, unknown>>(
  row: T,
  select?: Record<string, boolean>,
): Partial<T> | T {
  if (!select) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [key, include] of Object.entries(select)) {
    if (include) {
      out[key] = row[key];
    }
  }
  return out as Partial<T>;
}

/**
 * Build an in-memory fake Prisma client plus a handle to its backing store,
 * so tests can seed data directly and assert on persisted state.
 *
 * @returns The fake client (typed as PrismaClient) and its mutable store.
 */
export function createFakePrisma(): { prisma: PrismaClient; store: FakeStore } {
  const store: FakeStore = {
    users: new Map(),
    tasks: new Map(),
    refreshTokens: new Map(),
    shortUrls: new Map(),
    blockedDomains: new Map(),
    flaggedUrls: new Map(),
  };

  const user = {
    findUnique: async (args: {
      where: { id?: string; email?: string };
      select?: Record<string, boolean>;
    }): Promise<Partial<UserRow> | null> => {
      const found = findUserBy(store, args.where);
      return found ? applySelect(found, args.select) : null;
    },
    create: async (args: {
      data: { email: string; passwordHash: string; name: string };
      select?: Record<string, boolean>;
    }): Promise<Partial<UserRow>> => {
      if ([...store.users.values()].some((u) => u.email === args.data.email)) {
        throw new FakePrismaError('P2002', 'Unique constraint failed', {
          target: ['email'],
        });
      }
      const now = new Date();
      const row: UserRow = {
        id: randomUUID(),
        email: args.data.email,
        passwordHash: args.data.passwordHash,
        name: args.data.name,
        // Mirror the DB column default (ADR-030): new users are USER. Tests that
        // need an admin set the role explicitly on the seeded row.
        role: UserRole.USER,
        createdAt: now,
        updatedAt: now,
      };
      store.users.set(row.id, row);
      return applySelect(row, args.select);
    },
  };

  const task = {
    findUnique: async (args: { where: { id: string } }): Promise<TaskRow | null> => {
      return store.tasks.get(args.where.id) ?? null;
    },
    create: async (args: { data: TaskCreateData }): Promise<TaskRow> => {
      const now = new Date();
      const row: TaskRow = {
        id: randomUUID(),
        title: args.data.title,
        description: args.data.description ?? null,
        status: (args.data.status ?? 'TODO') as TaskStatus,
        priority: (args.data.priority ?? 'MEDIUM') as TaskPriority,
        ownerId: args.data.ownerId,
        assigneeId: args.data.assigneeId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.tasks.set(row.id, row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<TaskRow>;
    }): Promise<TaskRow> => {
      const existing = store.tasks.get(args.where.id);
      if (!existing) {
        throw new FakePrismaError('P2025', 'Record to update not found');
      }
      const updated: TaskRow = { ...existing, ...args.data, updatedAt: new Date() };
      store.tasks.set(updated.id, updated);
      return updated;
    },
    delete: async (args: { where: { id: string } }): Promise<TaskRow> => {
      const existing = store.tasks.get(args.where.id);
      if (!existing) {
        throw new FakePrismaError('P2025', 'Record to delete not found');
      }
      store.tasks.delete(args.where.id);
      return existing;
    },
    findMany: async (args: TaskFindManyArgs): Promise<TaskRow[]> => {
      const rows = filterTasks(store, args.where);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const skip = args.skip ?? 0;
      const take = args.take ?? rows.length;
      return rows.slice(skip, skip + take);
    },
    count: async (args: { where?: TaskWhere }): Promise<number> => {
      return filterTasks(store, args.where).length;
    },
  };

  const refreshToken = {
    create: async (args: { data: RefreshTokenCreateData }): Promise<RefreshTokenRow> => {
      const row: RefreshTokenRow = {
        id: randomUUID(),
        hashedToken: args.data.hashedToken,
        family: args.data.family,
        jti: args.data.jti,
        userId: args.data.userId,
        expiresAt: args.data.expiresAt,
        revokedAt: null,
        createdAt: new Date(),
      };
      store.refreshTokens.set(row.id, row);
      return row;
    },
    findUnique: async (args: {
      where: { hashedToken: string };
    }): Promise<RefreshTokenRow | null> => {
      return (
        [...store.refreshTokens.values()].find(
          (t) => t.hashedToken === args.where.hashedToken,
        ) ?? null
      );
    },
    update: async (args: {
      where: { id: string };
      data: Partial<RefreshTokenRow>;
    }): Promise<RefreshTokenRow> => {
      const existing = store.refreshTokens.get(args.where.id);
      if (!existing) {
        throw new FakePrismaError('P2025', 'Record to update not found');
      }
      const updated = { ...existing, ...args.data };
      store.refreshTokens.set(updated.id, updated);
      return updated;
    },
    updateMany: async (args: {
      where: { family: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const t of store.refreshTokens.values()) {
        if (t.family === args.where.family && t.revokedAt === null) {
          t.revokedAt = args.data.revokedAt;
          count += 1;
        }
      }
      return { count };
    },
  };

  const shortUrl = {
    create: async (args: { data: ShortUrlCreateData }): Promise<ShortUrlRow> => {
      // Mirror UNIQUE(code): a duplicate code surfaces as a real Prisma P2002,
      // which UrlsService catches to regenerate + retry (ADR-022).
      if (store.shortUrls.has(args.data.code)) {
        throw prismaKnownError('P2002', 'Unique constraint failed', { target: ['code'] });
      }
      const now = new Date();
      const row: ShortUrlRow = {
        id: randomUUID(),
        code: args.data.code,
        originalUrl: args.data.originalUrl,
        ownerId: args.data.ownerId,
        clickCount: 0,
        createdAt: now,
        lastAccessedAt: null,
        updatedAt: now,
      };
      store.shortUrls.set(row.code, row);
      return row;
    },
    findUnique: async (args: { where: { code: string } }): Promise<ShortUrlRow | null> => {
      return store.shortUrls.get(args.where.code) ?? null;
    },
    count: async (args: {
      where: { ownerId: string; createdAt?: { gte: Date } };
    }): Promise<number> => {
      const since = args.where.createdAt?.gte;
      return [...store.shortUrls.values()].filter(
        (u) =>
          u.ownerId === args.where.ownerId &&
          (since === undefined || u.createdAt.getTime() >= since.getTime()),
      ).length;
    },
    update: async (args: {
      where: { code: string };
      data: ShortUrlUpdateData;
    }): Promise<ShortUrlRow> => {
      const existing = store.shortUrls.get(args.where.code);
      if (!existing) {
        throw prismaKnownError('P2025', 'Record to update not found');
      }
      // Honour the atomic `{ increment }` operator the repository uses (ADR-023).
      const increment = args.data.clickCount?.increment ?? 0;
      const updated: ShortUrlRow = {
        ...existing,
        clickCount: existing.clickCount + increment,
        lastAccessedAt: args.data.lastAccessedAt ?? existing.lastAccessedAt,
        updatedAt: new Date(),
      };
      store.shortUrls.set(updated.code, updated);
      return updated;
    },
    delete: async (args: { where: { code: string } }): Promise<ShortUrlRow> => {
      const existing = store.shortUrls.get(args.where.code);
      if (!existing) {
        throw prismaKnownError('P2025', 'Record to delete not found');
      }
      store.shortUrls.delete(args.where.code);
      return existing;
    },
  };

  const blockedDomain = {
    findUnique: async (args: {
      where: { domain: string };
      select?: Record<string, boolean>;
    }): Promise<Partial<BlockedDomainRow> | null> => {
      const found = store.blockedDomains.get(args.where.domain);
      return found ? applySelect(found, args.select) : null;
    },
    create: async (args: { data: BlockedDomainCreateData }): Promise<BlockedDomainRow> => {
      // Mirror UNIQUE(domain): a duplicate surfaces as a real Prisma P2002.
      if (store.blockedDomains.has(args.data.domain)) {
        throw prismaKnownError('P2002', 'Unique constraint failed', { target: ['domain'] });
      }
      const row: BlockedDomainRow = {
        id: randomUUID(),
        domain: args.data.domain,
        note: args.data.note ?? null,
        addedByUserId: args.data.addedByUserId ?? null,
        createdAt: new Date(),
      };
      store.blockedDomains.set(row.domain, row);
      return row;
    },
    findMany: async (_args: { orderBy?: unknown }): Promise<BlockedDomainRow[]> => {
      const rows = [...store.blockedDomains.values()];
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows;
    },
    deleteMany: async (args: { where: { domain: string } }): Promise<{ count: number }> => {
      return store.blockedDomains.delete(args.where.domain) ? { count: 1 } : { count: 0 };
    },
  };

  const flaggedUrl = {
    create: async (args: { data: FlaggedUrlCreateData }): Promise<FlaggedUrlRow> => {
      const row: FlaggedUrlRow = {
        id: randomUUID(),
        candidateUrl: args.data.candidateUrl,
        proposedCode: null,
        ownerId: args.data.ownerId,
        confidenceScore: args.data.confidenceScore,
        state: FlagState.PENDING,
        flaggedReason: args.data.flaggedReason,
        createdAt: new Date(),
        reviewedAt: null,
        reviewedByUserId: null,
      };
      store.flaggedUrls.set(row.id, row);
      return row;
    },
    findUnique: async (args: { where: { id: string } }): Promise<FlaggedUrlRow | null> => {
      return store.flaggedUrls.get(args.where.id) ?? null;
    },
    findMany: async (args: {
      where?: { state?: FlagState };
      orderBy?: unknown;
    }): Promise<FlaggedUrlRow[]> => {
      let rows = [...store.flaggedUrls.values()];
      if (args.where?.state !== undefined) {
        rows = rows.filter((f) => f.state === args.where!.state);
      }
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FlaggedUrlRow>;
    }): Promise<FlaggedUrlRow> => {
      const existing = store.flaggedUrls.get(args.where.id);
      if (!existing) {
        throw prismaKnownError('P2025', 'Record to update not found');
      }
      const updated: FlaggedUrlRow = { ...existing, ...args.data };
      store.flaggedUrls.set(updated.id, updated);
      return updated;
    },
    delete: async (args: { where: { id: string } }): Promise<FlaggedUrlRow> => {
      const existing = store.flaggedUrls.get(args.where.id);
      if (!existing) {
        throw prismaKnownError('P2025', 'Record to delete not found');
      }
      store.flaggedUrls.delete(args.where.id);
      return existing;
    },
  };

  const client = {
    user,
    task,
    refreshToken,
    shortUrl,
    blockedDomain,
    flaggedUrl,
    // The tasks repository runs [findMany, count] inside a transaction.
    $transaction: async <T>(ops: Promise<T>[]): Promise<T[]> => Promise.all(ops),
    $disconnect: async (): Promise<void> => undefined,
  };

  return { prisma: client as unknown as PrismaClient, store };
}

interface TaskCreateData {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  ownerId: string;
  assigneeId?: string | null;
}

interface RefreshTokenCreateData {
  hashedToken: string;
  family: string;
  jti: string;
  userId: string;
  expiresAt: Date;
}

interface ShortUrlCreateData {
  code: string;
  originalUrl: string;
  ownerId: string;
}

interface BlockedDomainCreateData {
  domain: string;
  note?: string | null;
  addedByUserId?: string | null;
}

interface FlaggedUrlCreateData {
  candidateUrl: string;
  ownerId: string;
  confidenceScore: number;
  flaggedReason: string;
}

interface ShortUrlUpdateData {
  clickCount?: { increment: number };
  lastAccessedAt?: Date;
}

interface TaskWhere {
  OR?: Array<{ ownerId?: string; assigneeId?: string }>;
  status?: TaskStatus;
  priority?: TaskPriority;
}

interface TaskFindManyArgs {
  where?: TaskWhere;
  skip?: number;
  take?: number;
  orderBy?: unknown;
}

/**
 * Look up a user by the unique key present in the where-clause.
 *
 * @param store The in-memory store.
 * @param where Either `{ id }` or `{ email }`.
 * @returns The matching user row, or undefined.
 */
function findUserBy(
  store: FakeStore,
  where: { id?: string; email?: string },
): UserRow | undefined {
  if (where.id !== undefined) {
    return store.users.get(where.id);
  }
  if (where.email !== undefined) {
    return [...store.users.values()].find((u) => u.email === where.email);
  }
  return undefined;
}

/**
 * Apply the scoped + filtered task where-clause used by listForUser.
 *
 * @param store The in-memory store.
 * @param where The Prisma-style where (OR scope + optional status/priority).
 * @returns The matching task rows.
 */
function filterTasks(store: FakeStore, where?: TaskWhere): TaskRow[] {
  let rows = [...store.tasks.values()];
  if (where?.OR) {
    rows = rows.filter((t) =>
      where.OR!.some(
        (clause) =>
          (clause.ownerId !== undefined && t.ownerId === clause.ownerId) ||
          (clause.assigneeId !== undefined && t.assigneeId === clause.assigneeId),
      ),
    );
  }
  if (where?.status !== undefined) {
    rows = rows.filter((t) => t.status === where.status);
  }
  if (where?.priority !== undefined) {
    rows = rows.filter((t) => t.priority === where.priority);
  }
  return rows;
}
