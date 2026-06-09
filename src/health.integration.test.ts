import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakePrisma } from './test/fake-prisma';
import { APP_VERSION } from './shared/version';

/**
 * HTTP integration test for the public liveness probe `GET /health`.
 *
 * Builds the REAL Fastify app via `buildApp()` with ONLY the Prisma data layer
 * faked (no live PostgreSQL), matching the other integration tests. The route is
 * unauthenticated, so no token is sent. Asserts the success envelope plus the
 * three contract fields (status, ISO8601 timestamp, package.json version).
 */

const fake = createFakePrisma();
vi.mock('./shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { buildApp } = await import('./app');
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('should_return_200_with_status_timestamp_and_version_when_health_checked', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    // Version comes from package.json (single source of truth), never hardcoded.
    expect(body.data.version).toBe(APP_VERSION);
    // timestamp must be a valid ISO8601 instant (round-trips through Date).
    const ts: string = body.data.timestamp;
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
