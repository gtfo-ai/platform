/**
 * A maintainer's **re-evaluate** — discovery run again (WP-94, PROGRESS backlog 230, Q107 (a)).
 *
 * The post-merge re-check answers seven of product/17's fourteen criteria without a run; the other
 * seven need a discovery run, and before this control nothing could start a second one. The button
 * opens a new one-off discovery task — the same template, admission guard, budget cap, cost ledger
 * and transcript as the first — and its evaluation is recorded as a *rediscovery* beside the others.
 *
 * ## The estimate is the server's, and it is a ceiling
 *
 * `GET …/rediscovery` answers `ceiling_usd` — the discovery stage's run budget, what the admission
 * guard reserves — and what the last discovery cost. The button says both, and says the first is
 * a cap rather than a prediction: a number labelled as an estimate that is really a cap is a claim
 * about money this screen cannot back (standing rule 9: no arithmetic here).
 *
 * ## Off with the reason, never a button that answers 409
 *
 * `can_start` and `blocker` are the answer the command decides with. When a discovery is running
 * or parked, when the project never ran one, or when three re-evaluations recorded nothing, the
 * button is disabled and the server's sentence is shown as text (`ui/untrusted.tsx` — platform text
 * today, and the rule is about the sink). The capability is the server's to check: a member who
 * presses it is refused `403` and the screen shows that refusal as it came.
 *
 * Since WP-124 (PROGRESS backlog 366) the read also says when the **last** discovery's findings were
 * never recorded — the recovery pass re-asked for the recording once and gave up — because this is
 * the button that runs it again.
 */
import type { ReactElement } from 'react';
import { useOnboardingCommands, useRediscoveryGate } from '../app/queries.js';
import { Button, ErrorNotice, formatUsd, Loading } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

export const Rediscovery = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const gate = useRediscoveryGate(projectId);
  const commands = useOnboardingCommands();
  if (gate.isPending) {
    return <Loading label="Loading whether discovery can run again…" />;
  }
  if (gate.isError) {
    return (
      <ErrorNotice
        title="Whether discovery can run again could not be read."
        detail={String(gate.error)}
      />
    );
  }
  const { can_start: canStart, blocker, ceiling_usd: ceiling, last_discovery: last } = gate.data;
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          tone="default"
          disabled={!canStart || commands.startRediscovery.isPending}
          onClick={() => {
            commands.startRediscovery.mutate(projectId);
          }}
        >
          Re-evaluate readiness — up to {formatUsd(ceiling)}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        Runs the Discovery agent again as a new task, so the criteria a merge cannot re-check are
        answered again. {formatUsd(ceiling)} is the run’s budget cap, not a prediction
        {last === null ? '' : `; the last discovery cost ${formatUsd(last.cost_usd)}`}. Maintainers
        only.
      </p>
      {last?.findings_unrecorded == null ? null : (
        // WP-124, backlog 366: the last discovery was paid for and its findings were never recorded;
        // the recovery pass re-asked once and gave up. Platform text, rendered as text all the same.
        <p className="text-xs text-warning" data-findings-unrecorded="true">
          The last discovery’s findings were never recorded:{' '}
          <UntrustedText value={last.findings_unrecorded.reason} />. Re-evaluating runs it again.
        </p>
      )}
      {blocker === null ? null : (
        <p className="text-xs text-warning">
          <UntrustedText value={blocker.detail} />
        </p>
      )}
      {commands.startRediscovery.isSuccess ? (
        <p className="text-xs">
          <UntrustedText value={commands.startRediscovery.data.detail} />
        </p>
      ) : null}
      {commands.startRediscovery.isError ? (
        <ErrorNotice
          title="Discovery was not run again."
          detail={String(commands.startRediscovery.error)}
        />
      ) : null}
    </div>
  );
};
