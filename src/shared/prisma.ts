import { PrismaClient } from '@prisma/client';
import { config } from '../config';

/**
 * Single shared Prisma client (one connection pool per process), per ADR-010
 * rule #3 and ADR-018. This module is the ONLY place that constructs the
 * client; repositories import this singleton. Nothing else imports
 * `@prisma/client`'s constructor.
 *
 * In non-production we cache the instance on globalThis so hot-reload
 * (tsx watch) does not open a new pool on every reload and exhaust connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Gracefully disconnect the Prisma client, draining the connection pool.
 * Call from the process shutdown handler (SIGTERM/SIGINT).
 *
 * @returns A promise that resolves once the pool is drained.
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
