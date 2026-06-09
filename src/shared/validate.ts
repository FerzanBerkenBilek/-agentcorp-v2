import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Parse unknown input against a Zod schema, converting failures into a
 * ValidationError (-> HTTP 422) with structured per-field details. This is the
 * single place validation errors are produced, so the route layer never
 * imports Zod's error type directly.
 *
 * @param schema The Zod schema to validate against.
 * @param input The raw, untrusted value (body/query/params).
 * @returns The parsed, typed value.
 * @throws ValidationError if the input does not match the schema.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ValidationError('Request validation failed', details);
  }
  return result.data;
}
