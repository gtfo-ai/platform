/**
 * The history bootstrap's control — product/06 step 3b, product/18:27 (WP-35).
 *
 * > *"Offer to mine the last N merged MRs (default 200) with their review comments and closed
 * > tickets … Results are KB proposals with provenance (MR links) in the proposal queue, never
 * > applied silently. **Shows an estimated cost before running.**"*
 *
 * **One component, rendered by the wizard's step 3b *and* by the project settings page** — the same
 * arrangement `operating-mode.tsx` has, and for the same reason: product/18:55 says the settings
 * pages mirror the wizard one-to-one, and the only way a mirror stays true is by not having two of
 * it. `routes/settings-mirror.test.ts` is the census that notices when somebody makes a second one.
 *
 * ## The estimate is the server's
 *
 * The screen never multiplies N by a price. It asks `GET …/history-bootstraps?merge_requests=N` and
 * renders what comes back — `batches`, `estimated_usd`, `cap_usd`, `stops_at_cap` — because the
 * arithmetic has one owner (`estimateHistoryBootstrap` in the domain) and a second copy here would
 * be a second answer about money (standing rule 9). Moving the number re-asks.
 *
 * ## Everything it renders that came from outside is text
 *
 * `blocked_reason` and a batch's `detail` are the **platform's** own sentences rather than a
 * provider's, and they still go through `ui/untrusted.tsx` like every other string on every other
 * screen: the rule is about the sink, not about the author's intentions (BD-022), and a sentence
 * that is platform text today is one somebody widens tomorrow.
 */
import type { HistoryBootstrapBatch } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useHistoryBootstrapCommands, useHistoryBootstraps } from '../app/queries.js';
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  formatInteger,
  formatUsd,
  Loading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

const STATUS_TONE: Readonly<Record<HistoryBootstrapBatch['status'], BadgeTone>> = {
  collecting: 'accent',
  mining: 'accent',
  completed: 'success',
  empty: 'neutral',
};

/**
 * What each status means, in the platform's own words.
 *
 * `empty` is the one worth spelling out: a batch that found nothing is **not** a failure and not a
 * batch still running, and a screen that showed it as either would be answering a different
 * question from the one an operator asked (standing rule 18).
 */
const STATUS_LABEL: Readonly<Record<HistoryBootstrapBatch['status'], string>> = {
  collecting: 'reading the merged history',
  mining: 'mining',
  completed: 'finished',
  empty: 'nothing to mine',
};

export const HistoryBootstrap = ({
  projectId,
  projectKey,
}: {
  readonly projectId: string;
  /** The project's human key — what the knowledge screen's route is addressed by. */
  readonly projectKey: string;
}): ReactElement => {
  const [mergeRequests, setMergeRequests] = useState<number | null>(null);
  const bootstraps = useHistoryBootstraps(projectId, mergeRequests);
  const commands = useHistoryBootstrapCommands();

  if (bootstraps.isPending) {
    return <Loading label="Loading the history bootstrap…" />;
  }
  if (bootstraps.isError || bootstraps.data === undefined) {
    return <ErrorNotice title="The history bootstrap could not be loaded." />;
  }
  const { estimate, items, can_start, blocked_reason, max_merge_requests } = bootstraps.data;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Mines the last N merged merge requests with their review comments, the closed tickets of the
        same window and the commit messages, in batches of {formatInteger(estimate.batch_size)} per
        run. Every proposal cites the merge requests it was observed in and lands in the proposal
        queue — nothing is ever applied on its own.
      </p>

      <Field
        label="Merge requests to mine"
        hint={`Between 1 and ${formatInteger(max_merge_requests)}; this project's default is ${formatInteger(estimate.merge_requests)}.`}
        type="number"
        min={1}
        max={max_merge_requests}
        value={mergeRequests ?? estimate.merge_requests}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          // Out of range falls back to the project's own N rather than clamping: the server refuses
          // the same values, and a screen that silently changed the number would start a batch the
          // operator did not ask for (the request schema and `startHistoryBootstrap` both refuse).
          setMergeRequests(
            Number.isFinite(parsed) && parsed >= 1 && parsed <= max_merge_requests ? parsed : null,
          );
        }}
      />

      <p className="text-xs">
        <strong>At most {formatUsd(estimate.estimated_usd)}</strong> —{' '}
        {formatInteger(estimate.batches)} run(s) of {formatInteger(estimate.batch_size)} merge
        requests, each capped at the platform&rsquo;s per-run budget, over the last{' '}
        {formatInteger(estimate.days)} days. This project&rsquo;s cap is{' '}
        {formatUsd(estimate.cap_usd)}.
      </p>
      {estimate.stops_at_cap ? (
        <p className="text-xs text-warning">
          The estimate is above the cap, so the bootstrap will mine what the cap pays for and stop.
          Lower the number, or raise <code>features.history_bootstrap.budget_usd</code>.
        </p>
      ) : null}

      <div>
        <Button
          tone="primary"
          disabled={!can_start || commands.start.isPending}
          onClick={() => {
            commands.start.mutate({ projectId, merge_requests: mergeRequests });
          }}
        >
          Mine the history
        </Button>
      </div>
      {blocked_reason === null ? null : (
        <p className="text-xs text-fg-muted">
          <UntrustedText value={blocked_reason} />
        </p>
      )}
      {commands.start.isError ? (
        <ErrorNotice title="The history bootstrap could not be started." />
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="No history has been mined yet"
          hint="A bootstrap reads six months of merged merge requests once; the proposals it writes are reviewed on the Knowledge screen."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((batch) => (
            <li key={batch.id} className="flex flex-col gap-1 text-xs">
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[batch.status]}>{STATUS_LABEL[batch.status]}</Badge>
                <span>
                  {formatInteger(batch.merge_requests)} merge requests, started{' '}
                  {formatDateTime(batch.created_at)}
                </span>
              </div>
              <span className="text-fg-muted">
                {formatInteger(batch.chunks_recorded)} of {formatInteger(batch.chunks)} run(s)
                reported · {formatInteger(batch.proposals)} proposal(s) queued ·{' '}
                {formatInteger(batch.refused_proposals)} refused · {formatUsd(batch.spent_usd)} of{' '}
                {formatUsd(batch.cap_usd)} spent
              </span>
              {batch.detail === null ? null : (
                <span className="text-fg-muted">
                  <UntrustedText value={batch.detail} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-fg-muted">
        What the mining proposes is reviewed like any other knowledge change.{' '}
        <Link to="/projects/$key/knowledge" params={{ key: projectKey }}>
          The proposal queue
        </Link>{' '}
        is where a maintainer accepts, edits or rejects each one.
      </p>
    </div>
  );
};
