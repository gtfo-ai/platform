/**
 * **The failing jobs' logs, as a failed CI gate hands them back** — WP-81, BD-024 §5 (*"CI logs are
 * reduced to the failing job's error block before being fed back"*) and product/04 S4 (*"the failing
 * job's error block only … head/tail truncated"*). Q55's remaining half; every failing job since
 * PROGRESS backlog 485.
 *
 * ## The order is the obligation
 *
 * 1. **Read** each log through `getJobLog` (`gitReads.jobLog`, through `IntegrationActionExecutor`,
 *    outside every transaction — so each read is audited and counted against the binding's rate
 *    limit like any other). The adapter has already redacted what it returns and kept at most its
 *    own tail bound (GitLab: 1 MiB) — a cut the port does not report, so a log that long is always
 *    cut again here and the cut is announced either way.
 * 2. **Redact the whole text** with the git binding's redactor — TD-012's two steps plus every
 *    minted-credential shape this process knows (WP-80) — **before** anything is cut: a cut first
 *    leaves a token's leading bytes in the string, and an exact-match rule can never find them
 *    again (`getJobLog`'s port docblock states the same order for the adapter).
 * 3. **Bound** it to its share of {@link CI_LOG_BUDGET_CHARS} ({@link splitLogBudget}) and keep the
 *    **end** of it first ({@link boundLog}): the error block of a failing job is almost always in
 *    the tail; a head (the command and its setup) is kept only from a share larger than
 *    {@link CI_LOG_TAIL_CHARS}. The middle is the progress noise product/04 asks to drop. The cut is
 *    **reported**, never written into the text: the caller records the uncut length beside the
 *    stored reason and the prompt's `return_feedback` marker announces it (`truncated="true"`,
 *    technical/07's forgeable-marker rule) — so there is no `[… cut …]` line a log could forge.
 *
 * ## Which jobs (backlog 485)
 *
 * **Every** failing job the pipeline lists that is not allowed to fail, in the pipeline's order, up
 * to {@link MAX_CI_LOG_JOBS} — the jobs that name a log chosen before the ones that do not, so a cap
 * spends no slot on a job with nothing to read. Until backlog 485 only the **first** such job's log
 * was read: AUT-6820's pipeline failed `phpstan`, `db-schema-consistency` and `codesniffer`, the next
 * Developer run was given phpstan's log alone, and the project (`verification.mode: ci`, no PHP in
 * the run image) had no way to run the other two. The jobs past the cap are **named** as not
 * included, by the caller.
 *
 * ## What it says when it cannot read a log
 *
 * A job with no log reference, a provider that answers `not_found`, or any other refusal is
 * **stated** per job, by name (standing rule 20: an empty excerpt must never stand in for a log
 * nobody read); its share of the budget goes to the logs that were read. The CI verdict does not
 * depend on the logs, so an unreadable log never changes whether the gate failed — only what the
 * next run is told about it. A `TransactionOpenError` or any other programming error is not a
 * provider being down and propagates.
 */
import type { Id } from '@platform/contracts';
import { IntegrationError } from '../ports/integrations/common.js';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import { gitReads, type PipelineIntegrations } from './integrations.js';

type PipelineJob = PipelineStatus['jobs'][number];

/** The head a job's log keeps when its share allows one: the command that ran, and its setup. */
export const CI_LOG_HEAD_CHARS = 1_500;
/** The tail a job's log keeps first: where a test runner, a compiler or a linter prints its errors. */
export const CI_LOG_TAIL_CHARS = 4_500;
/**
 * The characters of log every failing job **together** may hand back — one job's head and tail, as
 * WP-81 sized it, now split between the jobs (backlog 485) rather than multiplied by them.
 *
 * Chosen **inside** the prompt's own cap (`MAX_FEEDBACK_CHARS`, 8 000), leaving 2 000 for the
 * platform's sentences, the job names, one label per job and the tamper paths, so the assembler does
 * not cut a CI reason a second time — held by `ci-log.test.ts` rather than by this sentence.
 */
export const CI_LOG_BUDGET_CHARS = CI_LOG_HEAD_CHARS + CI_LOG_TAIL_CHARS;
/**
 * The most failing jobs whose logs one return reads (backlog 485). Five keeps each read log's
 * guaranteed share at {@link CI_LOG_MIN_SHARE_CHARS} — room for a linter's or a type checker's
 * summary — and five provider reads per settlement; the jobs past it are named as not included.
 */
export const MAX_CI_LOG_JOBS = 5;
/** The share every read log is guaranteed, however many failed: the budget split evenly at the cap. */
export const CI_LOG_MIN_SHARE_CHARS = Math.floor(CI_LOG_BUDGET_CHARS / MAX_CI_LOG_JOBS);

export interface BoundedLog {
  /** The kept text: the whole log, its tail, or its head and its tail joined by one newline. */
  readonly text: string;
  /** The redacted log's length before the cut, or `null` when nothing was cut. */
  readonly originalChars: number | null;
}

/**
 * Keeps about `allowance` characters of an already-redacted log, **the end first** (backlog 485):
 * the tail takes the allowance up to {@link CI_LOG_TAIL_CHARS}, and only a share past that keeps a
 * head, up to {@link CI_LOG_HEAD_CHARS}, the tail taking any remainder. A single job's whole budget
 * therefore keeps WP-81's 1 500 + 4 500 (joined by one newline); a share of 2 000 keeps the last
 * 2 000. Pure, so each edge is unit-tested.
 */
export const boundLog = (redacted: string, allowance: number = CI_LOG_BUDGET_CHARS): BoundedLog => {
  if (redacted.length <= allowance) {
    return { text: redacted, originalChars: null };
  }
  const head = Math.min(CI_LOG_HEAD_CHARS, Math.max(0, allowance - CI_LOG_TAIL_CHARS));
  const tail = redacted.slice(redacted.length - (allowance - head));
  return {
    text: head === 0 ? tail : `${redacted.slice(0, head)}\n${tail}`,
    originalChars: redacted.length,
  };
};

/**
 * Splits `budget` between logs of the given lengths, **max-min fair** (backlog 485): each log gets
 * an even share of what is left, and a log shorter than its share keeps itself whole and leaves the
 * rest to the longer ones. So no log gets less than `floor(budget / lengths.length)` unless it is
 * shorter than that, and the shares never sum past the budget. Pure; answered in the input's order.
 */
export const splitLogBudget = (lengths: readonly number[], budget: number): readonly number[] => {
  const shares = lengths.map(() => 0);
  const shortestFirst = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => a.length - b.length);
  let left = budget;
  shortestFirst.forEach(({ length, index }, position) => {
    const share = Math.min(length, Math.floor(left / (shortestFirst.length - position)));
    shares[index] = share;
    left -= share;
  });
  return shares;
};

/** A failing job as the gate names it: its name, and the provider's opaque handle for its log. */
export interface FailingJobRef {
  readonly name: string;
  readonly logRef: string | null;
}

type UnreadableLog = {
  readonly kind: 'unreadable';
  readonly job: string;
  readonly why: string;
};

export type FailingJobLog =
  /** The log was read, redacted and bounded. */
  | {
      readonly kind: 'read';
      readonly job: string;
      readonly text: string;
      /** The redacted log's length before the bound, or `null` when it fitted its share. */
      readonly originalChars: number | null;
    }
  /** No log could be read, and why — stated in the reason by the job's name rather than left out. */
  | UnreadableLog;

export interface FailingJobLogs {
  /** One entry per job read or tried, in the pipeline's order; empty when no failing job was named. */
  readonly logs: readonly FailingJobLog[];
  /** The failing jobs past {@link MAX_CI_LOG_JOBS}, by name, whose logs were not read. */
  readonly omitted: readonly string[];
}

/** Every failing job a failed gate explains: failed, not allowed to fail, in the pipeline's order. */
export const failingJobs = (
  jobs: readonly Pick<PipelineJob, 'name' | 'status' | 'allow_failure' | 'log_ref'>[],
): readonly FailingJobRef[] =>
  jobs
    .filter((job) => job.status === 'failed' && !job.allow_failure)
    .map((job) => ({ name: job.name, logRef: job.log_ref ?? null }));

/**
 * The jobs whose logs are read — at most {@link MAX_CI_LOG_JOBS}, the ones naming a log first — and
 * the names of the rest. Both lists keep the pipeline's order.
 */
export const selectLogJobs = (
  jobs: readonly FailingJobRef[],
): { readonly read: readonly FailingJobRef[]; readonly omitted: readonly string[] } => {
  const chosen = new Set(
    [
      ...jobs.filter((job) => job.logRef !== null),
      ...jobs.filter((job) => job.logRef === null),
    ].slice(0, MAX_CI_LOG_JOBS),
  );
  return {
    read: jobs.filter((job) => chosen.has(job)),
    omitted: jobs.filter((job) => !chosen.has(job)).map((job) => job.name),
  };
};

type RedactedLog =
  | { readonly kind: 'redacted'; readonly job: string; readonly text: string }
  | UnreadableLog;

/** Reads and redacts one job's log, whole — nothing is cut yet (the module docblock's steps 1–2). */
const readRedacted = async (
  integrations: PipelineIntegrations,
  job: FailingJobRef,
  context: { readonly projectId: Id; readonly taskId: Id },
): Promise<RedactedLog> => {
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
  return { kind: 'redacted', job: job.name, text: redacted };
};

/**
 * Reads, redacts and bounds the logs of the failing `jobs` — in that order, every log redacted whole
 * before any is cut (the module docblock). The reads are sequential: each is a provider call through
 * the executor, counted against the binding's rate limit, and a burst buys a settlement nothing.
 *
 * `integrations.git` is the binding the gate already checked; with none, each job is `unreadable`
 * rather than a throw, because the gate's verdict is already decided.
 */
export const readFailingJobLogs = async (
  integrations: PipelineIntegrations,
  jobs: readonly FailingJobRef[],
  context: { readonly projectId: Id; readonly taskId: Id },
): Promise<FailingJobLogs> => {
  const { read, omitted } = selectLogJobs(jobs);
  const redacted: RedactedLog[] = [];
  for (const job of read) {
    redacted.push(await readRedacted(integrations, job, context));
  }
  const shares = splitLogBudget(
    redacted.map((log) => (log.kind === 'redacted' ? log.text.length : 0)),
    CI_LOG_BUDGET_CHARS,
  );
  return {
    logs: redacted.map((log, index): FailingJobLog => {
      if (log.kind === 'unreadable') {
        return log;
      }
      const bounded = boundLog(log.text, shares[index] ?? 0);
      return {
        kind: 'read',
        job: log.job,
        text: bounded.text,
        originalChars: bounded.originalChars,
      };
    }),
    omitted,
  };
};
