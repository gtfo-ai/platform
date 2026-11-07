/**
 * **A manual job nobody started is not a check, unless it is a test** (S-27.2, BD-024's 2026-11-07
 * amendment, TD-036 decisions 5 and 7) — what the task page says when the CI check passed a
 * pipeline the provider still holds at a manual job.
 *
 *  - The Checks item's value: *CI passed — the manual job sentry-release-commit was not run*.
 *  - At Ready, when the provider still shows that pipeline blocked (`pipeline_status: 'manual'`):
 *    *"GitLab shows pipeline n, the latest for this commit, as blocked at the manual job X. If this
 *    project requires pipelines to succeed, GitLab won't merge it until X has run: start it on
 *    GitLab."* Nothing here says the merge request *can be merged*: a person merges (BD-007).
 *
 * Every provider string — the pipeline id, the job names, the URLs — is untrusted (BD-022): names
 * are text nodes (`UntrustedText`, or an `ExternalLink`'s label) and URLs go through `safeHref`
 * inside {@link ExternalLink}. The words are `ui/humanize.ts`'s.
 */
import type { CiManualNotRun, TaskDetailResponse } from '@platform/contracts';
import { Fragment, type ReactElement } from 'react';
import { manualNotRunWords, readyBlockedWords } from '../ui/humanize.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { providerName } from './gate-wait.js';

const LINK = 'text-link underline';

/** The task's latest CI pass left these unstarted, and the provider still shows it blocked. */
export const readyBlockedPipeline = (detail: TaskDetailResponse): CiManualNotRun | null => {
  const notRun = detail.ci_manual_not_run ?? null;
  return detail.task.state === 'ready_for_merge' && notRun?.pipeline_status === 'manual'
    ? notRun
    : null;
};

/** The job names, each linked to its page when the provider gave one, joined by commas. */
const JobNames = ({ notRun }: { readonly notRun: CiManualNotRun }): ReactElement => (
  <>
    {notRun.jobs.map((job, index) => (
      <Fragment key={`${job.name}:${String(index)}`}>
        {index === 0 ? null : ', '}
        {job.url === null ? (
          <UntrustedText value={job.name} />
        ) : (
          <ExternalLink url={job.url} label={job.name} className={LINK} />
        )}
      </Fragment>
    ))}
  </>
);

/** The CI item's value: *CI passed — the manual job X was not run*. */
export const ManualNotRunValue = ({
  notRun,
}: {
  readonly notRun: CiManualNotRun;
}): ReactElement => {
  const words = manualNotRunWords(notRun.jobs.length);
  return (
    <span data-ci-manual-not-run="">
      {words.lead} <JobNames notRun={notRun} /> {words.tail}
    </span>
  );
};

/** TD-036 decision 7's sentence, for the Ready callout. */
export const ReadyBlockedNotice = ({
  notRun,
  provider,
}: {
  readonly notRun: CiManualNotRun;
  /** The merge request's provider id (`gitlab`), for "GitLab shows". */
  readonly provider: string | null;
}): ReactElement => {
  const words = readyBlockedWords(providerName(provider), notRun.jobs.length);
  const pipeline = `pipeline ${notRun.pipeline_id}`;
  return (
    <p data-ready-blocked="">
      {words.shows}{' '}
      {notRun.pipeline_url === null ? (
        <UntrustedText value={pipeline} />
      ) : (
        <ExternalLink url={notRun.pipeline_url} label={pipeline} className={LINK} />
      )}
      {words.blockedAt} <JobNames notRun={notRun} />
      {words.requires} <JobNames notRun={notRun} /> {words.start}
    </p>
  );
};
