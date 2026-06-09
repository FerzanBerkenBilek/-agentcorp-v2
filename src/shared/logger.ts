import { LoggerOptions } from 'pino';
import { config } from '../config';

/**
 * Pino logger configuration with redaction rules (M8).
 *
 * Fastify uses Pino under the hood; we pass these options into the Fastify
 * factory. The `redact` paths guarantee that passwords, tokens, cookies, and
 * Authorization headers are NEVER written to logs, even if an object that
 * contains them is logged by accident.
 */

/**
 * Dot-paths that must always be scrubbed from log output.
 * Covers request headers, cookies, and common sensitive body field names.
 */
const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'token',
  '*.password',
  '*.passwordHash',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
];

/**
 * Build the Pino logger options for the current environment.
 *
 * @returns Pino options with redaction enabled; `false` to disable logging in test.
 */
export function buildLoggerOptions(): LoggerOptions | boolean {
  if (config.isTest) {
    return false;
  }

  const options: LoggerOptions = {
    level: 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };

  if (!config.isProduction) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true },
    };
  }

  return options;
}
