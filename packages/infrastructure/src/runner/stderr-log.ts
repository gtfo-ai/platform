/**
 * What the runner does with the CLI's stderr (WP-127, PROGRESS backlog 344).
 *
 * The ruling, in three clauses:
 *
 *  1. **It reaches the runner's redactor.** A containerised CLI's stderr arrives as `stderr` frames
 *     on the run shim's socket (`runlet/spawn-adapter.ts`); the SDK reads stderr only from a process
 *     it spawned itself. So the spawn exposes a sink and the runner sets this one, built with the
 *     run's own redactor (TD-012: the injected secrets first, then the patterns).
 *  2. **Its level depends on whether the stream ever opened.** A CLI that dies before its first
 *     stream message — a missing library, a refused flag, an auth error printed before the stream
 *     opens — has nothing else to say why, so what it wrote is one `warn` line when the run ends.
 *     Once the first message has arrived the CLI is talking on its stream and stderr is chatter:
 *     `debug`, the shipped `LOG_LEVEL` (`info`) drops it.
 *  3. **It reaches nothing else.** Not the transcript, not `RunOutcome.error`, not the task: stderr
 *     is untrusted text (BD-022) and the run record has no redactor between it and a human. The log
 *     line is the whole of its destination.
 *
 * Before the stream opens the text is **held, raw, bounded** ({@link MAX_HELD_CHARS}, the newest
 * characters kept) and redacted as one string when it is written: redacting each frame separately
 * lets a credential split across two frames through. Only the redacted text is cut to the line's
 * {@link MAX_LOGGED_CHARS}, so the raw cut — which can halve a credential the redactor then cannot
 * match — is always outside what is written. After the stream opens each frame is redacted and
 * logged as it comes, which keeps the split residual for the `debug` lines — stated here rather
 * than hidden.
 */
import type { Logger, SecretRedactor } from '@platform/application';

/** The most raw stderr held while the stream has not opened (the newest characters are kept). */
export const MAX_HELD_CHARS = 64 * 1024;
/** The most redacted stderr the one `warn` line carries (its tail). */
export const MAX_LOGGED_CHARS = 8 * 1024;

export interface StderrLog {
  /** The sink: one frame's text. */
  readonly accept: (chunk: string) => void;
  /** The first stream message arrived: what was held goes out at `debug`, and so does the rest. */
  readonly streamOpened: () => void;
  /** The run ended. If the stream never opened and the CLI wrote anything, one `warn` line. */
  readonly runEnded: () => void;
}

export const createStderrLog = (options: {
  readonly runId: string;
  readonly logger: Logger;
  readonly redactor: Pick<SecretRedactor, 'redactText'>;
}): StderrLog => {
  const { runId, logger, redactor } = options;
  let opened = false;
  let ended = false;
  let held = '';
  let dropped = 0;

  const hold = (chunk: string): void => {
    held += chunk;
    if (held.length > MAX_HELD_CHARS) {
      dropped += held.length - MAX_HELD_CHARS;
      held = held.slice(held.length - MAX_HELD_CHARS);
    }
  };

  const debug = (text: string): void => {
    logger.debug({ run_id: runId, stderr: redactor.redactText(text).value }, 'claude code stderr');
  };

  return {
    accept: (chunk) => {
      if (opened || ended) {
        debug(chunk);
        return;
      }
      hold(chunk);
    },
    streamOpened: () => {
      if (opened) {
        return;
      }
      opened = true;
      if (held.length > 0) {
        debug(held);
      }
      held = '';
    },
    runEnded: () => {
      if (ended) {
        return;
      }
      ended = true;
      if (opened || held.length === 0) {
        return;
      }
      const redacted = redactor.redactText(held).value;
      logger.warn(
        {
          run_id: runId,
          stderr: redacted.slice(Math.max(0, redacted.length - MAX_LOGGED_CHARS)),
          stderr_truncated: dropped > 0 || redacted.length > MAX_LOGGED_CHARS,
        },
        'the CLI wrote on stderr and the run ended before its first stream message',
      );
      held = '';
    },
  };
};
