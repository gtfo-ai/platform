/**
 * **New project** — the setup wizard (product/06 § "Flow (UI wizard, resumable, each step
 * skippable)", WP-21; a real wizard since S-23.8, TD-033 decision 9, research/19 § 6).
 *
 * `/onboarding?project=<key>&step=<id>`: a Stepper on the left (done ✓ / current ● / upcoming ○,
 * *Optional* on the two optional steps), the step on the right — its title, one sentence saying
 * what it does, the step's controls and a footer with *Back to …* and *Continue to …*. The step
 * ids, their order and what *done* means are `onboarding-steps.ts`, and the rules there are the
 * whole of the navigation: forward is refused past a required step that is not done, done steps
 * are free to revisit, and with no `?step=` the wizard resumes at the first step not done.
 *
 * ## The state is the server's
 *
 * Every step is a command on its own endpoint, and whether a step is done is a read — which
 * project exists, what is bound, whether a readiness evaluation exists, what the knowledge queue
 * holds, whether the operating mode was saved. So *Save and exit* saves nothing (there is nothing
 * unsaved) and resuming is pointing at the project again. *Skip for now* records nothing either.
 * `/onboarding` with no project is a **new** project: the wizard never guesses which existing one
 * was meant.
 *
 * ## The steps
 *
 * - **Connect** (`onboarding-connect.tsx`): project details, integrations, ticket lifecycle.
 * - **Technical discovery** starts the Discovery agent and shows the readiness evaluation it
 *   records as a meter, the criteria by their human names (the ids behind *Details*), product/17's
 *   cheapest improvements and the CI-rules notices; where the discovery is now is
 *   `discovery-status.tsx`, read back on load and followed live (WP-155, backlog 452).
 * - **Business context** (optional) is `business-interview.tsx` (WP-64); its answers become
 *   proposals, never commits.
 * - **History** (optional) is `history-bootstrap.tsx` (WP-35), which shows its estimate before it
 *   starts anything.
 * - **How autonomous** is `operating-mode.tsx`: the dial, the features, the risk classes, the
 *   budgets and the notifications.
 * - **Review and finish** sums up what was set, links the knowledge queue and the settings page's
 *   export of the configuration (WP-63, Q94), and ends on *Open the board*.
 *
 * Every component a step renders is the one the project settings page renders, which is how
 * product/18:55's "settings mirror the wizard" stays true without two copies;
 * `apps/server/src/routes/settings-mirror.test.ts` follows this file's relative imports to check it,
 * so the steps are imported statically.
 *
 * ## Every string from the server is data
 *
 * The readiness evidence is the Discovery agent's own words about a repository the platform does
 * not control (BD-022), and so is everything a provider or a person typed. All of it goes through
 * `ui/untrusted.tsx`; nothing here builds markup from a string or writes a URL attribute.
 */
import type { ProjectSummary, ReadinessResponse } from '@platform/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useRef } from 'react';
import {
  useHistoryBootstraps,
  useKbProposals,
  useOnboardingCommands,
  useProjectAutonomy,
  useProjectBindings,
  useProjectReadiness,
  useProjects,
  useRediscoveryGate,
} from '../app/queries.js';
import { ForAdministrators } from '../ui/admin-notes.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { DetailsDisclosure } from '../ui/details.js';
import { readinessCriterionLabel } from '../ui/humanize.js';
import { Badge, Button, ErrorNotice, formatDateTime, formatUsd } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { type Step, Stepper } from '../ui/stepper.js';
import { UntrustedText } from '../ui/untrusted.js';
import { BusinessInterview } from './business-interview.js';
import { DefaultBranchMismatch } from './default-branch.js';
import { DiscoveryStatus } from './discovery-status.js';
import { HistoryBootstrap } from './history-bootstrap.js';
import { ConnectStep } from './onboarding-connect.js';
import {
  blockingStepOf,
  continueBlockerOf,
  donenessOf,
  nextStep,
  previousStep,
  resumeStepOf,
  WIZARD_STEP_IDS,
  WIZARD_STEPS,
  type WizardDoneness,
  type WizardFacts,
  type WizardStepId,
} from './onboarding-steps.js';
import { AUTONOMY_CHOICES, OperatingMode } from './operating-mode.js';
import { readinessWord } from './readiness-label.js';
import { ReadinessNotices } from './readiness-notices.js';
import { StepActionToneContext, useStepActionTone } from './step-action-tone.js';

/** A knowledge proposal still waiting for a maintainer (the knowledge screen's Approve/Reject). */
const AWAITING_REVIEW = new Set(['scored', 'queued', 'apply_failed']);

/**
 * The wizard's reads, and the facts `onboarding-steps.ts` decides with. A read that **failed** is
 * a step not done — never a step done — so a failure can hold *Continue* but never skips anybody
 * past anything; a read still in flight is `null`.
 */
const useWizardReads = (projectId: string | null) => {
  const bindings = useProjectBindings(projectId);
  const readiness = useProjectReadiness(projectId);
  const proposals = useKbProposals(projectId);
  const history = useHistoryBootstraps(projectId, null);
  const autonomy = useProjectAutonomy(projectId);
  // Read here as well as in the discovery step, so the step list can say a discovery is running.
  const gate = useRediscoveryGate(projectId);

  /**
   * The last answer each fact had, kept while its read is fetched again. A read that failed goes
   * back to *pending* when a component mounts another observer of it (react-query's retry on mount
   * — the discovery step's own readiness read does exactly that), and a fact that flickered to
   * "unknown" would swap the step for the skeleton, unmount that component and start again: a loop
   * measured at ~1 800 renders before this was added.
   */
  const settled = useRef<Partial<Record<keyof WizardFacts, boolean>>>({});
  const fact = <T,>(
    name: keyof WizardFacts,
    query: { readonly isSuccess: boolean; readonly isError: boolean; readonly data?: T },
    answer: (data: T) => boolean,
  ): boolean | null => {
    const now =
      query.isSuccess && query.data !== undefined
        ? answer(query.data)
        : query.isError
          ? false
          : null;
    if (now !== null) {
      settled.current[name] = now;
    }
    return now ?? settled.current[name] ?? null;
  };

  const items = proposals.data?.items ?? [];
  const facts: WizardFacts = {
    projectExists: projectId !== null,
    trackerBound: fact('trackerBound', bindings, (data) =>
      data.items.some((item) => item.type === 'task_management'),
    ),
    gitBound: fact('gitBound', bindings, (data) => data.items.some((item) => item.type === 'git')),
    // The 409 a project with no evaluation gets is the answer "not yet".
    readinessEvaluated: fact('readinessEvaluated', readiness, () => true),
    businessProposed: fact('businessProposed', proposals, (data) =>
      data.items.some((item) => item.kind === 'business'),
    ),
    historyStarted: fact('historyStarted', history, (data) => data.items.length > 0),
    operatingModeSaved: fact('operatingModeSaved', autonomy, (data) => data.materialised),
    proposalsReviewed: fact('proposalsReviewed', proposals, (data) =>
      data.items.every((item) => !AWAITING_REVIEW.has(item.status)),
    ),
  };
  return {
    facts,
    bindings,
    readiness,
    autonomy,
    history,
    discoveryRunning: gate.data?.blocker?.code === 'discovery_in_flight',
    ceilingUsd: gate.data?.ceiling_usd ?? null,
    awaitingReview: items.filter((item) => AWAITING_REVIEW.has(item.status)).length,
    businessPages: items.filter((item) => item.kind === 'business').length,
  };
};

type WizardReads = ReturnType<typeof useWizardReads>;

/** A link to one step of the wizard, for one project. */
const StepLink = ({
  projectKey,
  step,
  className,
  children,
}: {
  readonly projectKey: string;
  readonly step: WizardStepId;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement => (
  <Link to="/onboarding" search={{ project: projectKey, step }} className={className}>
    {children}
  </Link>
);

// ── Technical discovery ──────────────────────────────────────────────────────

const CRITERION_STATUS = (criterion: ReadinessResponse['criteria'][number]) =>
  criterion.passed
    ? ({ status: 'success', word: 'Passed' } as const)
    : criterion.not_checked
      ? ({ status: 'skipped', word: 'Not checked' } as const)
      : ({ status: 'failure', word: 'Not met' } as const);

/** The readiness evaluation: a meter, the improvements, the notices and the criteria. */
const ReadinessPanel = ({ readiness }: { readonly readiness: ReadinessResponse }): ReactElement => (
  <div className="flex flex-col gap-3" data-testid="readiness-panel">
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-base font-semibold">Readiness level {readiness.level}</span>
        <span className="text-sm text-fg-muted">
          {readinessWord(readiness.level)} · evaluated {formatDateTime(readiness.evaluated_at)}
        </span>
      </div>
      {/* A native <meter>, as the budgets screen's: the element carries the value and the range. */}
      <meter
        aria-label="Readiness level"
        className="w-full max-w-md"
        min={0}
        max={Math.max(4, readiness.level)}
        value={readiness.level}
      >
        {`${readiness.level} of 4`}
      </meter>
    </div>
    {/* WP-143: the CI-rules warning or note, beside the level it does not change. */}
    <ReadinessNotices notices={readiness.notices} />
    {readiness.next_improvements.length > 0 ? (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold">Cheapest improvements next</p>
        <ul className="flex flex-col gap-0.5">
          {readiness.next_improvements.map((item) => (
            <li key={item.id} className="text-sm">
              {item.title} — <span className="text-fg-muted">{item.unlocks}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    <ul aria-label="Readiness criteria" className="flex flex-col gap-2">
      {readiness.criteria.map((criterion) => {
        const look = CRITERION_STATUS(criterion);
        return (
          <li key={criterion.id} data-criterion={criterion.id} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusIcon status={look.status} label={look.word} />
              <span className="font-medium">{readinessCriterionLabel(criterion.id)}</span>
              {/* BD-026's 2026-10-06 amendment: the workspace could not run it — not a fail. */}
              {criterion.not_checked ? <Badge tone="warning">not checked</Badge> : null}
              <span className="text-xs text-fg-muted">{criterion.unlocks}</span>
            </div>
            <DetailsDisclosure summary="Details" className="pl-6">
              <p className="text-xs text-fg-muted">
                Criterion {criterion.id} · {look.word} · answered by{' '}
                {criterion.detected_by === 'platform' ? 'the platform' : 'the Discovery agent'}
              </p>
              {/* The agent's own words about someone else's repository (BD-022). */}
              <p className="text-xs">
                <UntrustedText value={criterion.evidence} />
              </p>
            </DetailsDisclosure>
          </li>
        );
      })}
    </ul>
  </div>
);

const DiscoveryStep = ({
  project,
  reads,
}: {
  readonly project: ProjectSummary;
  readonly reads: WizardReads;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const { readiness } = reads;
  // The step's own action: the beacon until discovery has evaluated the project (S-23.23).
  const actionTone = useStepActionTone();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          tone={actionTone}
          disabled={commands.startDiscovery.isPending}
          onClick={() => {
            commands.startDiscovery.mutate(project.id);
          }}
        >
          {reads.ceilingUsd === null
            ? 'Run discovery'
            : `Run discovery — up to ${formatUsd(reads.ceilingUsd)}`}
        </Button>
      </div>
      {commands.startDiscovery.isSuccess ? (
        <p className="text-sm">
          <UntrustedText value={commands.startDiscovery.data.detail} />
        </p>
      ) : null}
      {commands.startDiscovery.isError ? (
        <ErrorNotice title="Discovery was not started." error={commands.startDiscovery.error} />
      ) : null}
      {/* WP-155 (backlog 452): the discovery task read back — on load, after a refresh, and live. */}
      <DiscoveryStatus projectId={project.id} projectKey={project.key} />
      {/* WP-142: beside the readiness panel, the provider's default when it is not the stored one. */}
      <DefaultBranchMismatch projectId={project.id} />
      {readiness.isSuccess ? <ReadinessPanel readiness={readiness.data} /> : null}
      {readiness.isError ? (
        <p className="text-sm text-fg-muted">
          No readiness evaluation yet — running discovery is what records one.
        </p>
      ) : null}
    </div>
  );
};

// ── Review and finish ────────────────────────────────────────────────────────

const Fact = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement => (
  <div className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)]">
    <dt className="text-sm text-fg-muted">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
);

const FinishStep = ({
  project,
  reads,
}: {
  readonly project: ProjectSummary;
  readonly reads: WizardReads;
}): ReactElement => {
  const bound = reads.bindings.data?.items ?? [];
  const level = reads.autonomy.data?.level ?? null;
  const batches = reads.history.data?.items.length ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <dl aria-label="What was set" className="flex flex-col gap-2">
        <Fact label="Project">
          <UntrustedText value={project.name} /> · <UntrustedText value={project.key} />
        </Fact>
        <Fact label="Integrations">
          {bound.length === 0 ? (
            'None bound'
          ) : (
            <UntrustedText value={bound.map((item) => item.name).join(', ')} />
          )}
        </Fact>
        <Fact label="Readiness">
          {reads.readiness.isSuccess
            ? `Level ${reads.readiness.data.level} — ${readinessWord(reads.readiness.data.level)}`
            : 'Not evaluated yet'}
        </Fact>
        <Fact label="Business context">
          {reads.businessPages === 0
            ? 'Skipped — it can be answered later from the settings'
            : `${reads.businessPages} page${reads.businessPages === 1 ? '' : 's'} proposed`}
        </Fact>
        <Fact label="History">
          {batches === 0
            ? 'Skipped — it can be started later from the settings'
            : `${batches} batch${batches === 1 ? '' : 'es'} started`}
        </Fact>
        <Fact label="Operating mode">
          {level === null || reads.autonomy.data?.materialised !== true
            ? 'Not saved yet'
            : (AUTONOMY_CHOICES.find((choice) => choice.level === level)?.label ?? level)}
        </Fact>
        <Fact label="Waiting for your review">
          {reads.awaitingReview === 0
            ? 'Nothing — every drafted page has been decided'
            : `${reads.awaitingReview} drafted page${reads.awaitingReview === 1 ? '' : 's'}`}
        </Fact>
      </dl>
      <ul className="flex flex-col gap-1 text-sm">
        <li>
          <Link
            to="/projects/$key/knowledge"
            params={{ key: project.key }}
            className="text-link underline"
          >
            Review the drafted pages
          </Link>{' '}
          <span className="text-fg-muted">
            — nothing an agent drafted is in your repository until you approve it.
          </span>
        </li>
        <li>
          {/* WP-63, Q94 (c): the configuration's merge request is a button on the settings page. */}
          <Link
            to="/projects/$key/settings"
            params={{ key: project.key }}
            className="text-link underline"
          >
            Propose the settings to the repository
          </Link>{' '}
          <span className="text-fg-muted">— as a merge request, from the project’s settings.</span>
        </li>
      </ul>
      <DetailsDisclosure summary="Learn more">
        <p className="text-xs text-fg-muted">
          Approving a drafted page commits it on an <code>agentic/knowledge/*</code> branch with a
          merge request — never onto the default branch. The settings are proposed as the
          repository’s settings file and a <code>CLAUDE.md</code> pointer in a merge request; once
          merged, the file wins over these settings.
        </p>
        <ForAdministrators note="repository_config" />
      </DetailsDisclosure>
    </div>
  );
};

// ── The frame ────────────────────────────────────────────────────────────────

/** Each step's one sentence: what it does, how long, what it costs where that is known. */
const purposeOf = (step: WizardStepId, reads: WizardReads | null): string => {
  switch (step) {
    case 'connect':
      return 'Name the project, point it at its repository and bind the integrations it uses. A few minutes; nothing is charged.';
    case 'discovery':
      return `An agent reads your repository and reports how ready it is for agents. It is one agent run, usually some minutes long, and costs ${
        reads?.ceilingUsd === null || reads === null
          ? 'what one run costs'
          : `at most ${formatUsd(reads.ceilingUsd)}`
      }.`;
    case 'business':
      return 'Tell the agents what the product is for, in your own words. Fifteen to thirty minutes; no agent runs, so nothing is charged.';
    case 'history':
      return 'Start the knowledge base from the project’s merged history. The estimated cost is shown before anything starts.';
    case 'autonomy':
      return 'Choose how much the agents may do before a person approves, and which features are on. Change it any time in the project’s settings.';
    case 'finish':
      return 'What was set, what waits for your review, and where to go next.';
  }
};

const WizardFooter = ({
  projectKey,
  step,
  blocker,
  stepDone,
}: {
  readonly projectKey: string | null;
  readonly step: WizardStepId;
  readonly blocker: string | null;
  /**
   * Whether this step is done: *Continue* is the beacon only then, because until then the step's
   * own action is (S-23.23, `step-action-tone.ts`).
   */
  readonly stepDone: boolean;
}): ReactElement => {
  const navigate = useNavigate();
  const previous = previousStep(step);
  const next = nextStep(step);
  const go = (target: WizardStepId) => {
    if (projectKey !== null) {
      void navigate({ to: '/onboarding', search: { project: projectKey, step: target } });
    }
  };
  return (
    <div
      data-wizard-footer=""
      className="flex flex-wrap items-center gap-3 border-t border-line pt-4"
    >
      {previous === null || projectKey === null ? null : (
        <StepLink projectKey={projectKey} step={previous} className="text-sm text-link">
          <span aria-hidden="true">← </span>Back to {WIZARD_STEPS[previous].label}
        </StepLink>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {blocker === null ? null : (
          <p id="wizard-continue-reason" className="text-sm text-fg-muted">
            {blocker}
          </p>
        )}
        {WIZARD_STEPS[step].optional && next !== null ? (
          // Records nothing: the step is not done, it just does not hold anybody back.
          <Button onClick={() => go(next)} disabled={projectKey === null}>
            Skip for now
          </Button>
        ) : null}
        {next === null ? (
          projectKey === null ? null : (
            <Link
              to="/projects/$key"
              params={{ key: projectKey }}
              className={buttonClassName('primary')}
            >
              Open the board
            </Link>
          )
        ) : (
          <Button
            tone={stepDone ? 'primary' : 'default'}
            disabled={blocker !== null || projectKey === null}
            {...(blocker === null ? {} : { 'aria-describedby': 'wizard-continue-reason' })}
            onClick={() => go(next)}
          >
            Continue to {WIZARD_STEPS[next].label}
          </Button>
        )}
      </div>
    </div>
  );
};

const stepStates = (
  current: WizardStepId,
  done: WizardDoneness,
  projectKey: string | null,
  discoveryRunning: boolean,
): Step[] =>
  WIZARD_STEP_IDS.map((id) => {
    const open = projectKey !== null && blockingStepOf(id, done) === null;
    const hint =
      id === 'discovery' && discoveryRunning && done.discovery !== true ? 'Running now' : undefined;
    return {
      id,
      label: WIZARD_STEPS[id].label,
      state: id === current ? 'current' : done[id] === true ? 'done' : 'upcoming',
      optional: WIZARD_STEPS[id].optional,
      ...(hint === undefined ? {} : { hint }),
      // A step past a required one that is not done is plain text: no jumping ahead.
      ...(open && id !== current && projectKey !== null
        ? {
            render: ({ className, children }) => (
              <StepLink projectKey={projectKey} step={id} className={className}>
                {children}
              </StepLink>
            ),
          }
        : {}),
    } satisfies Step;
  });

const Wizard = ({
  project,
  requested,
  existing,
}: {
  readonly project: ProjectSummary | null;
  readonly requested: WizardStepId | null;
  /** The deployment's projects, offered to resume when this is a new one. */
  readonly existing: readonly ProjectSummary[];
}): ReactElement => {
  const navigate = useNavigate();
  const reads = useWizardReads(project?.id ?? null);
  const done = donenessOf(reads.facts);
  const projectKey = project?.key ?? null;

  // Which step is shown: always Connect for a new project; the requested one; or the resume point.
  const current: WizardStepId | null =
    project === null ? 'connect' : (requested ?? resumeStepOf(done));
  const blocking = current === null ? undefined : blockingStepOf(current, done);

  const header = (
    <PageHeader
      title="New project"
      meta={
        project === null ? undefined : (
          <span>
            Setting up <UntrustedText value={project.name} />
          </span>
        )
      }
      actions={
        <Link to="/" className={buttonClassName('default')}>
          Save and exit
        </Link>
      }
    />
  );

  if (current === null || blocking === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Skeleton label="Checking what is already set up…" lines={5} />
      </div>
    );
  }

  const index = WIZARD_STEP_IDS.indexOf(current);
  const body: ReactNode =
    project !== null && blocking !== null ? (
      // A deep link past a required step that is not done: no jumping ahead (NN/g).
      <Blankslate
        title={`${WIZARD_STEPS[current].label} is not open yet`}
        hint={`${WIZARD_STEPS[blocking].label} comes first: the steps go in order, and only the optional ones can be skipped.`}
        action={
          <StepLink projectKey={project.key} step={blocking} className={buttonClassName('default')}>
            Go to {WIZARD_STEPS[blocking].label}
          </StepLink>
        }
      />
    ) : current === 'connect' || project === null ? (
      <ConnectStep
        project={project}
        onCreated={(key) => {
          void navigate({ to: '/onboarding', search: { project: key, step: 'connect' } });
        }}
      />
    ) : current === 'discovery' ? (
      <DiscoveryStep project={project} reads={reads} />
    ) : current === 'business' ? (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">
          Every section can be left empty, and the whole step can be skipped and answered later from
          the project&rsquo;s{' '}
          <Link
            to="/projects/$key/settings"
            params={{ key: project.key }}
            className="text-link underline"
          >
            settings
          </Link>
          , under <em>Business context</em>.
        </p>
        <BusinessInterview projectId={project.id} projectKey={project.key} />
      </div>
    ) : current === 'history' ? (
      <HistoryBootstrap projectId={project.id} projectKey={project.key} />
    ) : current === 'autonomy' ? (
      <div className="flex flex-col gap-3">
        <OperatingMode projectId={project.id} />
        <DetailsDisclosure summary="Learn more: the commands agents may run">
          <p className="text-xs text-fg-muted">
            The command policy is <strong>not</strong> editable here. Each role&rsquo;s runs start
            from a shipped baseline that already carries the project&rsquo;s own test, lint and
            build commands (<code>npm test</code>, <code>npm run &hellip;</code>,{' '}
            <code>make &hellip;</code> and the like) for the roles that run them, and a project may
            only <em>narrow</em> that baseline through the repository&rsquo;s settings file. An
            entry no role is granted is ignored and listed on the project&rsquo;s configuration
            rather than dropped in silence.
          </p>
          <ForAdministrators note="command_allow" />
        </DetailsDisclosure>
      </div>
    ) : (
      <FinishStep project={project} reads={reads} />
    );

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Setup" className="flex flex-col gap-4">
          <Stepper
            label="Setup steps"
            steps={stepStates(current, done, projectKey, reads.discoveryRunning)}
          />
          {project === null && existing.length > 0 ? (
            <DetailsDisclosure summary="Continue an existing project">
              <ul className="flex flex-col gap-1">
                {existing.map((item) => (
                  <li key={item.id}>
                    <Link
                      to="/onboarding"
                      search={{ project: item.key }}
                      className="text-sm text-link underline"
                    >
                      <UntrustedText value={item.name} />
                    </Link>
                  </li>
                ))}
              </ul>
            </DetailsDisclosure>
          ) : null}
        </nav>
        <section
          aria-labelledby="wizard-step-title"
          data-wizard-step={current}
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <p className="text-xs text-fg-muted">
              Step {index + 1} of {WIZARD_STEP_IDS.length}
              {WIZARD_STEPS[current].optional ? ' · Optional' : ''}
            </p>
            <h2
              id="wizard-step-title"
              className="text-2xl font-black tracking-[-0.02em] text-balance text-fg"
            >
              {WIZARD_STEPS[current].label}
            </h2>
            <p className="text-sm text-fg-muted" data-step-purpose="">
              {purposeOf(current, project === null ? null : reads)}
            </p>
          </div>
          {/* One primary per step (S-23.23): the step's own action until it is done, then Continue. */}
          <StepActionToneContext.Provider value={done[current] === true ? 'default' : 'primary'}>
            {body}
          </StepActionToneContext.Provider>
          {blocking !== null ? null : (
            <WizardFooter
              projectKey={projectKey}
              step={current}
              blocker={continueBlockerOf(current, reads.facts)}
              stepDone={done[current] === true}
            />
          )}
        </section>
      </div>
    </div>
  );
};

export const OnboardingScreen = ({
  projectKey,
  step,
}: {
  /** `?project=` — the key of the project being set up; absent, a new project. */
  readonly projectKey: string | null;
  /** `?step=` — absent, the wizard resumes at the first step not done. */
  readonly step: WizardStepId | null;
}): ReactElement => {
  const projects = useProjects();
  const items = projects.data?.items ?? [];

  if (projectKey === null) {
    return <Wizard project={null} requested={null} existing={items} />;
  }
  if (projects.isPending) {
    return <Skeleton label="Loading the project…" lines={5} />;
  }
  if (projects.isError) {
    return <ErrorNotice title="Projects could not be loaded." error={projects.error} />;
  }
  const project = items.find((item) => item.key === projectKey) ?? null;
  if (project === null) {
    return (
      <Blankslate
        title="No such project"
        hint="The address names a project this deployment does not have. Start a new one instead."
        action={
          <Link to="/onboarding" className={buttonClassName('default')}>
            New project
          </Link>
        }
      />
    );
  }
  // Keyed by the project, so nothing a step held for one project survives into another's.
  return <Wizard key={project.id} project={project} requested={step} existing={items} />;
};
