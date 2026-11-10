/**
 * **What the platform did about the manual jobs a project set to run** (S-28.7, TD-036's 2026-11-10
 * amendment decisions 5 and 6) — read from `ci_manual_started`, the attempt's record:
 *
 *  - *Started build_composer for you — waiting for its result.* (while CI waits; afterwards *The
 *    platform started build_composer for you.*)
 *  - *Could not start codeception: the platform's GitLab account may not run it. Start it in GitLab,
 *    or give the account permission.* — with the job's page linked;
 *  - *Could not start codeception: this GitLab connection cannot start manual jobs. Start it in
 *    GitLab.*
 *
 * And {@link StartNextTime}: a wait on a person for a job the platform did not start links the
 * project's *Manual CI jobs* card (*Have the platform start it next time*).
 *
 * Job names and URLs are the provider's (BD-022): names as text nodes, URLs through `safeHref`
 * inside `ExternalLink`.
 */
import type { CiManualStarted } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import {
  MANUAL_CI_JOBS_ANCHOR,
  manualStartedWords,
  START_NEXT_TIME,
} from '../ui/words/ci-manual-jobs.js';

const LINK = 'text-link underline';

/** One line per job the platform started or tried to, in the order it recorded them. */
export const ManualStartedLines = ({
  started,
  provider,
  waiting,
  inline = false,
}: {
  readonly started: CiManualStarted;
  /** The provider's display name (`GitLab`). */
  readonly provider: string;
  /** While CI waits: *waiting for its result*. */
  readonly waiting: boolean;
  /** Inside a sentence (the Checks row's basis): spans rather than a list. */
  readonly inline?: boolean;
}): ReactElement => {
  const items = started.map((entry) => {
    const words = manualStartedWords(entry.outcome, provider, waiting);
    const body = (
      <>
        {words.lead} <UntrustedText value={entry.name} />
        {entry.outcome === 'started' ? ' ' : ''}
        {words.tail}
        {entry.outcome !== 'started' && entry.url !== null ? (
          <>
            {' '}
            <ExternalLink url={entry.url} label="Open job" className={LINK} />
          </>
        ) : null}
      </>
    );
    return inline ? (
      <span key={entry.job_id} data-ci-manual-started-outcome={entry.outcome}>
        {' '}
        {body}
      </span>
    ) : (
      <li key={entry.job_id} data-ci-manual-started-outcome={entry.outcome}>
        {body}
      </li>
    );
  });
  return inline ? (
    <span data-ci-manual-started="">{items}</span>
  ) : (
    <ul className="flex flex-col gap-0.5 text-sm" data-ci-manual-started="">
      {items}
    </ul>
  );
};

/** *Have the platform start it next time* — the project's Manual CI jobs card. */
export const StartNextTime = ({ projectKey }: { readonly projectKey: string }): ReactElement => (
  <p className="text-xs" data-ci-start-next-time="">
    <Link
      to="/projects/$key/settings/$section"
      params={{ key: projectKey, section: 'policies' }}
      hash={MANUAL_CI_JOBS_ANCHOR}
      className="text-accent underline underline-offset-2"
    >
      {START_NEXT_TIME}
    </Link>
  </p>
);
