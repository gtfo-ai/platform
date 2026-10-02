/**
 * **The one-off re-read of readings stored under the pattern rules alone** — WP-121, TD-012's M7
 * amendment (1), PROGRESS backlog 359.
 *
 * A repository reading written before WP-107 redacted `.agentic/prompts/` by the pattern rules only,
 * so a credential the platform holds, committed there in a shape no rule knows, is still in the row,
 * and nothing re-read it at upgrade: every run of the project was handed it until the next default
 * branch move. Migration 0073 marks every such row `patterns`, and two things follow from the mark:
 *
 *  - **the row serves no prompt text** — `snapshotOfRow` answers it without its prompts, so the
 *    planner and `GET …/config` see a withheld directory and the reason, never the stale copy;
 *  - **this pass replaces it** — in the process that runs the knowledge index, a bounded number of
 *    projects per pass, through the same `refreshRepositoryConfig` an index run and
 *    `POST …/config/refresh` use, which writes an `exact` row.
 *
 * A project whose repository cannot be read again keeps no prompt text: its row's prompts are
 * dropped and the reason is recorded on it (`withholdPatternReading`), the direction WP-107 chose for
 * an unreadable binding. The mark stays, so the next index run or refresh still replaces it; this
 * process does not ask again (the failed ids are excluded for its lifetime), which is what makes the
 * passes end.
 *
 * Outside any transaction: each re-read spawns `git` and may fetch.
 */
import type { Id } from '@platform/contracts';
import { bindingSecretRedactor } from '../integrations/redaction.js';
import type { Logger } from '../ports/logger.js';
import {
  PATTERN_READING_WITHHELD_REASON,
  type PatternReadingStore,
  type ProjectBindingSecrets,
  type PromptsWithheld,
  type RepositoryConfigRefresh,
} from './repository-config.js';

/** Projects re-read per pass: each is a fetch, so a large installation is worked through in steps. */
export const PATTERN_REREAD_BATCH = 8;

/** Longest recorded failure reason: a sentence, not a log. */
const MAX_REREAD_FAILURE_CHARS = 400;

export interface PatternRereadOptions {
  readonly store: PatternReadingStore;
  /**
   * `refreshRepositoryConfig` over this process' mirror, at the default branch's head — always
   * asked with `overPatternsOnly` (WP-121 review round 1): this pass is outside the index queue's
   * one-job-per-project limit, so its write must never replace a reading an index run recorded
   * between its read and its write.
   */
  readonly refresh: (request: {
    readonly projectId: Id;
    readonly overPatternsOnly: true;
  }) => Promise<RepositoryConfigRefresh>;
  /**
   * TD-012 step 1's values for a failure reason, which is stored and published on `GET …/config`
   * and may quote `git`'s output (WP-121 review round 1): the project's credentials, as the reading
   * redacts its prompt files with. Required (rule 31).
   */
  readonly credentials: (projectId: Id) => Promise<ProjectBindingSecrets>;
  /** TD-012 step 2, after step 1. */
  readonly redactText: (value: string) => string;
  readonly logger: Logger;
  readonly limit?: number;
}

export interface PatternRereadPass {
  /** Projects whose reading is now `exact`. */
  readonly reread: readonly Id[];
  /** Projects that could not be read again: prompts withheld with the reason, mark kept. */
  readonly failed: readonly Id[];
  /** The pass took a full batch, so another may find more. */
  readonly more: boolean;
}

/** The record a reading that could not be read again is withheld with. */
export const patternRereadFailure = (cause: string): PromptsWithheld => ({
  reason: `${PATTERN_READING_WITHHELD_REASON}. It could not be read again: ${cause.slice(0, MAX_REREAD_FAILURE_CHARS)}`,
  integrations: [],
});

const failureOf = (outcome: RepositoryConfigRefresh): string | null => {
  // `superseded`: an index run or a refresh recorded an `exact` reading meanwhile — done.
  if (outcome.status === 'recorded' || outcome.status === 'superseded') return null;
  // WP-121 review round 2 (orchestrator): `stale` over a row with no `promptsWithheld` is an `exact`
  // reading somebody recorded before this pass read the row — the newer reading stands, so done.
  if (outcome.status === 'stale' && outcome.snapshot.promptsWithheld === undefined) return null;
  if (outcome.status === 'stale') {
    return `the default branch's head is older than the stored reading's commit ${outcome.snapshot.commitSha}`;
  }
  return outcome.reason;
};

/**
 * A failure's cause through both redaction steps (WP-121 review round 1), on one line. Fail closed:
 * when the project's credentials cannot all be read, the exact-value step is incomplete, so the
 * cause is not stored at all — only a sentence saying why it is not.
 */
const redactedCause = async (
  options: PatternRereadOptions,
  projectId: Id,
  cause: string,
): Promise<string> => {
  let credentials: ProjectBindingSecrets;
  try {
    credentials = await options.credentials(projectId);
  } catch {
    return CAUSE_NOT_RECORDED;
  }
  if (credentials.unreadable.length > 0) return CAUSE_NOT_RECORDED;
  const exact = bindingSecretRedactor(credentials.secrets).redactText(cause).value;
  return options.redactText(exact).replaceAll(/[\r\n\t]+/g, ' ');
};

const CAUSE_NOT_RECORDED =
  "(the cause is not recorded: the project's credentials could not all be read, so it could not be redacted against them)";

/**
 * One bounded pass: up to `limit` `patterns` projects, none of `excluding`, each read again.
 * A failure is recorded and named, never thrown — one unreadable repository must not stop the rest.
 */
export const rereadPatternReadings = async (
  options: PatternRereadOptions,
  excluding: readonly Id[],
): Promise<PatternRereadPass> => {
  const limit = options.limit ?? PATTERN_REREAD_BATCH;
  const projects = await options.store.patternReadings(limit, excluding);
  const reread: Id[] = [];
  const failed: Id[] = [];
  for (const projectId of projects) {
    let failure: string | null;
    try {
      failure = failureOf(await options.refresh({ projectId, overPatternsOnly: true }));
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    if (failure === null) {
      reread.push(projectId);
      continue;
    }
    failed.push(projectId);
    const withheld = patternRereadFailure(await redactedCause(options, projectId, failure));
    try {
      await options.store.withholdPatternReading(projectId, withheld);
    } catch (cause) {
      // The read side already serves nothing from a `patterns` row; what is lost is the reason.
      options.logger.error(
        { err: cause, project_id: projectId },
        'the reason a pattern-redacted reading could not be read again was not recorded; its prompt texts are still withheld',
      );
    }
    options.logger.warn(
      { project_id: projectId, reason: withheld.reason },
      'a repository reading stored before exact-value redaction could not be read again; its prompt texts are withheld until it is (TD-012, WP-121)',
    );
  }
  if (projects.length > 0) {
    options.logger.info(
      { reread: reread.length, failed: failed.length },
      'pattern-redacted repository readings read again',
    );
  }
  return { reread, failed, more: projects.length >= limit };
};

/** Between two passes, so a large installation's re-read does not monopolise the mirror. */
export const PATTERN_REREAD_PAUSE_MS = 1_000;

export interface PatternRereadLoop {
  /** Resolves when no `patterns` reading is left that this process has not tried, or on stop. */
  readonly settled: Promise<void>;
  /** Ends the loop after the re-read in progress, if any; idempotent. */
  stop(): Promise<void>;
}

/**
 * The passes, one after another, until a pass finds less than a full batch — started once by the
 * process that runs the index, and never again in its lifetime: the mark is set only by migration
 * 0073, so no row becomes `patterns` later.
 *
 * **It ends.** Every project a pass touched — re-read or failed — is excluded from every later pass
 * of this process, so each pass reads projects no earlier pass read, and the loop stops at the first
 * pass that is not full. A failure is retried by the next process start, the next index run or a
 * refresh, never by this loop. Its own failure (the store unreachable) is logged at `error` and ends
 * it: the read side already serves no prompt text from a `patterns` row, so nothing is lost but time.
 */
export const startPatternReadingReread = (
  options: PatternRereadOptions & { readonly pauseMs?: number },
): PatternRereadLoop => {
  let stopped = false;
  let wake: (() => void) | null = null;
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const settled = (async (): Promise<void> => {
    const touched: Id[] = [];
    try {
      while (!stopped) {
        const pass = await rereadPatternReadings(options, touched);
        touched.push(...pass.reread, ...pass.failed);
        if (!pass.more || stopped) return;
        await pause(options.pauseMs ?? PATTERN_REREAD_PAUSE_MS);
      }
    } catch (cause) {
      options.logger.error(
        { err: cause },
        'the re-read of pattern-redacted repository readings stopped; their prompt texts stay withheld until an index run or a refresh reads them (TD-012, WP-121)',
      );
    }
  })();
  return {
    settled,
    stop: async () => {
      stopped = true;
      (wake as (() => void) | null)?.();
      await settled;
    },
  };
};
