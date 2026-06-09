import { z } from 'zod';

/**
 * Centralized, validated application configuration.
 *
 * All process.env access happens here and nowhere else (ADR-009 defense in
 * depth + clean-code: a single typed config object). The schema fails fast at
 * startup if any required variable is missing or malformed, so the process
 * never boots in a half-configured state.
 *
 * Security-relevant invariants enforced here:
 *  - JWT_SECRET / JWT_REFRESH_SECRET must be >= 32 bytes (H3).
 *  - CORS_ORIGINS is an explicit allowlist; never `*` with credentials (M8/M6).
 */

/** Minimum JWT secret length in bytes (H3: reject weak secrets). */
const MIN_JWT_SECRET_BYTES = 32;

/** Hard maximum request body size in bytes (M8: 1 MB). */
export const BODY_LIMIT_BYTES = 1 * 1024 * 1024;

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') >= MIN_JWT_SECRET_BYTES, {
      message: `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes`,
    }),
  JWT_REFRESH_SECRET: z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') >= MIN_JWT_SECRET_BYTES, {
      message: `JWT_REFRESH_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes`,
    }),

  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),

  // Comma-separated allowlist of origins permitted to send credentialed
  // cross-origin requests. Used by CORS and the CSRF Origin/Referer check (M6).
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
});

type RawEnv = z.infer<typeof envSchema>;

/** Fully typed, validated application configuration. */
export type Config = RawEnv & {
  isProduction: boolean;
  isTest: boolean;
};

/**
 * Parse and validate environment variables into a typed config object.
 *
 * @returns The validated configuration.
 * @throws Error if any environment variable is missing or invalid.
 */
function parseConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment configuration invalid:\n${issues}`);
  }
  return {
    ...result.data,
    isProduction: result.data.NODE_ENV === 'production',
    isTest: result.data.NODE_ENV === 'test',
  };
}

/** Singleton validated configuration, parsed once at module load. */
export const config: Config = parseConfig();
