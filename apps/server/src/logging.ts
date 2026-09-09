/**
 * Structured logging (TD-023): pino to stdout, with `redact` and an `AsyncLocalStorage` mixin
 * carrying `request_id / task_id / run_id / trace_id`.
 *
 * `CLAUDE.md` forbids `console.log` in server code, and the application ring already declares the
 * shape it needs (`@platform/application`'s `Logger`). pino's call signature is `(fields, message)`,
 * which is exactly that shape, so binding a pino instance to the port is an assignment rather than
 * an adapter — the reason the port was written that way.
 *
 * The redaction list is a **second** line of defence, not the first: TD-012 redacts secrets where
 * they are written to the transcript. This one catches the accident of logging a whole request, a
 * whole config object or an error carrying a connection string.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger as LoggerPort } from '@platform/application';
import {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
  pino,
} from 'pino';
import type { ServerConfig } from './config.js';

/** Correlation fields every log line inside a request carries. Extended as later rings need it. */
export interface LogContext {
  readonly request_id?: string;
  readonly task_id?: string;
  readonly run_id?: string;
  readonly trace_id?: string;
  readonly user_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with these correlation fields attached to every log line it produces. */
export const withLogContext = <T>(context: LogContext, fn: () => T): T => storage.run(context, fn);

export const currentLogContext = (): LogContext => storage.getStore() ?? {};

/**
 * Paths pino replaces with `[Redacted]`.
 *
 * Wildcards cover the two shapes a secret actually arrives in: a header on a request object, and a
 * field on an object that was logged wholesale. `censor` is the default `[Redacted]` string; the
 * point is that the key survives, so a log line still shows that an Authorization header was
 * present.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'secretKey',
  '*.secretKey',
  'apiKey',
  '*.apiKey',
  'connectionString',
  '*.connectionString',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
] as const;

export interface LoggerOptions {
  readonly level: ServerConfig['logLevel'];
  readonly format: ServerConfig['logFormat'];
  readonly role: string;
  /** Test seam: pino writes here instead of stdout. */
  readonly destination?: DestinationStream;
}

export const createLogger = (options: LoggerOptions): PinoLogger => {
  const base = {
    level: options.level,
    base: { role: options.role },
    // snake_case on the wire, like every other payload in the platform (CLAUDE.md).
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], remove: false },
    /** Every line inside a request carries the request's correlation fields (TD-023). */
    mixin: (): Record<string, unknown> => ({ ...currentLogContext() }),
  } satisfies PinoLoggerOptions;

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }
  if (options.format === 'pretty') {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } },
    });
  }
  return pino(base);
};

/**
 * The application ring's `Logger` port, bound to a pino instance.
 *
 * Not a wrapper: the four methods are pino's own, with the port's exact signature. It exists so a
 * caller in `packages/application` never names pino.
 */
export const asLoggerPort = (logger: PinoLogger): LoggerPort => ({
  debug: (fields, message) => {
    logger.debug(fields, message);
  },
  info: (fields, message) => {
    logger.info(fields, message);
  },
  warn: (fields, message) => {
    logger.warn(fields, message);
  },
  error: (fields, message) => {
    logger.error(fields, message);
  },
});

export type { PinoLogger };
