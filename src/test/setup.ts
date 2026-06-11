/**
 * Global test setup (referenced by vitest.config.ts `setupFiles`).
 *
 * `src/config.ts` validates `process.env` at module-import time and throws if
 * required variables are missing or a JWT secret is < 32 bytes. This file runs
 * before any source module is imported, so it must populate a valid environment
 * here. Secrets are throwaway test values — never real credentials.
 *
 * NODE_ENV=test also disables the Pino logger (see logger.ts) so test output
 * stays clean and fast.
 */

// 32+ byte secrets are required by config.ts (H3). These are fixed test values.
const TEST_SECRET = 'test-jwt-secret-value-0123456789-abcdef'; // 39 bytes

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = TEST_SECRET;
process.env.JWT_REFRESH_SECRET = `${TEST_SECRET}-refresh`;
// Short TTLs keep token-expiry assertions fast where needed; overridable per test.
process.env.ACCESS_TOKEN_TTL = '15m';
process.env.REFRESH_TOKEN_TTL = '7d';
// Lower bcrypt rounds so register/login unit + integration tests stay fast.
// Still a real KDF (>=10 enforced by config); production uses 12 (ADR-008).
process.env.BCRYPT_ROUNDS = '10';
// Empty by default so the CSRF Origin guard is a no-op except where a test
// explicitly sets an allowlist by re-importing config (covered in its own test).
process.env.CORS_ORIGINS = '';
// Google OAuth2 credentials (OA-2026-06-11). Required by config.ts; throwaway
// test values. Google's HTTP endpoints are always mocked in tests (no live
// calls) — these only satisfy the startup Zod validation + URL building.
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
