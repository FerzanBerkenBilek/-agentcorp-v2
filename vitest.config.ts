import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration (ADR-007).
 *
 * Test files are co-located with the code they exercise under `src/`:
 *  - `*.test.ts`             -> unit tests (mock the layer directly below).
 *  - `*.integration.test.ts` -> HTTP integration tests against a real Fastify
 *    app built with `buildApp()`, with ONLY the Prisma data layer faked
 *    (see `src/test/setup.ts`) so no live PostgreSQL is required in CI.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Global setup: provide a valid env (config.ts validates at import time)
    // BEFORE any source module is imported.
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'lcov'],
      include: ['src/**/*.ts'],
      // Exclude bootstrap glue, type-only/wiring modules, and the test harness
      // itself — none contain unit-testable branching logic.
      exclude: [
        'src/server.ts',
        'src/index.ts',
        'src/shared/prisma.ts',
        'src/shared/logger.ts',
        'src/test/**',
        'src/**/*.test.ts',
        'src/**/*.integration.test.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
    include: ['src/**/*.test.ts'],
    // Each test file gets a fresh module registry so the mocked Prisma state in
    // one integration file never bleeds into another (no shared state).
    isolate: true,
  },
});
