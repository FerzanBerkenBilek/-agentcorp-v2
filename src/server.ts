import { buildApp } from './app';
import { config } from './config';
import { disconnectPrisma } from './shared/prisma';

/**
 * HTTP server entry point. Builds the app, starts listening, and registers
 * graceful-shutdown handlers that drain the Prisma pool before exit.
 *
 * @returns A promise that resolves once the server is listening.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down gracefully`);
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    await disconnectPrisma();
    process.exit(1);
  }
}

void main();
