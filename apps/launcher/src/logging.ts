/**
 * The launcher's logger: pino, NDJSON, the `Logger` port.
 *
 * A second, smaller copy of `apps/server/src/logging.ts` rather than an import of it, because
 * `apps/*` are composition roots and one may not reach into another's sources (the dependency rule
 * in `biome.json`). What is shared — the port's shape — is in `@platform/application`, and what is
 * not shared is the redaction path list: the launcher never holds an integration credential, so
 * the only secret that could reach a log line here is a run-scoped git token, and that one is
 * redacted at the place it is injected (`workspace/provider.ts` § "Secrets").
 *
 * `GIT_PASS` and `RUNLET_TOKEN` are on the redact list anyway. Not because a code path puts them
 * there today, but because both are field names this service constructs, and a future `logger.debug({
 * env })` is exactly the line nobody reviews.
 */
import type { Logger as LoggerPort } from '@platform/application';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

const REDACTED_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'GIT_PASS',
  '*.GIT_PASS',
  'RUNLET_TOKEN',
  '*.RUNLET_TOKEN',
] as const;

export interface LauncherLoggerOptions {
  readonly level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Test seam: pino writes here instead of stdout. */
  readonly destination?: DestinationStream;
}

export const createLauncherLogger = (options: LauncherLoggerOptions): PinoLogger => {
  const base = {
    level: options.level,
    base: { role: 'launcher' },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], remove: false },
  };
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
};

/** The application ring's `Logger` port, bound to a pino instance. */
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
