/**
 * The three project panels that read a documented endpoint and show it: knowledge, budgets and the
 * effective pipeline configuration.
 *
 * They are **read-only**, and that is the honest state of them. Editing a knowledge document opens
 * a commit or an MR (technical/08 `PUT /api/projects/:id/kb/doc`), editing the pipeline validates
 * and exports to the repository, and both need an editor — CodeMirror 6 in TD-013 — plus the
 * server routes that WP-15 and WP-18 build. What is here is the half that can be correct today:
 * the browser, the proposals queue with its decisions, the budget bars and the effective
 * configuration with the source of every key.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  useKbDoc,
  useKbProposalCommands,
  useKbProposals,
  useKbTree,
  useProjectBudgets,
  useProjectByKey,
  useProjectConfig,
} from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatInteger,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { CodeText, JsonView, UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const useProjectId = (projectKey: string): string | null => {
  const { project } = useProjectByKey(projectKey);
  useTopics(project === null ? [] : [`project:${project.id}`]);
  return project?.id ?? null;
};

// ── Knowledge ────────────────────────────────────────────────────────────────

export const KnowledgeScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  const tree = useKbTree(projectId);
  const proposals = useKbProposals(projectId);
  const [path, setPath] = useState<string | null>(null);
  const doc = useKbDoc(projectId, path);
  const decide = useKbProposalCommands(projectId ?? '');

  const files = (tree.data?.entries ?? []).filter((entry) => entry.kind === 'file');

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <aside className="flex flex-col gap-2">
        <SectionHeading>Vault</SectionHeading>
        {tree.isPending ? <Loading label="Loading the vault…" /> : null}
        {tree.isError ? (
          <ErrorNotice title="The vault could not be listed." detail={String(tree.error)} />
        ) : null}
        {tree.isSuccess && files.length === 0 ? (
          <EmptyState
            title="The vault is empty"
            hint="Knowledge lives in the repository under the project's knowledge_dir. The onboarding wizard bootstraps it; the Librarian keeps it current."
          />
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {files.map((entry) => (
            <li key={entry.path}>
              <Button
                tone={path === entry.path ? 'primary' : 'ghost'}
                className="w-full justify-start font-mono text-xs"
                onClick={() => {
                  setPath(entry.path);
                }}
              >
                <UntrustedText value={entry.path} />
              </Button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex flex-col gap-4">
        <div>
          <SectionHeading>Document</SectionHeading>
          {path === null ? (
            <EmptyState
              title="Nothing selected"
              hint="Pick a document from the vault to read it."
            />
          ) : doc.isPending ? (
            <Loading label="Loading document…" />
          ) : doc.isError ? (
            <ErrorNotice title="That document could not be read." detail={String(doc.error)} />
          ) : doc.data === undefined ? null : (
            <Card className="flex flex-col gap-2">
              <p className="font-mono text-xs text-fg-muted">
                <UntrustedText value={doc.data.path} />
              </p>
              <UntrustedProse value={doc.data.content} />
            </Card>
          )}
        </div>

        <div>
          <SectionHeading>Proposals</SectionHeading>
          {proposals.isPending ? <Loading label="Loading proposals…" /> : null}
          {proposals.isError ? (
            <ErrorNotice title="Proposals could not be loaded." detail={String(proposals.error)} />
          ) : null}
          {proposals.isSuccess && proposals.data.items.length === 0 ? (
            <EmptyState
              title="No pending proposals"
              hint="Retrospective and Feedback propose knowledge changes with their evidence. A maintainer approves, edits or rejects; a rejection is what the Librarian learns from."
            />
          ) : null}
          <div className="flex flex-col gap-2">
            {(proposals.data?.items ?? []).map((proposal) => (
              <Card key={proposal.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="accent">{proposal.type}</Badge>
                  <Badge>{proposal.kind}</Badge>
                  <span className="font-mono">
                    <UntrustedText value={proposal.target_path} />
                  </span>
                  <span className="ml-auto text-fg-muted">
                    significance {proposal.significance.toFixed(2)}
                  </span>
                </div>
                <CodeText value={proposal.delta} />
                <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
                  {proposal.evidence.map((item) => (
                    <li key={item}>
                      <UntrustedText value={item} />
                    </li>
                  ))}
                </ul>
                {proposal.status === 'queued' || proposal.status === 'scored' ? (
                  <div className="flex gap-2">
                    <Button
                      tone="primary"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ proposalId: proposal.id, decision: 'approve' });
                      }}
                    >
                      Approve
                    </Button>
                    <Button
                      tone="danger"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({
                          proposalId: proposal.id,
                          decision: 'reject',
                          reason: 'rejected from the UI',
                        });
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <Badge>{proposal.status}</Badge>
                )}
              </Card>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

// ── Budgets ──────────────────────────────────────────────────────────────────

export const BudgetsScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  const budgets = useProjectBudgets(projectId);

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Budgets</SectionHeading>
      {budgets.isPending ? <Loading label="Loading budgets…" /> : null}
      {budgets.isError ? (
        <ErrorNotice title="Budgets could not be loaded." detail={String(budgets.error)} />
      ) : null}
      {budgets.isSuccess && budgets.data.items.length === 0 ? (
        <EmptyState
          title="No budget is set"
          hint="Without a budget the pipeline spends whatever a stage asks for. A maintainer can set a daily, weekly, monthly or total limit per project."
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {(budgets.data?.items ?? []).map((budget) => {
          const share = budget.limit_usd === 0 ? 0 : budget.spent_usd / budget.limit_usd;
          return (
            <Card key={budget.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Badge tone="accent">{budget.window}</Badge>
                <Badge>{budget.scope}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Metric
                  label="Spent"
                  value={formatUsd(budget.spent_usd)}
                  definition="Provider-reported cost booked against this budget window."
                />
                <Metric
                  label="Limit"
                  value={formatUsd(budget.limit_usd)}
                  definition="The ceiling. Crossing it pauses the work the budget covers (BD-010)."
                />
              </div>
              {/* A native <meter>: the semantic element carries the value, the range and the
                  announcement, which a div with role="meter" only imitates. */}
              <meter
                aria-label="Budget used"
                className="w-full"
                min={0}
                max={Math.max(budget.limit_usd, budget.spent_usd)}
                value={budget.spent_usd}
              >
                {`${Math.round(share * 100)}%`}
              </meter>
              <p className="text-xs text-fg-muted">
                notify at {budget.notify_pct.map((pct) => `${formatInteger(pct)}%`).join(', ')}
              </p>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ── Pipeline / effective configuration ───────────────────────────────────────

export const PipelineScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  const config = useProjectConfig(projectId);

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Effective configuration</SectionHeading>
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      {config.isError ? (
        <ErrorNotice
          title="The effective configuration could not be loaded."
          detail={String(config.error)}
        />
      ) : null}
      {config.data === undefined ? null : (
        <>
          <Card className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-mono">
              hash <UntrustedText value={config.data.hash} />
            </span>
            <span className="text-fg-muted">computed {config.data.computed_at}</span>
          </Card>
          <Card>
            <SectionHeading>Source of every key</SectionHeading>
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              {Object.entries(config.data.sources).map(([key, source]) => (
                <li key={key} className="flex gap-2">
                  <UntrustedText value={key} />
                  <Badge
                    tone={
                      source === 'repo' ? 'accent' : source === 'default' ? 'neutral' : 'warning'
                    }
                  >
                    {source}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <SectionHeading>Merged configuration</SectionHeading>
            <JsonView value={config.data.config} />
          </Card>
          <p className="text-xs text-fg-muted">
            Editing is read-only here. <code>PUT /api/projects/:id/config</code> and the
            export-to-repo command land with WP-15, and the editor TD-013 names (CodeMirror 6 with
            the YAML schema) arrives with them.
          </p>
        </>
      )}
    </div>
  );
};
