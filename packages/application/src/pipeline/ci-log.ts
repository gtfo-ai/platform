/**
 * **The failing job's log, as a failed CI gate hands it back** — WP-81, BD-024 §5 (*"CI logs are
 * reduced to the failing job's error block before being fed back"*) and product/04 S4 (*"the failing
 * job's error block only … head/tail truncated"*). Q55's remaining half.
 *
 * ## The order is the obligation
 *
 * 1. **Read** the log through `getJobLog` (`gitReads.jobLog`, through `IntegrationActionExecutor`,
 *    outside every transaction). The adapter has already redacted what it returns and kept at most
 *    its own tail bound (GitLab: 1 MiB) — a cut the port does not report, so a log that long is
 *    always cut again here and the cut is announced either way.
 * 2. **Redact the whole text** with the git binding's redactor — TD-012's two steps plus every
 *    minted-credential shape this process knows (WP-80) — **before** anything is cut: a cut first
 *    leaves a token's leading bytes in the string, and an exact-match rule can never find them
 *    again (`getJobLog`'s port docblock states the same order for the adapter).
 * 3. **Bound** it to its head and its tail ({@link CI_LOG_HEAD_CHARS}, {@link CI_LOG_TAIL_CHARS}).
 *    The error block of a failing job is almost always in the tail and its command and setup in the
 *    head; the middle is the progress noise product/04 asks to drop. The cut is **reported**, never
 *    written into the text: the caller records the uncut length beside the stored reason and the
 *    prompt's `return_feedback` marker announces it (`truncated="true"`, technical/07's
 *    forgeable-marker rule) — so there is no `[… cut …]` line a log could forge.
 *
 * ## What it says when it cannot read a log
 *
 * A job with no log reference, a provider that answers `not_found`, or any other refusal is
 * **stated** in the reason (standing rule 20: an empty excerpt must never stand in for a log nobody
 * read). The CI verdict does not depend on the log, so an unreadable log never changes whether the
 * gate failed — only what the next run is told about it. A `TransactionOpenError` or any other
 * programming error is not a provider being down and propagates.
 *
 * ## Which job
 *
 * The **first** failing job the pipeline lists that is not allowed to fail and names a log. One log
 * per return keeps the reason inside the prompt's `MAX_FEEDBACK_CHARS` with room for the platform's own
 * sentence and the job names; every failing job is still **named** in that sentence.
 */
import type { Id } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import { gitReads, type PipelineIntegrations } from './integrations.js';

type PipelineJob = PipelineStatus['jobs'][number];

/** The head kept of a failing job's log: the command that ran and what it printed first. */
export const CI_LOG_HEAD_CHARS = 1_500;
/**
 * The tail kept: where a test runner, a compiler or a linter prints the error block.
 *
 * The two are chosen **inside** the prompt's own cap (`MAX_FEEDBACK_CHARS`, 8 000), leaving 2 000
 * for the platform's sentence, the job names and the tamper paths, so the assembler does not cut a
 * CI reason a second time — held by `ci-log.test.ts` rather than by this sentence.
 */
export const CI_LOG_TAIL_CHARS = 4_500;

export interface BoundedLog {
  /** The kept text: the whole log, or its head and its tail joined by one newline. */
  readonly text: string;
  /** The redacted log's length before the cut, or `null` when nothing was cut. */
  readonly originalChars: number | null;
}

/** Keeps the head and the tail of an already-redacted log; pure, so each edge is unit-tested. */
export const boundLog = (
  redacted: string,
  head: number = CI_LOG_HEAD_CHARS,
  tail: number = CI_LOG_TAIL_CHARS,
): BoundedLog =>
  redacted.length <= head + tail
    ? { text: redacted, originalChars: null }
    : {
        text: `${redacted.slice(0, head)}\n${redacted.slice(redacted.length - tail)}`,
        originalChars: redacted.length,
      };

export type FailingJobLog =
  /** The log was read, redacted and bounded. */
  | {
      readonly kind: 'read';
      readonly job: string;
      readonly text: string;
      /** The redacted log's length before the bound, or `null` when it fitted. */
      readonly originalChars: number | null;
    }
  /** No log could be read, and why — stated in the reason rather than left out. */
  | { readonly kind: 'unreadable'; readonly job: string | null; readonly why: string };

/** The job whose log a failed gate reads: the first failing, not-allowed-to-fail job with a log. */
export const failingJobWithLog = (
  jobs: readonly Pick<PipelineJob, 'name' | 'status' | 'allow_failure' | 'log_ref'>[],
): { readonly name: string; readonly logRef: string | null } | null => {
  const failing = jobs.filter((job) => job.status === 'failed' && !job.allow_failure);
  const withLog = failing.find((job) => (job.log_ref ?? null) !== null);
  if (withLog !== undefined) {
    return { name: withLog.name, logRef: withLog.log_ref as string };
  }
  const first = failing[0];
  return first === undefined ? null : { name: first.name, logRef: null };
};

/**
 * Reads, redacts and bounds the log of `job` — in that order (the module docblock).
 *
 * `integrations.git` is the binding the gate already checked; with none, the answer is
 * `unreadable` rather than a throw, because the gate's verdict is already decided.
 */
export const readFailingJobLog = async (
  integrations: PipelineIntegrations,
  job: { readonly name: string; readonly logRef: string | null } | null,
  context: { readonly projectId: Id; readonly taskId: Id },
): Promise<FailingJobLog> => {
  if (job === null) {
    return {
      kind: 'unreadable',
      job: null,
      why: 'no failing job was named, so no log was read',
    };
  }
  if (job.logRef === null) {
    return { kind: 'unreadable', job: job.name, why: 'the provider names no log for this job' };
  }
  const git = integrations.git;
  if (git === null) {
    return { kind: 'unreadable', job: job.name, why: 'the project has no git binding' };
  }
  let raw: string | null;
  try {
    raw = await gitReads(integrations).jobLog(job.logRef, context);
  } catch (error) {
    if (!(error instanceof IntegrationError)) {
      throw error;
    }
    return {
      kind: 'unreadable',
      job: job.name,
      why: `the provider refused the log (${error.code})`,
    };
  }
  if (raw === null) {
    return { kind: 'unreadable', job: job.name, why: 'the project has no git binding' };
  }
  const redacted = git.redactor.redactText(raw).value;
  if (redacted.trim().length === 0) {
    return { kind: 'unreadable', job: job.name, why: 'the provider returned an empty log' };
  }
  const bounded = boundLog(redacted);
  return {
    kind: 'read',
    job: job.name,
    text: bounded.text,
    originalChars: bounded.originalChars,
  };
};
