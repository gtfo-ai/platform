/**
 * **While CI waits, it says what it is waiting for** (S-25.12, product/10's Task detail amendments
 * of 2026-11-07; AUT-6655 on Autix: GitLab held the pipeline of a draft merge request at the manual
 * job `sentry-release-commit`, the platform waited 60 minutes twice, and the page showed only "CI"
 * and *Needs you*).
 *
 * Everything here is built from the CI check's **structured read** (`gateWaitSchema`, the worker
 * session's #89): `gate_wait` while the wait is open, `last_gate_wait` on the attempt an escalation
 * came from. Never from the sentence the platform recorded — that is the fallback the callout keeps
 * for an attempt with no read (any attempt before #89), introduced as *What the platform saw last:*.
 *
 * Three readers, one module:
 *
 * - **{@link GateWaitNotice}** — the open wait, in the callout's slot: a pipeline **held at a manual
 *   job** ("CI is waiting for someone to start the manual job X in GitLab. Start it there and the
 *   task continues.") — *Needs you* at once, through `ui/task-status.ts`' one rule
 *   ({@link gateWaitHeld} is its input) — or a pipeline **still running** ("CI is running (pipeline
 *   n, 12 min so far; the task gives up after 60)"), which asks nothing;
 * - **{@link gateWaitShort}** — the header's *Now* line, in short form;
 * - **{@link CiWaitStop}** — the parked wait: a timeout ("CI did not finish within 60 minutes:
 *   pipeline n was still held at the manual job X.") or a Retry that found the same held pipeline
 *   ("…so Retry did not wait again."). Neither reads as a failure, because nothing failed.
 *
 * Every provider string — the pipeline's id, the job's name, the URLs — is untrusted (BD-022): the
 * names are text nodes (`UntrustedText`, or an `ExternalLink`'s label), and the URLs go through
 * `safeHref` inside {@link ExternalLink}. The job is linked by `held_job_url`, falling back to the
 * pipeline's `pipeline_url`.
 *
 * The words live here rather than in `ui/humanize.ts`, which the remote worker's page imports too
 * (BACKLOG 1299): this module is the task page's only, so its sentences cost that page nothing.
 */
import type { GateWait, TaskStop } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';

/** The provider's display name; one this build does not name is said generically. */
const PROVIDER_LABEL: Readonly<Record<string, string>> = { gitlab: 'GitLab', github: 'GitHub' };

/** "GitLab" for the merge request's provider id, "the git provider" for any other. */
export const providerName = (provider: string | null | undefined): string =>
  provider !== null && provider !== undefined && Object.hasOwn(PROVIDER_LABEL, provider)
    ? (PROVIDER_LABEL[provider] as string)
    : 'the git provider';

/**
 * A pipeline held at a manual job waits for a person, and only for a person — the input
 * `ui/task-status.ts`' `needsYou` reads as `ci_held`.
 */
export const gateWaitHeld = (wait: GateWait | null | undefined): boolean =>
  wait !== null && wait !== undefined && wait.status === 'manual';

/** Where a person starts the held job: the job's own page, else the pipeline's, else nowhere. */
export const gateWaitJobUrl = (wait: GateWait): string | null =>
  wait.held_job_url ?? wait.pipeline_url;

/**
 * Whole minutes the check has waited: from `waiting_since` (the attempt's entry, which the CI
 * timeout counts from) to `nowMs`, or to the read's own `checked_at` when no clock is given.
 */
export const gateWaitMinutes = (wait: GateWait, nowMs?: number): number => {
  const until = nowMs ?? Date.parse(wait.checked_at);
  const since = Date.parse(wait.waiting_since);
  return Number.isFinite(until) && Number.isFinite(since)
    ? Math.max(0, Math.floor((until - since) / 60_000))
    : 0;
};

/** "12 min so far; the task gives up after 60" — no second half when the wait has no timeout. */
export const gateWaitTime = (wait: GateWait, nowMs?: number): string =>
  `${gateWaitMinutes(wait, nowMs)} min so far${wait.timeout_minutes === null ? '' : `; the task gives up after ${wait.timeout_minutes}`}`;

/** The pipeline's state as the running sentence says it. */
const runningWord = (wait: GateWait): string => (wait.status === 'pending' ? 'queued' : 'running');

/**
 * The header's *Now* line: "CI waits for someone to start the manual job X", or "CI running ·
 * 12 min of 60". Provider text inside: the header renders it as a text node.
 */
export const gateWaitShort = (wait: GateWait, nowMs?: number): string => {
  if (gateWaitHeld(wait)) {
    return wait.held_job === null
      ? 'CI waits for someone to start a manual job'
      : `CI waits for someone to start the manual job ${wait.held_job}`;
  }
  const minutes = gateWaitMinutes(wait, nowMs);
  return `CI ${runningWord(wait)} · ${minutes} min${wait.timeout_minutes === null ? '' : ` of ${wait.timeout_minutes}`}`;
};

const LINK = 'text-link underline';

/** "pipeline 41" (or "Pipeline 41"), linked when its URL is known; the id is provider text. */
const PipelineName = ({
  wait,
  capital = false,
}: {
  readonly wait: GateWait;
  readonly capital?: boolean;
}): ReactElement => {
  const label = `${capital ? 'Pipeline' : 'pipeline'} ${wait.pipeline_id}`;
  return wait.pipeline_url === null ? (
    <UntrustedText value={label} />
  ) : (
    <ExternalLink url={wait.pipeline_url} label={label} className={LINK} />
  );
};

/** "the manual job X", linked by the job's URL, else the pipeline's; "a manual job" unnamed. */
const HeldJob = ({ wait }: { readonly wait: GateWait }): ReactElement => {
  if (wait.held_job === null) {
    return <>a manual job</>;
  }
  const url = gateWaitJobUrl(wait);
  return (
    <>
      the manual job{' '}
      {url === null ? (
        <UntrustedText value={wait.held_job} />
      ) : (
        <ExternalLink url={url} label={wait.held_job} className={LINK} />
      )}
    </>
  );
};

/**
 * The draft note (product/10: the platform keeps the merge request a draft, and a project whose CI
 * rules hold jobs for drafts has a CI-rules warning on its readiness), linked to that panel when
 * the page knows the project's key.
 */
const DraftNote = ({ projectKey }: { readonly projectKey: string | null }): ReactElement => (
  <p className="text-xs text-fg-muted" data-gate-wait-draft="">
    The merge request is still a draft: the platform keeps it one until the task is ready. If this
    project’s CI rules hold jobs for drafts, its readiness shows a CI-rules warning
    {projectKey === null ? (
      '.'
    ) : (
      <>
        {' '}
        in{' '}
        <Link
          to="/projects/$key/settings/$section"
          params={{ key: projectKey, section: 'discovery' }}
          className="text-accent underline underline-offset-2"
        >
          Discovery & readiness
        </Link>
        .
      </>
    )}
  </p>
);

/** The open wait, in the callout's slot: held at a manual job, or still running. */
export const GateWaitNotice = ({
  wait,
  provider,
  projectKey,
  nowMs,
}: {
  readonly wait: GateWait;
  /** The merge request's provider id (`gitlab`), for "in GitLab". */
  readonly provider: string | null;
  /** The board's key, when the page has it: the draft note's link. */
  readonly projectKey: string | null;
  readonly nowMs?: number;
}): ReactElement => {
  if (gateWaitHeld(wait)) {
    return (
      <div data-gate-wait="held" className="flex flex-col gap-1">
        <p data-gate-wait-sentence="">
          CI is waiting for someone to start <HeldJob wait={wait} /> in {providerName(provider)}.
          Start it there and the task continues.
        </p>
        <p className="text-xs text-fg-muted" data-gate-wait-time="">
          <PipelineName wait={wait} capital /> · {gateWaitTime(wait, nowMs)}.
        </p>
        {wait.draft ? <DraftNote projectKey={projectKey} /> : null}
      </div>
    );
  }
  return (
    <p data-gate-wait="running">
      CI is {runningWord(wait)} (<PipelineName wait={wait} />, {gateWaitTime(wait, nowMs)}).
    </p>
  );
};

/** What the read found when the wait ended: held, still running, or not yet started. */
const lastState = (read: GateWait): ReactNode =>
  gateWaitHeld(read) ? (
    <>
      was still held at <HeldJob wait={read} />
    </>
  ) : read.status === 'pending' ? (
    'had still not started'
  ) : (
    'was still running'
  );

/**
 * The parked wait, from `last_gate_wait` — rendered in the callout in place of the sentence-based
 * stop, for a `no_answer` at the CI check whose attempt recorded a read:
 *
 * - `ci_held_unchanged` — "The pipeline is still held at the manual job X, so Retry did not wait
 *   again." Then: start the job, or change its rule, then Retry;
 * - anything else (`ci_timed_out`, or a no-answer the row did not name) — "CI did not finish within
 *   N minutes: pipeline n was still held at the manual job X." (or "was still running"). With no
 *   timeout on the read, "in the time the platform waits for it".
 */
export const CiWaitStop = ({
  stop,
  read,
  provider,
}: {
  readonly stop: TaskStop;
  readonly read: GateWait;
  readonly provider: string | null;
}): ReactElement => {
  const where = providerName(provider);
  const held = gateWaitHeld(read);
  const unchanged = stop.ci_ending === 'ci_held_unchanged';
  return (
    <div
      className="flex flex-col gap-1"
      data-stop={stop.cause}
      data-ci-ending={stop.ci_ending ?? 'none'}
    >
      {unchanged ? (
        <>
          <p data-stop-sentence="">
            The pipeline is still held at <HeldJob wait={read} />, so Retry did not wait again.
          </p>
          <p data-stop-next="">Start the job in {where}, or change its rule, then Retry.</p>
        </>
      ) : (
        <>
          <p data-stop-sentence="">
            {read.timeout_minutes === null
              ? 'CI did not finish in the time the platform waits for it'
              : `CI did not finish within ${read.timeout_minutes} minutes`}
            : <PipelineName wait={read} /> {lastState(read)}.
          </p>
          <p data-stop-next="">
            {held
              ? `Start the job in ${where}, then Retry.`
              : `Look at the pipeline in ${where}; once it has finished, Retry.`}
          </p>
        </>
      )}
    </div>
  );
};
