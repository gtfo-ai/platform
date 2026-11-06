/**
 * The three project panels that read a documented endpoint and show it: knowledge, budgets and the
 * pipeline — its templates as a canvas (S-23.5) over the effective configuration.
 *
 * Knowledge and the pipeline are **read-only** here, and that is the honest state of them. Editing a
 * knowledge document opens a commit or an MR (technical/08 `PUT /api/projects/:id/kb/doc`), editing
 * the pipeline validates and exports to the repository, and both need an editor — CodeMirror 6 in
 * TD-013 — plus the server routes that WP-15 and WP-18 build. What is here is the half that can be
 * correct today: the browser, the proposals queue with its decisions, and the effective
 * configuration with the source of every key. **Budgets is the exception since S-25.7**: a
 * project's cap is read and set on its own tab (product/10's 2026-11-06 IA amendment), beside
 * where the window's money went.
 */
import {
  type BudgetWindow,
  type KbHealthResponse,
  MAX_PROPOSAL_DECISION_REASON_CHARS,
} from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ApiError } from '../api/http.js';
import {
  useKbDoc,
  useKbHealth,
  useKbProposalCommands,
  useKbProposals,
  useKbTree,
  useProjectBudgets,
  useProjectByKey,
  useProjectConfig,
  useProjectSpend,
} from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import { ActionMenu, ActionMenuItem } from '../ui/action-menu.js';
import { ForAdministrators } from '../ui/admin-notes.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Flash } from '../ui/flash.js';
import {
  BUDGET_SCOPE_LABEL,
  BUDGET_WINDOW_LABEL,
  KNOWLEDGE_PROPOSAL_KIND_LABEL,
  KNOWLEDGE_PROPOSAL_SOURCE_LABEL,
  KNOWLEDGE_PROPOSAL_STATUS_LABEL,
  KNOWLEDGE_PROPOSAL_TYPE_LABEL,
  REPOSITORY_STATUS_LABEL,
  stageLabel,
} from '../ui/humanize.js';
import {
  Badge,
  Card,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  formatUsd,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { NavList, type NavListGroup } from '../ui/nav-list.js';
import { rowLink } from '../ui/row-link.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { CodeText, JsonView, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { PipelineFlow } from '../viz/flow/flow-view.js';
import { ProjectBudgets } from './operating-mode.js';

const useProjectId = (projectKey: string): string | null => {
  const { project } = useProjectByKey(projectKey);
  useTopics(project === null ? [] : [`project:${project.id}`]);
  return project?.id ?? null;
};

// ── Knowledge ────────────────────────────────────────────────────────────────

/**
 * What each finding kind means, in a maintainer's words — `kbHealthReportFindingSchema.kind`.
 *
 * A `Record` over the enum, as `ui/humanize.ts`'s vocabularies are: an eighth kind fails the
 * typecheck here rather than rendering as a bare token. The strings are the platform's; the finding's `path` and
 * `detail` quote a committed page and stay untrusted (BD-022).
 */
const FINDING_LABEL: Readonly<Record<KbHealthResponse['findings'][number]['kind'], string>> = {
  invalid: 'cannot be read — never given to agents',
  unresolved_paths: 'its paths match no file — never given to agents',
  expired: 'expired',
  dangling: 'dangling link',
  duplicate: 'duplicate id',
  contradiction: 'contradiction',
  oversized: 'oversized',
};

/**
 * The knowledge health report (WP-95, PROGRESS backlog 37): the nightly hygiene pass has written
 * `kb_health_reports` since WP-18b and `GET …/kb/health` has served the newest since WP-15h part 2,
 * and no screen asked for it — so a page the parser refused was silently absent from every pack and
 * the one place that said so was a table nobody read.
 *
 * Three answers, kept apart (standing rule 18): **no report yet** (the read's `409
 * kb_health_not_reported`), **a report with no findings**, and **a report with findings**. A finding
 * is an observation: nothing in the platform rewrites a page because one names it (product/05), and
 * this panel offers no control that would.
 */
export const KnowledgeHealth = ({
  projectId,
}: {
  readonly projectId: string | null;
}): ReactElement | null => {
  const health = useKbHealth(projectId);
  const notReported =
    health.error instanceof ApiError && health.error.code === 'kb_health_not_reported';
  if (health.isPending && projectId !== null) {
    return <Loading label="Loading the health report…" />;
  }
  if (notReported) {
    return (
      <Flash title="No health report yet">
        The nightly hygiene pass writes one per project: documents the parser refused, links that
        point nowhere, expired pages, duplicates. None has run for this project yet.
      </Flash>
    );
  }
  if (health.isError) {
    return <ErrorNotice title="The health report could not be loaded." error={health.error} />;
  }
  if (health.data === undefined) {
    return null;
  }
  const data = health.data;
  const meta = (
    <p className="text-xs">
      {`${formatInteger(data.documents)} document${data.documents === 1 ? '' : 's'} indexed · ${data.source === 'hygiene' ? 'nightly hygiene pass' : 'Librarian run'} · ${formatDateTime(data.created_at)}`}
      {data.commit_sha === null ? null : (
        <>
          {' · index at '}
          <UntrustedText value={data.commit_sha.slice(0, 12)} />
        </>
      )}
    </p>
  );
  return data.findings.length === 0 ? (
    <div data-kb-health="clean">
      <Flash tone="success" title="The last pass found nothing wrong.">
        {meta}
      </Flash>
    </div>
  ) : (
    <div data-kb-health="findings">
      <Flash
        tone="warning"
        title={`The last health pass found ${data.findings.length === 1 ? 'one problem' : `${formatInteger(data.findings.length)} problems`}`}
      >
        <div className="flex flex-col gap-2">
          {meta}
          <ul className="flex flex-col gap-1 text-xs">
            {data.findings.map((finding, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: findings are positional; two may share a path and kind.
                key={index}
                className="flex flex-col gap-0.5 border-t border-line pt-1"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={finding.kind === 'invalid' ? 'danger' : 'warning'}>
                    {FINDING_LABEL[finding.kind]}
                  </Badge>
                  <span className="font-mono">
                    <UntrustedText value={finding.path} />
                  </span>
                </span>
                <UntrustedText value={finding.detail} />
              </li>
            ))}
          </ul>
          <p className="text-xs">
            An observation, not an instruction: nothing rewrites a page because a finding names it.
          </p>
        </div>
      </Flash>
    </div>
  );
};

type KbProposal = NonNullable<ReturnType<typeof useKbProposals>['data']>['items'][number];

/** A proposal a maintainer can still decide: waiting for review, or approved and failed to apply. */
const isDecidable = (proposal: KbProposal): boolean =>
  proposal.status === 'queued' ||
  proposal.status === 'scored' ||
  proposal.status === 'apply_failed';

const ProposalRow = ({
  proposal,
  pending,
  onDecide,
}: {
  readonly proposal: KbProposal;
  readonly pending: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): ReactElement => (
  <ListRow
    leading={
      <StatusIcon
        status={
          proposal.status === 'apply_failed'
            ? 'failure'
            : proposal.apply_deferred_reason != null
              ? 'waiting'
              : isDecidable(proposal)
                ? 'needs_you'
                : proposal.status === 'rejected' || proposal.status === 'discarded'
                  ? 'cancelled'
                  : 'success'
        }
        label={KNOWLEDGE_PROPOSAL_STATUS_LABEL[proposal.status]}
      />
    }
    title={<UntrustedText value={proposal.target_path} className="font-mono" />}
    meta={
      <div className="flex flex-col gap-1">
        <span>
          {`${KNOWLEDGE_PROPOSAL_TYPE_LABEL[proposal.type]} · ${KNOWLEDGE_PROPOSAL_KIND_LABEL[proposal.kind]} · ${KNOWLEDGE_PROPOSAL_SOURCE_LABEL[proposal.source]}`}
        </span>
        {proposal.status === 'apply_failed' ? (
          // WP-124, backlog 366: approved, re-tried once by the recovery pass, and still not
          // committed. Approving again is how a maintainer asks for another apply.
          <span className="text-attention" data-apply-failed="true">
            <Badge tone="danger">apply failed</Badge>{' '}
            <UntrustedText value={proposal.apply_failure_reason ?? 'no reason was recorded'} />
          </span>
        ) : null}
        {proposal.apply_deferred_reason == null ? null : (
          // WP-125, backlog 369: approved, and held back because an open knowledge merge request
          // already creates this page; applied as an update once that one merges.
          <span data-apply-deferred="true">
            <Badge tone="warning">waits for a merge</Badge>{' '}
            <UntrustedText value={proposal.apply_deferred_reason} />
          </span>
        )}
        {/*
          Open while a maintainer still decides it (S-25.1, research/21 F2): *Approve* sits beside
          the change, so the change is on screen when it is pressed — never approved collapsed.
        */}
        <DetailsDisclosure
          summary="The change and its evidence"
          defaultOpen={isDecidable(proposal)}
        >
          <div className="flex flex-col gap-2">
            <CodeText value={proposal.delta} />
            <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
              {proposal.evidence.map((item) => (
                <li key={item}>
                  <UntrustedText value={item} />
                </li>
              ))}
            </ul>
          </div>
        </DetailsDisclosure>
      </div>
    }
    actions={
      isDecidable(proposal) ? (
        <div className="flex items-center gap-1">
          <Button size="sm" disabled={pending} onClick={() => onDecide('approve')}>
            {proposal.status === 'apply_failed' ? 'Approve again' : 'Approve'}
          </Button>
          <ActionMenu label={`More for ${sanitiseUntrusted(proposal.target_path)}`}>
            <ActionMenuItem tone="danger" disabled={pending} onSelect={() => onDecide('reject')}>
              Reject…
            </ActionMenuItem>
          </ActionMenu>
        </div>
      ) : (
        <Badge>{KNOWLEDGE_PROPOSAL_STATUS_LABEL[proposal.status]}</Badge>
      )
    }
  />
);

/** `technical/architecture.md` → `technical`; a top-level page → `''`. */
const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

export const KnowledgeScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  const tree = useKbTree(projectId);
  const proposals = useKbProposals(projectId);
  const [path, setPath] = useState<string | null>(null);
  const doc = useKbDoc(projectId, path);
  const decide = useKbProposalCommands(projectId ?? '');
  // S-23.23 (the UX audit's item 8): a reject asks first, with the person's own reason — the
  // Librarian learns from it, so it is never a canned sentence.
  const [rejecting, setRejecting] = useState<KbProposal | null>(null);

  const files = (tree.data?.entries ?? []).filter((entry) => entry.kind === 'file');
  // The vault as a tree: one NavList group per directory, in the order the index lists them.
  const directories = [...new Set(files.map((entry) => directoryOf(entry.path)))];
  const groups: NavListGroup[] = directories.map((directory) => ({
    ...(directory === '' ? {} : { label: sanitiseUntrusted(directory) }),
    items: files
      .filter((entry) => directoryOf(entry.path) === directory)
      .map((entry) => ({
        id: entry.path,
        label: sanitiseUntrusted(entry.path.slice(directory === '' ? 0 : directory.length + 1)),
        current: path === entry.path,
        onSelect: () => {
          setPath(entry.path);
        },
      })),
  }));
  // The ones waiting for the reader first (research/21 S14, F2); the server's order within each half.
  const items = [...(proposals.data?.items ?? [])].sort(
    (left, right) => Number(isDecidable(right)) - Number(isDecidable(left)),
  );
  const waiting = items.filter(isDecidable).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="flex min-w-0 flex-col gap-2">
        <h2 className="px-2 text-sm font-semibold text-fg">Files</h2>
        {tree.isPending ? <Skeleton label="Loading the files…" lines={4} /> : null}
        {tree.isError ? (
          <ErrorNotice title="The knowledge base could not be listed." error={tree.error} />
        ) : null}
        {tree.isSuccess && files.length === 0 ? (
          <Blankslate
            informational
            title="The knowledge base is empty"
            hint="Knowledge lives in the repository under the project's knowledge directory. Setting up a project drafts it; the Librarian keeps it current."
          />
        ) : null}
        {files.length === 0 ? null : (
          <>
            <NavList label="Knowledge files" groups={groups} stackBelow="lg" />
            {path === null ? (
              <p className="px-2 text-xs text-fg-muted">Pick a file to read it.</p>
            ) : null}
          </>
        )}
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-fg">Suggested edits</h2>
          {proposals.isPending ? <Skeleton label="Loading suggested edits…" lines={3} /> : null}
          {proposals.isError ? (
            <ErrorNotice title="Suggested edits could not be loaded." error={proposals.error} />
          ) : null}
          {proposals.isSuccess && items.length === 0 ? (
            <Blankslate
              informational
              title="No suggested edits waiting"
              hint="Retrospective, Feedback and the history bootstrap suggest edits to the knowledge base with their evidence, and each row says which. A maintainer approves or rejects; a rejection is what the Librarian learns from."
            />
          ) : null}
          {items.length === 0 ? null : (
            <ListBox
              label="Suggested edits"
              header={
                <ListBoxHeader>
                  <span className="font-semibold text-fg">
                    {`${formatInteger(waiting)} waiting for review`}
                  </span>
                  <span>{`${formatInteger(items.length)} in all`}</span>
                </ListBoxHeader>
              }
            >
              {items.map((proposal) => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  pending={decide.isPending}
                  onDecide={(decision) => {
                    if (decision === 'approve') {
                      decide.mutate({ proposalId: proposal.id, decision: 'approve' });
                    } else {
                      decide.reset();
                      setRejecting(proposal);
                    }
                  }}
                />
              ))}
            </ListBox>
          )}
          {decide.isError && rejecting === null ? (
            <ErrorNotice title="The decision was not recorded." error={decide.error} />
          ) : null}
          <ConfirmDialog
            open={rejecting !== null}
            onOpenChange={(next) => {
              if (!next) {
                setRejecting(null);
              }
            }}
            title="Reject this suggested edit?"
            consequence="The page is not changed, and the suggestion is closed for good; your reason is what the Librarian learns from."
            confirmLabel="Reject"
            reason={{
              label: 'Why (the Librarian learns from it)',
              placeholder: 'What is wrong with this change',
              maxLength: MAX_PROPOSAL_DECISION_REASON_CHARS,
            }}
            pending={decide.isPending}
            error={decide.error}
            errorTitle="The decision was not recorded."
            onConfirm={(reason) => {
              if (rejecting === null) {
                return;
              }
              decide.mutate(
                {
                  proposalId: rejecting.id,
                  decision: 'reject',
                  ...(reason === '' ? {} : { reason }),
                },
                {
                  onSuccess: () => {
                    setRejecting(null);
                  },
                },
              );
            }}
          />
        </div>

        {path === null ? null : doc.isPending ? (
          <Skeleton label="Loading document…" lines={6} />
        ) : doc.isError ? (
          <ErrorNotice title="That document could not be read." error={doc.error} />
        ) : doc.data === undefined ? null : (
          <Card
            header={
              <span className="font-mono">
                <UntrustedText value={doc.data.path} />
              </span>
            }
          >
            <UntrustedProse value={doc.data.content} />
          </Card>
        )}

        <div className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-fg">Health</h2>
          <KnowledgeHealth projectId={projectId} />
        </div>
      </section>
    </div>
  );
};

// ── Budgets ──────────────────────────────────────────────────────────────────

const SPEND_WINDOWS = ['day', 'week', 'month', 'total'] as const satisfies readonly BudgetWindow[];

/** The window a breakdown is read over, as its heading says it. */
const SPEND_WINDOW_WORDS: Readonly<Record<BudgetWindow, string>> = {
  day: 'today',
  week: 'this week',
  month: 'this month',
  total: 'in total',
};

const SELECT_CLASS = 'rounded-md border border-line-input bg-inset px-2 py-1 text-sm';

/** `$1.85`, with the part the platform priced said beside it — an estimate is labelled one. */
const spendWords = (line: { readonly usd: number; readonly estimated_usd: number }): string =>
  line.estimated_usd > 0
    ? `${formatUsd(line.usd)} (${formatUsd(line.estimated_usd)} estimated)`
    : formatUsd(line.usd);

/**
 * Where the window's money went (S-25.7, research/21 F8): per stage, then the most expensive tasks —
 * `GET …/spend`, a projection over the cost ledger, cut where the budget windows are cut. A run
 * nothing could price is in no line, and the screen says the figures are what was booked.
 */
const SpendBreakdown = ({
  projectId,
  projectKey,
}: {
  readonly projectId: string | null;
  readonly projectKey: string;
}): ReactElement => {
  const [window, setWindow] = useState<BudgetWindow>('month');
  const spend = useProjectSpend(projectId, window);
  const words = SPEND_WINDOW_WORDS[window];

  return (
    <section className="flex flex-col gap-3" aria-label="Spend breakdown">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">
          {spend.data === undefined
            ? `Spent ${words}`
            : `Spent ${words}: ${spendWords(spend.data)}`}
        </h2>
        <select
          className={SELECT_CLASS}
          value={window}
          onChange={(event) => setWindow(event.target.value as BudgetWindow)}
          aria-label="Window"
        >
          {SPEND_WINDOWS.map((option) => (
            <option key={option} value={option}>
              {BUDGET_WINDOW_LABEL[option]}
            </option>
          ))}
        </select>
      </div>
      {spend.isPending ? <Skeleton label="Loading the spend…" lines={3} /> : null}
      {spend.isError ? (
        <ErrorNotice title="The spend could not be loaded." error={spend.error} />
      ) : null}
      {spend.data === undefined ? null : spend.data.stages.length === 0 ? (
        <Blankslate
          informational
          title={`Nothing was spent ${words}`}
          hint="Every agent run books its cost here once it ends, by stage and by task."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ListBox
            label="By stage"
            header={
              <ListBoxHeader>
                <span className="font-semibold text-fg">By stage</span>
              </ListBoxHeader>
            }
          >
            {spend.data.stages.map((line) => (
              <ListRow
                key={line.stage ?? '(none)'}
                // A stage id comes from the project's own pipeline file (BD-022); no stage is spend
                // outside the pipeline — a question asked of a task.
                title={
                  line.stage === null ? (
                    'Questions to an agent'
                  ) : (
                    <UntrustedText value={stageLabel(line.stage)} />
                  )
                }
                trailing={<span className="tabular-nums">{spendWords(line)}</span>}
              />
            ))}
          </ListBox>
          <ListBox
            label="Top tasks"
            header={
              <ListBoxHeader>
                <span className="font-semibold text-fg">Top tasks</span>
              </ListBoxHeader>
            }
          >
            {spend.data.top_tasks.map((task) => (
              <ListRow
                key={task.task_id}
                title={
                  <Link
                    to="/projects/$key/tasks/$taskId"
                    params={{ key: projectKey, taskId: task.task_id }}
                    {...rowLink('hover:text-link hover:underline')}
                  >
                    <UntrustedText value={task.ticket_key} className="font-mono" />
                    {task.ticket_title === null ? null : (
                      <>
                        {' · '}
                        <UntrustedText value={task.ticket_title} />
                      </>
                    )}
                  </Link>
                }
                {...(task.mode === 'shadow'
                  ? { meta: <Badge tone="warning">Trial run</Badge> }
                  : {})}
                trailing={<span className="tabular-nums">{spendWords(task)}</span>}
              />
            ))}
          </ListBox>
        </div>
      )}
      <p className="text-xs text-fg-muted">
        What the cost ledger booked since the window began, in the organisation’s timezone. An
        estimate is the platform’s own price for a run whose provider reported no cost; a run
        nothing could price is in no figure.
      </p>
    </section>
  );
};

/**
 * The project's Budgets tab — where its cap is both read **and set** (S-25.7, product/10's
 * 2026-11-06 IA amendment, research/21 F8): each cap as spent of limit on a native `<meter>` (the
 * semantic element carries the value, the range and the announcement, and needs no `style=`, which
 * the CSP's `style-src` admits none of), where the window's money went, and the cap editor —
 * `ProjectBudgets`, the one the wizard's step 4 draws — whose *Save budgets* is the page's one
 * primary action. Project settings point here rather than drawing a second editor.
 */
export const BudgetsScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  const budgets = useProjectBudgets(projectId);
  const items = budgets.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Caps">
        <h2 className="text-lg font-semibold">Budgets</h2>
        {budgets.isPending ? <Skeleton label="Loading budgets…" lines={3} /> : null}
        {budgets.isError ? (
          <ErrorNotice title="Budgets could not be loaded." error={budgets.error} />
        ) : null}
        {budgets.isSuccess && items.length === 0 ? (
          <Blankslate
            informational
            title="No cap is set"
            hint="Without a cap the pipeline spends whatever a stage asks for. A maintainer sets a daily, weekly, monthly or total cap below."
          />
        ) : null}
        {items.length === 0 ? null : (
          <ListBox label="Budgets">
            {items.map((budget) => {
              const share = budget.limit_usd === 0 ? 0 : budget.spent_usd / budget.limit_usd;
              return (
                <li key={budget.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-semibold">{BUDGET_WINDOW_LABEL[budget.window]}</span>
                    <span className="text-xs text-fg-muted">
                      {BUDGET_SCOPE_LABEL[budget.scope]}
                    </span>
                    <span className="ml-auto tabular-nums">
                      <span className="font-semibold">{formatUsd(budget.spent_usd)}</span>
                      {' of '}
                      <span>{formatUsd(budget.limit_usd)}</span>
                    </span>
                  </div>
                  <meter
                    aria-label="Cap used"
                    className="w-full"
                    min={0}
                    max={Math.max(budget.limit_usd, budget.spent_usd)}
                    high={budget.limit_usd * 0.8}
                    optimum={0}
                    value={budget.spent_usd}
                  >
                    {`${Math.round(share * 100)}%`}
                  </meter>
                  <p className="text-xs text-fg-muted">
                    {`${Math.round(share * 100)}% used · notified at ${budget.notify_pct.map((pct) => `${formatInteger(pct)}%`).join(', ')}`}
                  </p>
                </li>
              );
            })}
          </ListBox>
        )}
      </section>

      <SpendBreakdown projectId={projectId} projectKey={projectKey} />

      {projectId === null ? null : <ProjectBudgets projectId={projectId} primary />}
    </div>
  );
};

// ── Pipeline / effective configuration ───────────────────────────────────────

/** A source key that is `status_mapping` or one of its entries (`status_mapping.<stage>`). */
const isStatusMappingKey = (key: string): boolean =>
  key === 'status_mapping' || key.startsWith('status_mapping.');

/**
 * The Pipeline tab (S-23.5, TD-033 decision 8 (a)): the project's enabled templates as a canvas —
 * pick one, click a stage for its configuration — and, folded below it, the effective
 * configuration with the source of every key, which is what the tab was before the canvas.
 */
export const PipelineScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const projectId = useProjectId(projectKey);
  return (
    <div className="flex flex-col gap-4">
      <PipelineFlow projectId={projectId} />
      <DetailsDisclosure summary="Effective configuration">
        <EffectiveConfiguration projectId={projectId} />
      </DetailsDisclosure>
    </div>
  );
};

const EffectiveConfiguration = ({
  projectId,
}: {
  readonly projectId: string | null;
}): ReactElement => {
  const config = useProjectConfig(projectId);

  return (
    <div className="flex flex-col gap-3">
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      {config.isError ? (
        <ErrorNotice
          title="The effective configuration could not be loaded."
          error={config.error}
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
                  {/* WP-182: TD-029 decision 3's warning beside the key the lifecycle supersedes. */}
                  {config.data.status_mapping_superseded && isStatusMappingKey(key) ? (
                    <Badge tone="warning">
                      not applied — the ticket lifecycle maps the statuses
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
            {config.data.status_mapping_superseded ? (
              <div className="flex flex-col gap-1 pt-2" data-status-mapping="superseded">
                <p className="text-xs">
                  The project’s ticket lifecycle maps a moment other than <em>Pick up from</em>, so
                  the older status mapping is not applied at all. The moments are on the project
                  settings page.
                </p>
                <ForAdministrators note="status_mapping" />
              </div>
            ) : null}
          </Card>
          <Card>
            <SectionHeading>Merged configuration</SectionHeading>
            <p className="text-xs text-fg-muted">
              The repository’s settings file:{' '}
              {REPOSITORY_STATUS_LABEL[config.data.repository.status]}
              {config.data.repository.commit_sha === null ? null : (
                <>
                  {' at '}
                  <UntrustedText value={config.data.repository.commit_sha.slice(0, 12)} />
                </>
              )}
              . Where it states a key, it wins over the project settings.
            </p>
            <JsonView value={config.data.effective} />
          </Card>
          <p className="text-xs text-fg-muted">
            Read-only here. The settings are edited on the project settings page, which also
            proposes them to the repository as a merge request; a schema-aware YAML editor is not
            built.
          </p>
        </>
      )}
    </div>
  );
};
