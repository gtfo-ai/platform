/**
 * **While CI waits, it says what it is waiting for** (S-25.11 step (2b), product/10's Task detail
 * amendment of 2026-11-07, AUT-6655 on Autix: GitLab held the pipeline at a manual job, the platform
 * waited 60 minutes twice, and the page showed only "CI" and *Needs you*).
 *
 * **Rendered nowhere yet, on purpose.** Nothing persists the CI gate's pending read today —
 * `waitForPollOnlyCi` (`packages/application/src/pipeline/jobs.ts`) re-enqueues the job and the read
 * reaches the database only as `task_stages.return_reason` at the timeout — so the task read has no
 * field this could be wired to. The worker session's pending-read slice adds a nullable `gate_wait`
 * to the task read (BACKLOG 1078, PR #78); until it lands, {@link GateWait} is this module's own
 * shape, **not** a contract, and wiring it is BACKLOG 1293. Nothing imports it outside its test, so
 * it is in no bundle.
 *
 * Two states, the amendment's:
 *
 * - **held at a manual job** — a person's action is the only way forward, so it is *Needs you* at
 *   once ({@link gateWaitNeedsYou}) with the one next step: start the job on the provider. The job is
 *   linked by name through `safeHref` when its URL is known, else the pipeline is;
 * - **anything else** — "CI is running (pipeline n, 12 min so far; the task gives up after 60)".
 *
 * Every provider string (the job's name, the URLs) is untrusted (BD-022): the name is a text node,
 * the URLs go through {@link ExternalLink}.
 */
import type { ReactElement } from 'react';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';

/** The CI gate's last pending read — the shape the worker session's `gate_wait` is expected to have. */
export interface GateWait {
  /** The pipeline's id on the provider, or `null` when no pipeline has started for the head. */
  readonly pipeline_id: string | null;
  /** The pipeline's web URL (http(s) only, or `null`). */
  readonly pipeline_url: string | null;
  /** The pipeline's status as the platform maps it (`running`, `pending`, `manual`, …). */
  readonly status: string | null;
  /** The manual job the pipeline is held at, when it is; provider text. */
  readonly held_job: string | null;
  /** That job's own web URL (http(s) only, or `null`). */
  readonly held_job_url: string | null;
  /** The provider's name as the platform knows it (`gitlab`, `github`). */
  readonly provider: string | null;
  /** Whole minutes since the check began waiting. */
  readonly waited_minutes: number;
  /** When the platform stops waiting, or `null` when it waits by checks rather than by time. */
  readonly timeout_minutes: number | null;
  /** The merge request is still a draft (the platform keeps it one until Ready). */
  readonly draft: boolean;
}

/** The provider's display name; an unknown one is said generically rather than printed raw. */
const PROVIDER_LABEL: Readonly<Record<string, string>> = { gitlab: 'GitLab', github: 'GitHub' };

const providerOf = (wait: GateWait): string =>
  wait.provider !== null && Object.hasOwn(PROVIDER_LABEL, wait.provider)
    ? (PROVIDER_LABEL[wait.provider] as string)
    : 'the provider';

/** A pipeline held at a manual job waits for a person, and only for a person. */
export const gateWaitNeedsYou = (wait: GateWait): boolean => wait.status === 'manual';

/** "12 min so far; the task gives up after 60" — the time half of the sentence. */
export const gateWaitTime = (wait: GateWait): string =>
  `${wait.waited_minutes} min so far${wait.timeout_minutes === null ? '' : `; the task gives up after ${wait.timeout_minutes}`}`;

/** The pipeline's name as a link when its URL is known. */
const PipelineName = ({ wait }: { readonly wait: GateWait }): ReactElement => {
  const label = wait.pipeline_id === null ? 'the pipeline' : `pipeline ${wait.pipeline_id}`;
  return wait.pipeline_url === null ? (
    <UntrustedText value={label} />
  ) : (
    <ExternalLink url={wait.pipeline_url} label={label} className="text-link underline" />
  );
};

export const GateWaitNotice = ({ wait }: { readonly wait: GateWait }): ReactElement => {
  const provider = providerOf(wait);
  if (gateWaitNeedsYou(wait)) {
    const job =
      wait.held_job === null ? (
        <>a manual job</>
      ) : wait.held_job_url !== null ? (
        <>
          the manual job{' '}
          <ExternalLink
            url={wait.held_job_url}
            label={wait.held_job}
            className="text-link underline"
          />
        </>
      ) : wait.pipeline_url !== null ? (
        <>
          the manual job{' '}
          <ExternalLink
            url={wait.pipeline_url}
            label={wait.held_job}
            className="text-link underline"
          />
        </>
      ) : (
        <>
          the manual job <UntrustedText value={wait.held_job} />
        </>
      );
    return (
      <div data-gate-wait="held" className="flex flex-col gap-1">
        <p>
          CI is waiting for someone to start {job} in {provider} (<PipelineName wait={wait} />,{' '}
          {gateWaitTime(wait)}). Start it there and the task continues.
        </p>
        {wait.draft ? (
          <p className="text-xs text-fg-muted" data-gate-wait-draft="">
            The merge request stays a draft until it is ready. If this project’s CI rules hold jobs
            for drafts, the project’s readiness lists it as a CI-rules warning.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <p data-gate-wait="running">
      {wait.pipeline_id === null ? (
        <>CI has not started a pipeline yet ({gateWaitTime(wait)}).</>
      ) : (
        <>
          CI is {wait.status === 'pending' ? 'queued' : 'running'} (<PipelineName wait={wait} />,{' '}
          {gateWaitTime(wait)}).
        </>
      )}
    </p>
  );
};
