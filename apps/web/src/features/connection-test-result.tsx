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
import { Badge, Card, ErrorNotice } from '../ui/kit.js';
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
    return (
      <ErrorNotice title="The connection test could not be run." detail={String(test.error)} />
    );
  }
  if (!test.isSuccess || test.data === undefined) {
    return null;
  }
  const { ok, checks } = test.data;
  return (
    <Card className="flex flex-col gap-1 text-xs">
      <p className={ok ? 'font-semibold' : 'font-semibold text-danger'}>
        {ok ? 'Last test: passed' : 'Last test: failed'}
      </p>
      {checks.map((check) => (
        <p key={check.name}>
          <Badge tone={check.ok ? 'success' : 'danger'}>{check.name}</Badge>{' '}
          {/* The provider's own words about the operator's own instance (BD-022). */}
          <UntrustedText value={check.detail} />
        </p>
      ))}
    </Card>
  );
};
