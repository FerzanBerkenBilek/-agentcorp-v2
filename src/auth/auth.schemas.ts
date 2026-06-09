import { z } from 'zod';

/**
 * Zod schemas for auth endpoints. `.strict()` rejects unknown keys to defend
 * against mass-assignment (STRIDE Tampering). Inferred types are the single
 * source of truth for the service-layer DTOs.
 */

/** Minimum password length (clean-code: named, not a magic number). */
const MIN_PASSWORD_LENGTH = 8;
/** Maximum password length to bound bcrypt input (bcrypt truncates at 72 bytes). */
const MAX_PASSWORD_LENGTH = 72;
/** Maximum display-name length (matches User.name VARCHAR(100)). */
const MAX_NAME_LENGTH = 100;

/** Password policy: length + at least one letter and one digit. */
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

/** POST /auth/register body. */
export const registerSchema = z
  .object({
    email: z.string().email('A valid email is required'),
    password: passwordSchema,
    name: z.string().min(1, 'Name is required').max(MAX_NAME_LENGTH),
  })
  .strict();

/** POST /auth/login body. Password is not policy-checked here (only on register). */
export const loginSchema = z
  .object({
    email: z.string().email('A valid email is required'),
    password: z.string().min(1, 'Password is required'),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/** Auth response payload returned to the client (access token in body; refresh in cookie). */
export interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}
