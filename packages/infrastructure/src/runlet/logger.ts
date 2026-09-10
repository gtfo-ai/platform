/**
 * The shim's logger: NDJSON on stderr, in pino's shape, with no pino.
 *
 * `CLAUDE.md` mandates pino and forbids `console.log` in **server** code, and TD-025 requires the
 * shim to have **no runtime dependencies** — it is a single file in the `platform-runtime` image,
 * beside the agent, and every dependency there is one more thing to audit and to patch. Those two
 * rules meet here, and TD-025 wins for this one binary: the output is the same NDJSON an operator
 * reads out of `docker logs`, with pino's `level`/`time`/`msg` keys so the same tooling parses it.
 *
 * It writes to **stderr** on purpose. The child's stdout is the SDK's protocol stream and travels
 * as frames; the shim's own diagnostics must not be able to reach it.
 */
import type { LogFields, Logger } from '@platform/application';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, silent: 100 } as const;

export type RunletLogLevel = keyof typeof LEVELS;

export interface RunletLoggerOptions {
  readonly level?: RunletLogLevel;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
}

/**
 * Fields are serialised as given. Nothing here redacts: the shim never holds a credential, and the
 * one value that would be worth redacting — the run token — is never passed to it.
 */
export const createRunletLogger = (options: RunletLoggerOptions = {}): Logger => {
  const threshold = LEVELS[options.level ?? 'info'];
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? ((line: string) => process.stderr.write(line));

  const at = (level: Exclude<RunletLogLevel, 'silent'>) => (fields: LogFields, message: string) => {
    if (LEVELS[level] < threshold) {
      return;
    }
    write(
      `${JSON.stringify({ level: LEVELS[level], time: now(), name: 'agentic-runlet', ...fields, msg: message })}\n`,
    );
  };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};
