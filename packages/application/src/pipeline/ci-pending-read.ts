/**
 * **What the CI gate is waiting on, recorded** (backlog 1078).
 *
 * AUT-6655 on Autix (2026-11-06): GitLab pipeline 3038234623 was held at the manual job
 * `sentry-release-commit` on a draft merge request. `ci_gate` attempt 1 waited out its sixty-minute
 * CI timeout; the person pressed Retry, and attempt 2 waited **another** sixty minutes on the same
 * pipeline before escalating. The gate knew what it was waiting on at every read
 * (`pendingPipelineDetail`) and kept it nowhere: the read reached the database only as the timeout's
 * `return_reason`, so the task page could say nothing, and the second attempt could not know the
 * first had already seen the same held pipeline.
 *
 * So every pending read of the head pipeline — one neither passed nor failed, on a poll-only binding
 * or one a webhook reaches — is recorded on the open `ci_gate` attempt as {@link CiPendingRead}
 * (`task_stages.ci_pending_read`, migration 0107; the migration's header argues the column against
 * a table). A pending read that found no pipeline records `null`, so a stale read never outlives
 * the head it was about. A closed attempt keeps its last read. Two readers:
 *
 *  - the task-detail projection serves the open attempt's read as `gate_wait` ({@link toGateWait});
 *  - the next attempt's **first** read compares itself with the previous attempt's last read
 *    ({@link isUnchangedHeldRetry}): the same pipeline on the same head, `manual` both times, is a
 *    retry nobody acted on, and the gate escalates at once with {@link heldRetryBrief} instead of
 *    waiting the timeout out again. Any other status — the person started the job, so it is
 *    `running` — waits as before.
 *
 * Everything but the instants is **provider text** (BD-022) and is stored as the other untrusted
 * snapshots are: through the git binding's redactor, then bounded. An identity (the pipeline id) is
 * never cut or redacted into a different identity — a read whose id is too long or would need
 * redacting is not recorded at all; a URL is kept only as an `http(s)` URL with no credentials that
 * the redactor leaves unchanged (it is the `safeHref` rule applied at the write, so the DTO's
 * `httpUrlSchema` never has to refuse it).
 */
import {
  type CiManualNotRun,
  ciPipelineStatusSchema,
  type GateWait,
  httpUrlSchema,
  isoDateTimeSchema,
  MAX_CI_MANUAL_NOT_RUN_JOBS,
  MAX_GATE_WAIT_HELD_JOB_CHARS,
  nonEmptyStringSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';

/** The longest pipeline id a read records — an identity, so a longer one is not recorded, never cut. */
export const MAX_CI_READ_ID_CHARS = 255;

/** The longest provider URL a read keeps; a longer one is recorded as `null`. */
export const MAX_CI_READ_URL_CHARS = 2_048;

/** The pipeline half of a read, as the gate saw it — before the job stamps its instant. */
export const ciPipelineReadSchema = z.strictObject({
  pipeline_id: nonEmptyStringSchema.max(MAX_CI_READ_ID_CHARS),
  pipeline_url: httpUrlSchema.nullable(),
  /** The live head the gate read the pipeline for — what a retry's comparison keys on. */
  head_sha: nonEmptyStringSchema.max(MAX_CI_READ_ID_CHARS),
  status: ciPipelineStatusSchema,
  held_job: nonEmptyStringSchema.max(MAX_GATE_WAIT_HELD_JOB_CHARS).nullable(),
  held_job_url: httpUrlSchema.nullable(),
  draft: z.boolean(),
});
export type CiPipelineRead = z.infer<typeof ciPipelineReadSchema>;

/** `task_stages.ci_pending_read` — strict, parsed by its writer and by every reader. */
export const ciPendingReadSchema = ciPipelineReadSchema.extend({
  checked_at: isoDateTimeSchema,
  /** The CI timeout bounding this wait, or `null` on a binding a webhook reaches (five checks). */
  timeout_minutes: z.int().positive().nullable(),
});
export type CiPendingRead = z.infer<typeof ciPendingReadSchema>;

/** The redaction the gate applies to provider text: the git binding's `redactText(...).value`. */
export type RedactText = (text: string) => string;

/**
 * The job a pipeline is held at: the first `manual` job of a pipeline whose **own** status is
 * `manual` (backlog 486 — a `running` pipeline with a manual deploy job later is still running).
 * One choice for the pending detail's words and for the recorded `held_job`, so the two agree.
 *
 * `heldAt` (S-27.2) is the manual-job rule's own list (`judgeCiPipeline`'s `heldAt`: the jobs the
 * policy waits for first): when it names one, that is the job — so a pipeline held at an optional
 * release step **and** a manual test job says it waits for the test, not for the release step.
 */
export const heldManualJob = (
  status: Pick<PipelineStatus, 'status' | 'jobs'>,
  heldAt: readonly PipelineStatus['jobs'][number][] = [],
): PipelineStatus['jobs'][number] | undefined =>
  status.status === 'manual'
    ? (heldAt[0] ?? status.jobs.find((job) => job.status === 'manual'))
    : undefined;

/**
 * A provider URL as a read keeps it: an `http(s)` URL with no user or password, no longer than
 * {@link MAX_CI_READ_URL_CHARS}, that the redactor leaves unchanged — otherwise `null`. A redacted
 * URL is not the provider's URL any more, so it is dropped rather than stored half-redacted.
 */
export const safeProviderUrl = (
  value: string | null | undefined,
  redact: RedactText,
): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CI_READ_URL_CHARS) {
    return null;
  }
  if (redact(value) !== value || !httpUrlSchema.safeParse(value).success) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '' ? value : null;
  } catch {
    return null;
  }
};

/**
 * The read the gate records for a pending head pipeline, or `null` when its identity cannot be
 * recorded as the provider sent it (too long, or text the redactor would change).
 */
export const ciPipelineReadOf = (
  status: Pick<PipelineStatus, 'id' | 'status' | 'url' | 'jobs'>,
  facts: {
    readonly headSha: string;
    readonly draft: boolean;
    readonly redact: RedactText;
    /** S-27.2: the manual-job rule's `heldAt`, so the recorded job is the one the wait is for. */
    readonly heldAt?: readonly PipelineStatus['jobs'][number][];
  },
): CiPipelineRead | null => {
  const { redact } = facts;
  if (
    status.id.length > MAX_CI_READ_ID_CHARS ||
    redact(status.id) !== status.id ||
    facts.headSha.length > MAX_CI_READ_ID_CHARS
  ) {
    return null;
  }
  const held = heldManualJob(status, facts.heldAt);
  // Redacted first and cut after: a cut first could split a secret the redactor then cannot see.
  const heldName =
    held === undefined ? '' : redact(held.name).slice(0, MAX_GATE_WAIT_HELD_JOB_CHARS);
  return {
    pipeline_id: status.id,
    pipeline_url: safeProviderUrl(status.url, redact),
    head_sha: facts.headSha,
    status: status.status,
    held_job: heldName.length === 0 ? null : heldName,
    held_job_url: held === undefined ? null : safeProviderUrl(held.web_url, redact),
    draft: facts.draft,
  };
};

/** A job's name or stage as a record keeps it: redacted first, then cut; `null` when nothing is left. */
const boundedProviderText = (value: string | null, redact: RedactText): string | null => {
  if (value === null) {
    return null;
  }
  const kept = redact(value).slice(0, MAX_GATE_WAIT_HELD_JOB_CHARS);
  return kept.length === 0 ? null : kept;
};

/**
 * **What a CI pass left unstarted** (S-27.2, TD-036 decision 5): `task_stages.ci_manual_not_run`
 * for a pass whose pipeline still holds the blocking manual jobs `notRun`, or `null` when there are
 * none — or when the pipeline's identity cannot be recorded as the provider sent it (the same rule
 * as {@link ciPipelineReadOf}: an identity is never cut or redacted into another). Names and stages
 * are redacted then bounded, URLs kept only as {@link safeProviderUrl} keeps them; at most
 * {@link MAX_CI_MANUAL_NOT_RUN_JOBS} jobs, in the pipeline's order. A job whose redacted name is
 * empty is not listed (a name is the one thing a person reads it by).
 */
export const ciManualNotRunOf = (
  status: Pick<PipelineStatus, 'id' | 'status' | 'url'>,
  notRun: readonly Pick<PipelineStatus['jobs'][number], 'name' | 'stage' | 'web_url'>[],
  facts: { readonly redact: RedactText; readonly checkedAt: string },
): CiManualNotRun | null => {
  const { redact } = facts;
  if (status.id.length > MAX_CI_READ_ID_CHARS || redact(status.id) !== status.id) {
    return null;
  }
  const jobs = notRun
    .map((job) => ({
      name: boundedProviderText(job.name, redact),
      stage: boundedProviderText(job.stage, redact),
      url: safeProviderUrl(job.web_url, redact),
    }))
    .filter(
      (job): job is { name: string; stage: string | null; url: string | null } => job.name !== null,
    )
    .slice(0, MAX_CI_MANUAL_NOT_RUN_JOBS);
  if (jobs.length === 0) {
    return null;
  }
  return {
    pipeline_id: status.id,
    pipeline_url: safeProviderUrl(status.url, redact),
    pipeline_status: status.status,
    jobs,
    checked_at: facts.checkedAt,
  };
};

/**
 * **A retry nobody acted on** (backlog 1078 criterion 3): this attempt's first read shows the same
 * pipeline, on the same head, still `manual` **at the same job**, as the previous attempt's last
 * read. Any other status now — `running`, because the person started the job — a different
 * pipeline or head, or the same pipeline now held at a later manual job (the person started job A
 * and it stopped at job B: something moved) is a wait like any other.
 */
export const isUnchangedHeldRetry = (
  previous: CiPendingRead | null,
  current: CiPipelineRead,
): boolean =>
  previous !== null &&
  previous.status === 'manual' &&
  current.status === 'manual' &&
  previous.pipeline_id === current.pipeline_id &&
  previous.head_sha === current.head_sha &&
  previous.held_job === current.held_job;

const heldAt = (read: CiPipelineRead): string =>
  read.held_job === null ? 'a manual job' : `the manual job ${JSON.stringify(read.held_job)}`;

/** The escalation's reason for {@link isUnchangedHeldRetry} — what the row and `task.escalated` carry. */
export const heldRetryReason = (read: CiPipelineRead): string =>
  `the CI gate's new attempt read pipeline ${read.pipeline_id} still held at ${heldAt(read)} on the same head commit as the previous attempt's last read, so it did not wait for it again`;

/**
 * The brief a person reads for {@link isUnchangedHeldRetry}: the pipeline is still held at that job,
 * and what to do about it. `provider` is the provider's name as people know it (`GitLab`), which
 * the binding carries from its registration (`GitBinding.providerName`; BD-017: the pipeline does
 * not know which provider it talks to).
 */
export const heldRetryBrief = (read: CiPipelineRead, provider: string): string =>
  `The CI pipeline ${read.pipeline_id} for this merge request is still held at ${heldAt(read)} — the same pipeline on the same head commit the previous attempt waited on, so the gate did not wait for it again. ` +
  `Start the job on ${provider}, or change the job's rule so it runs without a person, then Retry.`;

/** The DTO's `gate_wait` for an open attempt's read, timed from the attempt's entry. */
export const toGateWait = (read: CiPendingRead, waitingSince: string): GateWait => ({
  pipeline_id: read.pipeline_id,
  pipeline_url: read.pipeline_url,
  status: read.status,
  held_job: read.held_job,
  held_job_url: read.held_job_url,
  draft: read.draft,
  checked_at: read.checked_at,
  waiting_since: waitingSince,
  timeout_minutes: read.timeout_minutes,
});
