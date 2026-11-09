/**
 * The task page's right rail (S-23.9b, research/19 § 5.2 "Task"): **Checks** as a GitHub merge box,
 * then the cost against the task's cap. The ticket and merge request links are the header's since
 * S-25.4 (product/10's Header amendment), beside the key.
 *
 * **What the Checks box shows, and what it cannot.** product/10:38 lists **eleven** merge-readiness
 * checks — acceptance criteria met, CI green, rebase status, review threads open/resolved, business
 * verdict, tamper check, coverage delta, dependency status, risk classes and required reviewers,
 * budget vs estimate, questions pending — and the box renders **all eleven** (twelve rows: the
 * document's *"risk classes and required reviewers"* is two), with approvals pending beside the
 * questions. Each row is a status icon, the label, the value — the label opens the definition in a
 * tooltip — and, where there is one, the **basis** sentence in the row's expandable detail. The
 * list is held to product/10:38 by `apps/web/src/features/checks-panel.test.tsx` › "the Checks panel
 * against product/10:38" **in both directions**, so neither this paragraph nor the box can go stale
 * on its own (WP-38, criterion 5; WP-46; WP-81). Where each value comes from is on its function in
 * `./task-checks-text.ts`: the gates' own `task_stages` rows (WP-46, WP-55), the review window's
 * `tasks.review_threads`, the latest Acceptance Verdict's body (WP-52's route), the tamper check off
 * the CI row and the rebase settlement after it (WP-81, WP-102, WP-105), the coverage delta (WP-39),
 * the dependency gate (WP-38) and the reviewers' routing (WP-37, WP-38).
 *
 * **The summary line** counts what the rows say and nothing else (`checksSummary`): a row that
 * needs a person, or — when none does — whether every required row passed. *Not reached*, *not
 * recorded* and *unavailable* are never a pass. **It counts checks, not the callout's items**
 * (S-25.4, product/10's Checks amendment): *Questions pending* and *Approvals pending* stay rows —
 * product/10:38 lists them — but they are the needs-you callout's, so the line leaves them out of
 * its count and says they are above instead of reading "3 checks need you" for one question.
 * **Before any check can run** (S-25.20: the task is at a stage before the checks start, and no
 * gate has a row) the line says when they start — *"Checks start at Implementation."* — neutral,
 * with no clock and no count of checks nobody could have decided yet.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { acceptanceVerdictDataSchema, reviewVerdictDataSchema } from '@platform/contracts';
import { ChevronRightIcon } from '@primer/octicons-react/ChevronRightIcon';
import { type ReactElement, type ReactNode, useId } from 'react';
import { useArtifactBody } from '../app/queries.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { titleCase } from '../ui/humanize.js';
import { Badge, Card, ErrorReason, formatMinutes, formatUsd, Metric } from '../ui/kit.js';
import { type Status, StatusIcon } from '../ui/status.js';
import { Tooltip } from '../ui/tooltip.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { ManualNotRunLinks, ManualNotRunValue } from './ci-manual-not-run.js';
import { unmeasuredRunsText } from './cost-text.js';
import {
  CRITERION_STATUS,
  checklistsAppliedLines,
  checksNotStartedText,
  checksSummary,
  coverageBasisText,
  coverageStatus,
  coverageValueText,
  criteriaStatus,
  criteriaValueText,
  dependencyBasisText,
  dependencyStatus,
  dependencyValueText,
  estimateBasisText,
  estimateStatus,
  gateBasisText,
  gateStatus,
  gateValueText,
  humanTimeBreakdown,
  humanTimeWithheldText,
  keyedCriteria,
  latestAcceptanceVerdict,
  latestReviewVerdict,
  latestStageRow,
  reviewersBasisText,
  reviewersStatus,
  reviewersValueText,
  reviewThreadsBasisText,
  reviewThreadsStatus,
  reviewThreadsValueText,
  tamperStatus,
  tamperValueText,
} from './task-checks-text.js';

/** One row of the merge box. */
export interface CheckRowData {
  /** Stable, for the key and `data-check`. */
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly status: Status;
  readonly definition: string;
  /** What the value rests on: shown when the row is expanded. */
  readonly basis?: ReactNode;
  /** Whether the summary's *"All required checks pass"* waits on it. */
  readonly required: boolean;
  /** A question or an approval: the callout's item, never counted as a check (S-25.4). */
  readonly callout?: boolean;
}

/** A callout item's row value: the count, and where it is answered when there is one. */
const calloutItemValue = (count: number): string => (count === 0 ? '0' : `${count} · see above`);

/**
 * A row: icon, label, value — the label next to the value with nothing between them, so a reader
 * (and `checks-panel.test.tsx`) reads *"Tamper checkclean"* as one fact. The definition is the
 * label's tooltip and, for assistive tech, its `aria-describedby`, as `Metric` attaches one.
 */
const CheckRow = ({ row }: { readonly row: CheckRowData }): ReactElement => {
  const id = useId();
  const head = (
    <>
      <StatusIcon status={row.status} className="mt-0.5" />
      <Tooltip content={row.definition}>
        {/* A focusable span, not a button: the label opens a definition, it performs nothing. */}
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a tooltip trigger must be reachable by Tab, or the definition is mouse-only.
          tabIndex={0}
          aria-describedby={id}
          className={cx(
            'rounded-sm text-fg underline decoration-fg-subtle decoration-dotted underline-offset-4',
            FOCUS_RING,
          )}
        >
          {row.label}
        </span>
      </Tooltip>
      <span className="ml-auto min-w-0 text-right font-medium break-words text-fg-muted">
        {row.value}
      </span>
    </>
  );
  return (
    <li data-check={row.id} data-check-status={row.status} className="px-3 py-2 text-xs">
      {row.basis === undefined ? (
        <div className="flex items-start gap-2">{head}</div>
      ) : (
        <details className="group">
          <summary
            className={cx(
              'flex cursor-pointer list-none items-start gap-2 rounded-sm [&::-webkit-details-marker]:hidden',
              FOCUS_RING,
            )}
          >
            {head}
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex text-fg-subtle transition-transform group-open:rotate-90"
            >
              <ChevronRightIcon size={12} />
            </span>
          </summary>
          <div className="mt-1.5 flex flex-col gap-1 pl-6 text-[11px] text-fg-muted">
            {row.basis}
          </div>
        </details>
      )}
      <span id={id} hidden>
        {row.definition}
      </span>
    </li>
  );
};

const VERDICT_DEFINITION =
  'The business review’s verdict on this change, from its latest Acceptance Verdict.';
const CRITERIA_DEFINITION =
  'The acceptance criteria the business review judged, from the same verdict, each with the reviewer’s evidence.';

/**
 * **Business verdict** and **acceptance criteria met** (WP-46, backlog 95 items 4 and 5): the
 * latest `AcceptanceVerdict`'s own `verdict` and `criteria[]`, read through the artifact route
 * WP-52 built (`GET /api/artifacts/:id`) — a field that already exists, not a derivation.
 *
 * The body is model output (BD-022): each criterion's id and evidence is rendered through
 * `UntrustedText`. A body the route refuses — an artifact stored before redaction existed, answered
 * `409 artifact_not_redacted` — is named as such rather than drawn as "no verdict", and a body that
 * does not parse as an `AcceptanceVerdict` says so rather than guessing at its fields.
 */
const useAcceptanceRows = (
  taskId: string,
  artifacts: TaskDetailResponse['artifacts'],
): readonly [CheckRowData, CheckRowData] => {
  const latest = latestAcceptanceVerdict(artifacts);
  const body = useArtifactBody(taskId, latest?.id ?? null);
  const rows = (
    verdict: Omit<CheckRowData, 'id' | 'label' | 'definition' | 'required'>,
    criteria: Omit<CheckRowData, 'id' | 'label' | 'definition' | 'required'>,
  ): readonly [CheckRowData, CheckRowData] => [
    {
      id: 'acceptance-criteria',
      label: 'Acceptance criteria',
      definition: CRITERIA_DEFINITION,
      required: true,
      ...criteria,
    },
    {
      id: 'business-verdict',
      label: 'Business verdict',
      definition: VERDICT_DEFINITION,
      required: true,
      ...verdict,
    },
  ];
  if (latest === null) {
    const basis = 'No business review has produced an Acceptance Verdict on this task.';
    return rows(
      { value: 'no verdict', status: 'queued', basis },
      { value: 'not judged', status: 'queued', basis },
    );
  }
  if (body.isPending) {
    return rows({ value: 'reading…', status: 'queued' }, { value: 'reading…', status: 'queued' });
  }
  const parsed = body.isError ? null : acceptanceVerdictDataSchema.safeParse(body.data.data);
  if (parsed === null || !parsed.success) {
    const basis = body.isError ? (
      <ErrorReason
        lead={`The Acceptance Verdict v${latest.version} was not served:`}
        error={body.error}
      />
    ) : (
      <UntrustedText
        value={`The Acceptance Verdict v${latest.version} does not read as one, so nothing is shown from it.`}
      />
    );
    return rows(
      { value: 'unavailable', status: 'skipped', basis },
      { value: 'unavailable', status: 'skipped', basis },
    );
  }
  const verdict = parsed.data;
  return rows(
    {
      value: verdict.verdict === 'approve' ? 'approved' : 'changes requested',
      status: verdict.verdict === 'approve' ? 'success' : 'failure',
      basis: `Acceptance Verdict v${latest.version}.`,
    },
    {
      value: criteriaValueText(verdict),
      status: criteriaStatus(verdict),
      ...(verdict.criteria.length === 0
        ? {}
        : {
            basis: (
              <ul className="flex flex-col gap-0.5">
                {keyedCriteria(verdict).map(({ key, criterion }) => (
                  <li key={key}>
                    {`${CRITERION_STATUS[criterion.status] ?? criterion.status} · `}
                    <UntrustedText value={`${criterion.id} — ${criterion.evidence}`} />
                  </li>
                ))}
              </ul>
            ),
          }),
    },
  );
};

/**
 * **Which review checklists the Reviewer was given** (WP-73, PROGRESS backlog 217): the platform's
 * own record on the latest Review Verdict (WP-45), read through the artifact route as the
 * Acceptance Verdict is — shown in the risk classes' detail rather than as a twelfth item, because
 * product/10:38's eleven are held both ways by `checks-panel.test.tsx`. The list names are project
 * configuration and go through `UntrustedText` like every other string on this rail.
 */
const useReviewChecklistLines = (
  taskId: string,
  artifacts: TaskDetailResponse['artifacts'],
): readonly string[] | null => {
  const latest = latestReviewVerdict(artifacts);
  const body = useArtifactBody(taskId, latest?.id ?? null);
  if (latest === null || body.isPending) {
    return null;
  }
  const parsed = body.isError ? null : reviewVerdictDataSchema.safeParse(body.data.data);
  return parsed === null || !parsed.success
    ? [`Review checklists: unavailable — the Review Verdict v${latest.version} was not read.`]
    : checklistsAppliedLines(parsed.data.checklists_applied);
};

/** The registry pages of the packages the gate found, when the platform asked one and it answered. */
const DependencyLinks = ({ task }: { readonly task: TaskRecord }): ReactElement | null => {
  const added = task.dependencies?.added ?? [];
  if (!added.some((entry) => entry.metadata.source_url !== null)) {
    return null;
  }
  // Composed by the platform from the encoded name rather than taken from a model or a manifest —
  // and still through `safeHref` like every URL this application renders, because a DTO field is
  // `z.url()` and `z.url()` accepts `data:` (Q49).
  return (
    <ul className="flex flex-wrap gap-2">
      {added.map((entry) =>
        entry.metadata.source_url === null ? null : (
          <li key={`${entry.ecosystem}:${entry.name}`}>
            <ExternalLink
              url={entry.metadata.source_url}
              label={`${entry.ecosystem}:${entry.name}`}
              className="text-link underline"
            />
          </li>
        ),
      )}
    </ul>
  );
};

/** The twelve rows, in the merge box's order: what gates the merge first, then the facts. */
const useCheckRows = (detail: TaskDetailResponse): readonly CheckRowData[] => {
  const { task, stages, artifacts, questions, approvals } = detail;
  const [criteria, verdict] = useAcceptanceRows(task.id, artifacts);
  const checklists = useReviewChecklistLines(task.id, artifacts);
  const ciGate = latestStageRow(stages, 'ci_gate');
  const ciValue = gateValueText(ciGate, { pass: 'green', fail: 'red' });
  // S-27.2 (TD-036 decision 5): a pass that left manual jobs nobody started says which.
  const notRun =
    ciGate?.state === 'completed' && ciValue === 'green'
      ? (detail.ci_manual_not_run ?? null)
      : null;
  const rebaseGate = latestStageRow(stages, 'rebase_gate');
  const openQuestions = questions.filter((question) => question.status === 'open').length;
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending').length;
  return [
    {
      id: 'ci',
      label: 'CI status',
      value: notRun === null ? ciValue : <ManualNotRunValue notRun={notRun} />,
      status: gateStatus(ciGate),
      definition:
        "The CI check's verdict on the merge request's latest commit, from the git host's own pipeline; when it needs you, it says why it could not decide.",
      // The jobs' pages are linked here, in the basis, never inside the row's `<summary>`.
      basis:
        notRun === null ? (
          gateBasisText(ciGate, 'ci_gate')
        ) : (
          <>
            {gateBasisText(ciGate, 'ci_gate')} <ManualNotRunLinks notRun={notRun} />
          </>
        ),
      required: true,
    },
    {
      id: 'tamper',
      label: 'Protected files',
      value: tamperValueText(ciGate, rebaseGate, detail.stop),
      status: tamperStatus(ciGate, rebaseGate),
      definition:
        'Whether the change edits, deletes or renames files this project protects (tests and CI or lint configuration by default). A change the plan declared is allowed once the code review confirms it; anything else sends the task back to the developer, naming the files. Adding a new file is never flagged. A check made before the platform kept its result is never shown as passed.',
      required: true,
    },
    {
      id: 'rebase',
      label: 'Up to date',
      value: gateValueText(rebaseGate, { pass: 'yes', fail: 'conflicts' }),
      status: gateStatus(rebaseGate),
      definition:
        'Whether the merge request merges cleanly onto the project’s default branch as it is now. It is checked again every time the default branch moves while the task waits for its merge, and whenever a person brings the task back to Ready.',
      basis: gateBasisText(rebaseGate, 'rebase_gate'),
      required: true,
    },
    {
      id: 'review-threads',
      label: 'Review threads',
      value: reviewThreadsValueText(task.review_threads),
      status: reviewThreadsStatus(task.review_threads),
      definition:
        "Human review threads on the merge request, as the review window last read them: open threads send the task back to Implementation with the reviewers' comments.",
      basis: reviewThreadsBasisText(task.review_threads),
      required: true,
    },
    verdict,
    criteria,
    {
      id: 'dependencies',
      label: 'Dependencies',
      value: dependencyValueText(task.dependencies, task.state),
      status: dependencyStatus(task.dependencies, task.state),
      definition:
        "Packages this change adds to a manifest or lockfile, and what the project's policy did about them: 'allow' proceeds, 'ask' raises the question below, 'block' sends the task back. Licence and last release come from a package registry an operator has declared; with none declared the platform asks nobody and says so.",
      // Package names, manifest paths and a registry's licence string — third-party text (BD-022).
      basis: (
        <>
          <UntrustedText value={dependencyBasisText(task.dependencies, task.state)} />
          <DependencyLinks task={task} />
        </>
      ),
      required: true,
    },
    {
      id: 'questions',
      label: 'Questions pending',
      value: calloutItemValue(openQuestions),
      status: openQuestions > 0 ? 'needs_you' : 'success',
      definition:
        'Open questions blocking or accompanying this task. Each one is answered in the box above, under the header.',
      required: true,
      callout: true,
    },
    {
      id: 'approvals',
      label: 'Approvals pending',
      value: calloutItemValue(pendingApprovals),
      status: pendingApprovals > 0 ? 'needs_you' : 'success',
      definition:
        'Plan, budget, knowledge or rework approvals awaiting a maintainer. Each one is decided in the box above, under the header.',
      required: true,
      callout: true,
    },
    {
      id: 'coverage',
      label: 'Test coverage',
      value: coverageValueText(task.coverage),
      status: coverageStatus(task.coverage),
      definition:
        "How much of the code the tests cover with this change, minus how much they cover on the default branch, in percentage points. Shown when the CI pipeline reports coverage; 'not reported' means it does not, which is never the same as zero.",
      // A branch name and two revisions — repository text somebody chose (BD-022).
      basis: <UntrustedText value={coverageBasisText(task.coverage)} />,
      required: false,
    },
    {
      id: 'estimate',
      label: 'Estimate',
      value: task.estimate_usd === null ? 'none' : formatUsd(task.estimate_usd),
      status: estimateStatus(task),
      definition:
        "Predicted at refinement from this project's finished tasks, before the work ran; above the project's threshold it waits for a budget approval.",
      basis: estimateBasisText(task),
      required: false,
    },
    {
      id: 'reviewers',
      label: 'Required reviewers',
      value: reviewersValueText(task.required_reviewers),
      status: reviewersStatus(task.required_reviewers),
      definition:
        "Who this merge request needs a review from, as the platform chose them: the code owners file on the default branch first, then the project's reviewers setting, then the person who asked — plus anyone a sensitive area requires. A name with no account on the git host is shown rather than dropped.",
      // The handles are untrusted: `CODEOWNERS` is written by whoever can push to the repository.
      basis: <UntrustedText value={reviewersBasisText(task.required_reviewers)} />,
      required: false,
    },
    {
      id: 'risk',
      label: 'Sensitive areas',
      value:
        task.risk_classes.length === 0 ? (
          'none'
        ) : (
          <span className="inline-flex flex-wrap justify-end gap-1">
            {task.risk_classes.map((risk) => (
              <Badge key={risk} tone="warning">
                {titleCase(risk)}
              </Badge>
            ))}
          </span>
        ),
      status: task.risk_classes.length === 0 ? 'success' : 'waiting',
      definition:
        'The parts of the code this project marks as sensitive (its risk classes) that this change touches; an area can require its own reviewers and its own review checklist.',
      ...(checklists === null
        ? {}
        : {
            basis: (
              <ul className="flex flex-col gap-0.5">
                {checklists.map((line) => (
                  <li key={line}>
                    <UntrustedText value={line} />
                  </li>
                ))}
              </ul>
            ),
          }),
      required: false,
    },
  ];
};

/** The merge box: the summary line, then the rows. */
const ChecksBox = ({ detail }: { readonly detail: TaskDetailResponse }): ReactElement => {
  const rows = useCheckRows(detail);
  // S-25.20: before any check can run, the line says when they start — neutral, not a count.
  const summary = checksSummary(rows, checksNotStartedText(detail.task, detail.stages));
  return (
    <section
      aria-labelledby="task-checks-heading"
      className="rounded-md border border-line bg-default"
    >
      <div className="flex flex-col gap-1 border-b border-line bg-subtle px-3 py-2">
        <h2 id="task-checks-heading" className="text-sm font-semibold">
          Checks
        </h2>
        <p data-checks-summary={summary.status} className="flex items-center gap-2 text-sm">
          <StatusIcon status={summary.status} decorative />
          <span>{summary.text}</span>
        </p>
        {summary.callout === null ? null : (
          <p data-checks-callout="" className="text-xs text-fg-muted">
            {summary.callout}
          </p>
        )}
      </div>
      <ul aria-label="Merge-readiness checks" className="divide-y divide-line">
        {rows.map((row) => (
          <CheckRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
};

/**
 * The money, and the minutes beside it. *"Cost so far"* is the provider-reported sum of the measured
 * runs (WP-131 says what it leaves out); the meter draws it against the task's cap, a `<meter>` with
 * no `style=`; *"Human time"* is product/09:29's *"total cost of delivery"* in the only honest form
 * this build can print it (WP-29, Q73): the dollars and the minutes are two numbers side by side and
 * nothing here adds them — a single figure needs an hourly rate no document or setting supplies.
 */
const CostBox = ({ detail }: { readonly detail: TaskDetailResponse }): ReactElement => {
  const { task, human_time: humanTime } = detail;
  const withheld = humanTimeWithheldText(humanTime);
  return (
    <Card className="flex flex-col gap-3">
      <Metric
        label="Cost so far"
        value={formatUsd(task.cost_actual_usd)}
        definition="Provider-reported cost of every measured run on this task; on a Claude subscription, cost is estimated. A run that ended without a figure is left out of the sum, and counted beneath it when there is one."
      />
      <div className="-mt-2 flex flex-col gap-1">
        <meter
          aria-label="Spent of this task's cap"
          min={0}
          max={task.budget_cap_usd}
          value={Math.min(task.cost_actual_usd, task.budget_cap_usd)}
          className="h-2 w-full"
        />
        <p className="text-[11px] text-fg-muted">
          {`${formatUsd(task.cost_actual_usd)} of ${formatUsd(task.budget_cap_usd)} cap`}
        </p>
      </div>
      {task.unmeasured_runs > 0 ? (
        <p className="-mt-2 text-[11px] text-fg-muted">
          {unmeasuredRunsText(task.unmeasured_runs)}
        </p>
      ) : null}
      <Metric
        label="Estimate accuracy"
        value={
          task.estimate_accuracy === null ? 'not yet' : `${task.estimate_accuracy.toFixed(2)}×`
        }
        definition="What the task has spent, divided by the estimate: 1.00× is on the nose, 2.00× is twice what was predicted. Computed from those two numbers and nothing else."
      />
      <Metric
        label="People’s time"
        value={
          humanTime.entries === 0
            ? 'none recorded'
            : // Dollars are the agents' cost, never "tokens" (S-23.23, the UX audit's § 4).
              `${formatUsd(task.cost_actual_usd)} · ${formatMinutes(humanTime.total_minutes)} of people’s time`
        }
        definition="Human minutes derived from events, never from tracking: review from the first human comment on the merge request to the merge, capped at 8 h per calendar day and excluding gaps over 2 h; 30 min per question; 10 min flat per approval; 5 min flat per message to an agent. The dollars and the minutes are shown side by side and are never added: that would need an hourly rate this platform does not have."
      />
      <p className="-mt-2 text-[11px] text-fg-muted">{humanTimeBreakdown(humanTime)}</p>
      {withheld === null ? null : <p className="-mt-2 text-[11px] text-fg-muted">{withheld}</p>}
      {humanTime.by_user === null ? null : (
        <ul className="-mt-1 flex flex-col gap-0.5">
          {humanTime.by_user.map((entry) => (
            <li
              key={entry.user_id ?? entry.external_author ?? 'unattributed'}
              className="flex justify-between text-[11px] text-fg-muted"
            >
              {/*
                `user_name` is a platform user's own name and `external_author` is a provider
                account id — somebody else's text either way (BD-022).
              */}
              <UntrustedText
                value={entry.user_name ?? entry.external_author ?? 'unmapped account'}
              />
              <span>{formatMinutes(entry.minutes)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

export const TaskChecksRail = ({
  detail,
}: {
  readonly detail: TaskDetailResponse;
}): ReactElement => (
  <aside aria-label="Checks and cost" className="flex min-w-0 flex-col gap-3">
    <ChecksBox detail={detail} />
    <CostBox detail={detail} />
  </aside>
);
