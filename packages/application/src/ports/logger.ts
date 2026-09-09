/**
 * The logging port.
 *
 * `CLAUDE.md` mandates pino and forbids `console.log` in server code, but pino is a dependency of
 * the composition root, not of this ring — so the application ring names the shape it needs and
 * WP-06 binds a pino instance to it. The pino call signature (`(fields, message)`) is what is
 * mirrored here, so binding is a no-op rather than an adapter.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

/** Discards everything. The default, so nothing in this ring logs unless a root wires it up. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
