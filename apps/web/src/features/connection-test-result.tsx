/**
 * What a *Test connection* answered — the one rendering the Integrations screen and the onboarding
 * wizard's step 1 share (WP-155 ruling (b), PROGRESS backlog 451).
 *
 * Until WP-155 the wizard's button sent the probe and read none of the mutation's state, so a press
 * showed nothing while the same press on the Integrations screen showed its result. The fix is this
 * component, rendered by both, rather than a second copy of the card: two copies are how the wizard
 * came to show nothing in the first place.
 *
 * Four answers, each its own sentence: the probe is **running**, it **could not be run** (the
 * request failed — the error notice), or it ran and **passed** or **failed** with each check it
 * made. A check's detail is the provider's own words about the operator's instance (BD-022), so it
 * is rendered through `ui/untrusted.tsx`.
 */
import type { TestIntegrationResponse } from '@platform/contracts';
import type { ReactElement } from 'react';
import { configFieldLabel } from '../ui/humanize.js';
import { ErrorNotice } from '../ui/kit.js';
import { StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The slice of a `useMutation` result this reads — a mutation object satisfies it as it is. */
export interface ConnectionTestState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly error: unknown;
  readonly data: TestIntegrationResponse | undefined;
}

export const ConnectionTestResult = ({
  test,
}: {
  readonly test: ConnectionTestState;
}): ReactElement | null => {
  if (test.isPending) {
    return (
      <p className="text-xs text-fg-muted" role="status" data-connection-test="pending">
        Testing the connection…
      </p>
    );
  }
  if (test.isError) {
    return <ErrorNotice title="The connection test could not be run." error={test.error} />;
  }
  if (!test.isSuccess || test.data === undefined) {
    return null;
  }
  const { ok, checks } = test.data;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-line bg-default p-3 text-xs"
      data-connection-test={ok ? 'passed' : 'failed'}
    >
      <p
        className={
          ok
            ? 'flex items-center gap-1.5 font-semibold'
            : 'flex items-center gap-1.5 font-semibold text-danger'
        }
      >
        <StatusIcon status={ok ? 'success' : 'failure'} decorative />
        {ok ? 'Last test: passed' : 'Last test: failed'}
      </p>
      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li key={check.name} className="flex items-start gap-1.5">
            <StatusIcon
              status={check.ok ? 'success' : 'failure'}
              label={check.ok ? 'Passed' : 'Failed'}
              size={12}
              className="mt-0.5"
            />
            {/* The check's name is the platform's, in words; its detail is the provider's (BD-022). */}
            <span className="font-medium">{configFieldLabel(check.name)}</span>
            <span className="text-fg-muted">
              <UntrustedText value={check.detail} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
