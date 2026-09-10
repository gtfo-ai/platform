/**
 * The agents view (product/10 § "Agents view"): who is working on what, right now.
 *
 * One row per running run, live on the `org` topic. "tokens/min" from product/10 is absent: the
 * `agentsResponseSchema` carries cumulative usage and `last_output_at`, and a rate computed from
 * two samples this screen happens to have seen would be a number with no definition — which
 * product/10's own rule ("every number shown has a tooltip with its definition") forbids.
 */
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useAgents } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatElapsed,
  formatInteger,
  formatUsd,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

export const AgentsScreen = (): ReactElement => {
  useTopics(['org']);
  const agents = useAgents();
  const { now } = useServices();
  const nowMs = now();

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Agents</SectionHeading>
      {agents.isPending ? <Loading label="Loading agents…" /> : null}
      {agents.isError ? (
        <ErrorNotice title="Agents could not be loaded." detail={String(agents.error)} />
      ) : null}
      {agents.isSuccess && agents.data.items.length === 0 ? (
        <EmptyState
          title="No agent is running"
          hint="Rows appear here the moment a stage starts a run. Idle capacity means the pipeline has nothing queued, or the WIP limit is holding work back."
        />
      ) : null}
      <div className="flex flex-col gap-2">
        {(agents.data?.items ?? []).map((entry) => (
          <Card key={entry.run.id} className="flex flex-wrap items-center gap-3">
            <Link
              to="/runs/$runId"
              params={{ runId: entry.run.id }}
              className="text-sm font-medium hover:underline"
            >
              {entry.run.stage} · {entry.role}
            </Link>
            <Badge tone="accent">{entry.run.status}</Badge>
            <span className="font-mono text-xs text-fg-muted">
              <UntrustedText value={entry.run.model} />
            </span>
            <span className="text-xs text-fg-muted">
              {formatInteger(entry.run.usage.input_tokens + entry.run.usage.output_tokens)} tokens
            </span>
            <span className="text-xs text-fg-muted">{formatUsd(entry.run.cost.usd)}</span>
            <span className="ml-auto text-xs text-fg-muted">
              elapsed {formatElapsed(entry.run.started_at, nowMs)} · last output{' '}
              {formatElapsed(entry.last_output_at, nowMs)}
            </span>
          </Card>
        ))}
      </div>
    </div>
  );
};
