/**
 * The platform's notices on a readiness evaluation (WP-143, Q114) — today the **CI-rules warning**
 * (`ci_rules_skip_agent_branch`: the default branch's CI rules give an `agentic/` branch no test
 * job) or the quieter **note** (`ci_rules_not_seen`: what the evaluator could not read).
 *
 * One component for the three places product names — the readiness panel of the wizard's
 * discovery step and the project settings page — so the two cannot drift. A notice is never a
 * criterion and never blocks anything (BD-026). Its message quotes job names and one rule from the
 * project's CI file: untrusted (BD-022), rendered as text through `UntrustedText`.
 */
import type { ReadinessResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Badge } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

const LABEL: Record<ReadinessResponse['notices'][number]['code'], string> = {
  ci_rules_skip_agent_branch: 'CI rules skip agentic/ branches',
  ci_rules_not_seen: 'CI rules read in part',
};

export const ReadinessNotices = ({
  notices,
}: {
  readonly notices: ReadinessResponse['notices'];
}): ReactElement | null =>
  notices.length === 0 ? null : (
    <ul className="flex w-full flex-col gap-1" aria-label="Readiness notices">
      {notices.map((notice) => (
        <li
          key={notice.code}
          className="text-xs"
          role={notice.severity === 'warning' ? 'alert' : undefined}
        >
          <Badge tone={notice.severity === 'warning' ? 'warning' : 'neutral'}>
            {notice.severity === 'warning' ? 'Warning' : 'Note'}
          </Badge>{' '}
          <span className="font-semibold">{LABEL[notice.code]}</span> —{' '}
          <UntrustedText value={notice.message} />
        </li>
      ))}
    </ul>
  );
