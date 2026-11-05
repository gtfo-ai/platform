/**
 * **Add a worker** — the platform's half of setting up a developer's computer as a worker (S-23.20;
 * the worker UX review § 3; TD-033 decision 9's wizard, research/19 § 6, the New project wizard's
 * shape in `onboarding.tsx`).
 *
 * `/workers/new?step=<id>&since=<instant>&installed=true`: a Stepper on the left (done ✓ / current ●
 * / upcoming ○, *Optional* on the last step), the step on the right — its title, one sentence saying
 * what it does, its content and a footer with *Back to …* and *Continue to …*; *Save and exit* top
 * right. The steps, their order and what *done* means are `worker-wizard-steps.ts`.
 *
 * ## Who owns what
 *
 * The worker's own page (`http://127.0.0.1:7357` on that computer) owns the Claude sign-in and shows
 * the device code; this wizard owns the install, the approval, whether the worker can take work and
 * which projects let it. The approval itself is the existing `/workers/approve` page — the warning,
 * the requesting machine's details and the five-minute confirmation stay exactly there (TD-031 §10c)
 * — opened in a new tab, so this page keeps watching for the new worker.
 *
 * ## The one place this app polls
 *
 * The app otherwise refreshes on the stream (`app/queries.ts`), but no event announces a worker
 * being created, connecting or pausing — a worker row is written when the machine collects its
 * credential, and its heartbeat is a column. So while the person waits on *Start*, *Approve* or
 * *Ready* the workers read is asked again every {@link WATCH_INTERVAL_MS}, and nowhere else.
 *
 * ## Every string from the server is data
 *
 * A worker's name is its owner's text and a project's name somebody's (BD-022): both render through
 * `ui/untrusted.tsx`. The commands are built from the page's own origin and shown as text fields.
 */
import type { ProjectExecutionResponse, WorkerSummary } from '@platform/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useEffect } from 'react';
import { queryKeys } from '../api/keys.js';
import { useProjects, useSession } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { CopyField } from '../ui/copy-field.js';
import { DetailsDisclosure } from '../ui/details.js';
import { ErrorNotice } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { formatAgo } from '../ui/relative-time.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { type Step, Stepper } from '../ui/stepper.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import {
  WORKER_BLOCKER_WORDS,
  type WorkerClaimBlocker,
  workerReadinessOf,
} from './worker-readiness.js';
import {
  blockingWorkerStepOf,
  credentialKeepsWorkersOff,
  type InstallOs,
  nextWorkerStep,
  preferredInstallOs,
  previousWorkerStep,
  projectTakesWorkers,
  resumeWorkerStepOf,
  SINCE_SKEW_MS,
  WORKER_INSTALL_DIR,
  WORKER_LOCAL_PAGE,
  WORKER_WIZARD_STEP_IDS,
  WORKER_WIZARD_STEPS,
  type WorkerInstallCommands,
  type WorkerWizardDoneness,
  type WorkerWizardStepId,
  wizardWorkerOf,
  workerContinueBlockerOf,
  workerInstallCommands,
  workerWizardDonenessOf,
} from './worker-wizard-steps.js';

/** How often the waiting steps ask for the workers again (see the module note). */
export const WATCH_INTERVAL_MS = 5_000;

/** The steps on which the person waits for the machine. */
const WATCHED: ReadonlySet<WorkerWizardStepId> = new Set(['start', 'approve', 'ready']);

/** The wizard's place in the URL. */
interface WizardPlace {
  readonly step: WorkerWizardStepId | undefined;
  readonly since: string;
  readonly installed: boolean;
}

const searchOf = (place: WizardPlace, step: WorkerWizardStepId | undefined) => ({
  ...(step === undefined ? {} : { step }),
  since: place.since,
  ...(place.installed ? { installed: true } : {}),
});

const StepLink = ({
  place,
  step,
  className,
  children,
}: {
  readonly place: WizardPlace;
  readonly step: WorkerWizardStepId;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement => (
  <Link to="/workers/new" search={searchOf(place, step)} className={className}>
    {children}
  </Link>
);

/** One troubleshooting item: the symptom as its summary, what to do inside. */
const Trouble = ({
  symptom,
  children,
}: {
  readonly symptom: string;
  readonly children: ReactNode;
}): ReactElement => (
  <DetailsDisclosure summary={symptom}>
    <div className="flex flex-col gap-2 text-sm">{children}</div>
  </DetailsDisclosure>
);

const Troubleshooting = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <section aria-label="Troubleshooting" className="flex flex-col gap-1">
    <h3 className="text-sm font-semibold">If something goes wrong</h3>
    {children}
  </section>
);

/** A checklist line: icon, colour and word together (research/19 rule 3). */
const CheckLine = ({
  ok,
  children,
}: {
  readonly ok: boolean;
  readonly children: ReactNode;
}): ReactElement => (
  <li className="flex items-start gap-2 text-sm" data-check={ok ? 'ok' : 'blocked'}>
    <span className="pt-0.5">
      <StatusIcon status={ok ? 'success' : 'failure'} label={ok ? 'Done' : 'Not yet'} />
    </span>
    <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
  </li>
);

// ── The steps ────────────────────────────────────────────────────────────────

/** What each installer is called on screen. */
const INSTALL_OS_LABEL: Readonly<Record<InstallOs, string>> = {
  unix: 'macOS or Linux (Terminal)',
  windows: 'Windows (PowerShell)',
};

/** One OS's installer: the line to paste and the script itself, to read before running it. */
const Installer = ({
  os,
  commands,
}: {
  readonly os: InstallOs;
  readonly commands: WorkerInstallCommands;
}): ReactElement => (
  <div className="flex flex-col gap-1" data-installer={os}>
    <CopyField label={INSTALL_OS_LABEL[os]} value={commands.installer[os].run} />
    <p className="text-xs">
      <ExternalLink
        url={commands.installer[os].url}
        label="Read the script first"
        className="text-link underline"
      />
    </p>
  </div>
);

const InstallStep = ({
  commands,
  firstOs,
  installed,
  onInstalled,
}: {
  readonly commands: WorkerInstallCommands;
  /** The installer the browser's platform suggests; the other is behind a disclosure. */
  readonly firstOs: InstallOs;
  readonly installed: boolean;
  readonly onInstalled: (value: boolean) => void;
}): ReactElement => {
  const otherOs: InstallOs = firstOs === 'unix' ? 'windows' : 'unix';
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm">
        A worker is your own computer running this platform’s agent work with your own Claude
        subscription. The platform offers it a stage of a ticket, the worker runs it in containers
        on that computer, and the result comes back here — nothing you have to watch.
      </p>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">You need</h3>
        <ul className="list-disc pl-5 text-sm">
          <li>Docker running on that computer (Docker Desktop, or Docker Engine on Linux).</li>
          <li>A Claude subscription: the worker signs in with it, and its runs use it.</li>
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-sm">On the computer that will run agent work, run this one line:</p>
        <Installer os={firstOs} commands={commands} />
        <DetailsDisclosure summary={`On ${INSTALL_OS_LABEL[otherOs]} instead`}>
          <Installer os={otherOs} commands={commands} />
        </DetailsDisclosure>
        <p className="max-w-prose text-xs text-fg-muted">
          The script checks that Docker runs, puts the worker in <code>{WORKER_INSTALL_DIR}</code>,
          starts it for <code>{commands.origin}</code> and opens <code>{WORKER_LOCAL_PAGE}</code>,
          the worker’s own page, which guides the next two steps.
        </p>
      </div>
      <DetailsDisclosure summary="Set it up by hand">
        <div className="flex flex-col gap-3">
          <p className="text-sm">In an empty folder on that computer:</p>
          <CopyField label="Download the worker’s compose file" value={commands.download} />
          <CopyField
            label="Then create a file named .env.worker beside it, with this line"
            value={commands.coreUrlLine}
          />
          <p className="text-xs text-fg-muted">
            That line tells the worker which platform it works for: this one. The next step says how
            to sign in to Claude and start it by hand.
          </p>
        </div>
      </DetailsDisclosure>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={installed}
          onChange={(event) => {
            onInstalled(event.target.checked);
          }}
        />
        I’ve done this
      </label>
    </div>
  );
};

const StartStep = ({ commands }: { readonly commands: WorkerInstallCommands }): ReactElement => (
  <div className="flex flex-col gap-4">
    <p className="max-w-prose text-sm">
      The worker’s page opens at{' '}
      <ExternalLink url={WORKER_LOCAL_PAGE} label={WORKER_LOCAL_PAGE} className="text-link" /> and
      walks you through signing in to Claude, then shows the code you approve in the next step. If
      it didn’t open, open it yourself on that computer.
    </p>
    <DetailsDisclosure summary="If you set it up by hand">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">1. Sign in to Claude</h3>
          <CopyField label="Run this in the worker’s folder" value={commands.signIn} />
          <p className="max-w-prose text-sm" data-setup-token="">
            Your browser opens. Once you authorize, it says{' '}
            <em>Build something great — you can close this window</em>. The token appears in the{' '}
            <strong>terminal</strong> where you ran the command, not in the browser — it may wrap
            over two lines; join them. Copy it into <code>.env.worker</code> as{' '}
            <code>CLAUDE_CODE_OAUTH_TOKEN</code>.{' '}
            <strong>Don’t authorize again: every run creates a new token.</strong>
          </p>
          <CopyField
            label="Or paste it into .env.worker without it being printed"
            value={commands.writeToken}
          />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">2. Start the worker</h3>
          <CopyField label="Start the worker" value={commands.up} />
          <p className="text-sm">
            Then open <code>{WORKER_LOCAL_PAGE}</code> on that computer.
          </p>
        </div>
      </div>
    </DetailsDisclosure>
    <Troubleshooting>
      <Trouble symptom="Safari can’t connect to localhost:…/callback">
        <p>
          The <code>claude setup-token</code> command was stopped before you authorized, so nothing
          was listening when the browser came back. Run it again in a terminal that stays open, and
          leave it open until it prints the token.
        </p>
      </Trouble>
      <Trouble symptom="Downloading the script or compose.yml answers 503 or 426">
        <p>
          The platform needs an update before it can hand out a worker: a 503 means it can’t name
          its own images right now, a 426 that it speaks an older worker version. Ask an
          administrator of this platform.
        </p>
      </Trouble>
      <Trouble symptom="The page at 127.0.0.1:7357 doesn’t open">
        <p>
          Check what is running: in the worker’s folder (<code>{WORKER_INSTALL_DIR}</code> when the
          script set it up) run <code>docker compose ps</code>. Set up by hand, it is:
        </p>
        <CopyField label="Show the worker’s containers" value={commands.ps} />
        <p>
          The worker must be listed as running. If it is missing, start it again and read what it
          prints: set up by hand without <code>CLAUDE_CODE_OAUTH_TOKEN</code> in{' '}
          <code>.env.worker</code>, it refuses to start.
        </p>
      </Trouble>
    </Troubleshooting>
  </div>
);

const ApproveStep = ({
  worker,
  nowMs,
}: {
  readonly worker: WorkerSummary | false | null;
  readonly nowMs: number;
}): ReactElement => (
  <div className="flex flex-col gap-4">
    <p className="max-w-prose text-sm">
      The worker’s page shows a code like <code>ABCD-EFGH</code>. Approve it on this platform — and
      approve only a code your own computer is showing you right now.
    </p>
    <div>
      <Link to="/workers/approve" target="_blank" className={buttonClassName('default')}>
        Approve the code
      </Link>
      <p className="pt-1 text-xs text-fg-muted">Opens in a new tab; this page keeps watching.</p>
    </div>
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
      {worker === null ? (
        <span className="text-fg-muted">Checking your workers…</span>
      ) : worker === false ? (
        <>
          <StatusIcon status="waiting" decorative />
          <span>Waiting for your new worker to appear — this page checks every 5 seconds.</span>
        </>
      ) : worker.last_seen_at === null ? (
        <>
          <StatusIcon status="waiting" decorative />
          <span>
            Approved: waiting for <UntrustedText value={worker.name} /> to connect…
          </span>
        </>
      ) : (
        <>
          <StatusIcon status="success" decorative />
          <span>
            <UntrustedText value={worker.name} /> is approved and connected (
            {formatAgo(worker.last_seen_at, nowMs)}).
          </span>
        </>
      )}
    </div>
    <Troubleshooting>
      <Trouble symptom="No pending code matches">
        <p>
          Check the code the worker’s page shows right now. A code lasts ten minutes; the page shows
          a new one when one expires.
        </p>
      </Trouble>
      <Trouble symptom="The worker’s page still says it waits for approval">
        <p>
          It checks every 5 seconds. If it stays for a minute, its connection to this platform
          dropped; the worker’s page says why.
        </p>
      </Trouble>
    </Troubleshooting>
  </div>
);

/** The blockers the stub can see, in the order a person fixes them. */
const SEEN_BLOCKERS: readonly WorkerClaimBlocker[] = ['offline', 'paused', 'usage_limited'];

const ReadyStep = ({
  worker,
  nowMs,
}: {
  readonly worker: WorkerSummary;
  readonly nowMs: number;
}): ReactElement => {
  const readiness = workerReadinessOf(worker, nowMs);
  return (
    <div className="flex flex-col gap-4">
      <p
        className="text-sm"
        role="status"
        aria-live="polite"
        data-worker-ready={readiness.can_claim}
      >
        {readiness.can_claim ? (
          <>
            <UntrustedText value={worker.name} /> can take work.
          </>
        ) : (
          <>
            <UntrustedText value={worker.name} /> can’t take work yet.
          </>
        )}
      </p>
      <ul aria-label="What the worker needs" className="flex flex-col gap-2">
        {SEEN_BLOCKERS.map((blocker) => {
          const blocked = readiness.claim_blockers.includes(blocker);
          return (
            <CheckLine key={blocker} ok={!blocked}>
              <span data-blocker={blocker}>
                {blocked ? WORKER_BLOCKER_WORDS[blocker].word : OK_WORDS[blocker]}
                {blocker === 'offline' && blocked && worker.last_seen_at !== null
                  ? ` — last seen ${formatAgo(worker.last_seen_at, nowMs)}`
                  : ''}
              </span>
              {blocked ? (
                <span className="text-xs text-fg-muted">{WORKER_BLOCKER_WORDS[blocker].fix}</span>
              ) : null}
            </CheckLine>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">
        This page can’t check the worker’s images, its version or which projects give it work yet;
        the worker’s own page shows them.
      </p>
    </div>
  );
};

/** What each line says when the blocker is absent. */
const OK_WORDS: Readonly<Record<WorkerClaimBlocker, string>> = {
  offline: 'Connected',
  paused: 'Not paused',
  draining: 'Not draining',
  usage_limited: 'Not held by a Claude usage limit',
  images_missing: 'Has its run images',
  images_outdated: 'Has this platform’s current images',
  protocol_outdated: 'Speaks this platform’s version',
  no_eligible_project: 'A project gives it work',
};

interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly execution: ProjectExecutionResponse | null;
  readonly failed: boolean;
}

const ProjectsStep = ({
  rows,
  isAdmin,
}: {
  readonly rows: readonly ProjectRow[];
  readonly isAdmin: boolean;
}): ReactElement => (
  <div className="flex flex-col gap-4">
    {rows.length === 0 ? (
      <p className="text-sm text-fg-muted">You are not a member of any project yet.</p>
    ) : (
      <ul aria-label="Your projects" className="flex flex-col gap-3">
        {rows.map((row) => {
          const takes = row.execution === null ? null : projectTakesWorkers(row.execution);
          return (
            <li key={row.id} data-project={row.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {takes === null ? null : (
                  <StatusIcon
                    status={takes ? 'success' : 'skipped'}
                    label={takes ? 'Workers run it' : 'Workers don’t run it'}
                  />
                )}
                <span className="font-medium">
                  <UntrustedText value={row.name} />
                </span>
                <span className="text-fg-muted">
                  {row.failed
                    ? 'Its setting could not be read.'
                    : row.execution === null
                      ? 'Reading…'
                      : takes
                        ? row.execution.mode === 'workers_only'
                          ? 'Workers run its stages.'
                          : 'Workers run its stages, with the platform server.'
                        : credentialKeepsWorkersOff(row.execution)
                          ? 'Workers don’t run its stages: its git connection keeps its credential off developers’ computers.'
                          : 'Workers don’t run its stages: it runs on the platform server only.'}
                </span>
              </div>
              {takes === false ? (
                isAdmin ? (
                  <Link
                    to="/projects/$key/settings/$section"
                    params={{ key: row.key, section: 'execution' }}
                    className="pl-6 text-sm text-link underline"
                  >
                    Use workers for <UntrustedText value={row.name} />
                  </Link>
                ) : (
                  <p className="pl-6 text-xs text-fg-muted">
                    Ask an administrator to turn on workers for <UntrustedText value={row.name} />.
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    )}
    <p className="text-xs text-fg-muted">
      Which of these this computer takes by itself is chosen on the worker’s own page.
    </p>
  </div>
);

// ── The frame ────────────────────────────────────────────────────────────────

const PURPOSE: Readonly<Record<WorkerWizardStepId, string>> = {
  install:
    'Install the worker on the computer that will run agent work: one command. A few minutes; nothing is charged.',
  start:
    'Sign the worker in to your Claude subscription on its own page. A few minutes, once per computer.',
  approve: 'Let this platform trust the computer: approve the code its page shows.',
  ready: 'Check that the worker can take work now, and fix what stops it.',
  projects: 'See which of your projects let workers run their stages, and where to change that.',
};

const Footer = ({
  place,
  step,
  blocker,
  boardKey,
}: {
  readonly place: WizardPlace;
  readonly step: WorkerWizardStepId;
  readonly blocker: string | null;
  /** The first project that lets workers run it — the ending's board. */
  readonly boardKey: string | null;
}): ReactElement => {
  const navigate = useNavigate();
  const previous = previousWorkerStep(step);
  const next = nextWorkerStep(step);
  return (
    <div
      data-wizard-footer=""
      className="flex flex-wrap items-center gap-3 border-t border-line pt-4"
    >
      {previous === null ? null : (
        <StepLink place={place} step={previous} className="text-sm text-link">
          <span aria-hidden="true">← </span>Back to {WORKER_WIZARD_STEPS[previous].label}
        </StepLink>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {blocker === null ? null : (
          <p id="wizard-continue-reason" className="text-sm text-fg-muted">
            {blocker}
          </p>
        )}
        {next === null ? (
          // The ending (R4): the board of a project the worker can serve, else the Workers screen.
          boardKey === null ? (
            <Link to="/workers" className={buttonClassName('primary')}>
              Go to Workers
            </Link>
          ) : (
            <>
              <Link to="/workers" className={buttonClassName('default')}>
                Skip for now
              </Link>
              <Link
                to="/projects/$key"
                params={{ key: boardKey }}
                className={buttonClassName('primary')}
              >
                Open the board
              </Link>
            </>
          )
        ) : (
          <button
            type="button"
            className={buttonClassName('primary')}
            disabled={blocker !== null}
            {...(blocker === null ? {} : { 'aria-describedby': 'wizard-continue-reason' })}
            onClick={() => {
              void navigate({ to: '/workers/new', search: searchOf(place, next) });
            }}
          >
            Continue to {WORKER_WIZARD_STEPS[next].label}
          </button>
        )}
      </div>
    </div>
  );
};

const stepStates = (
  current: WorkerWizardStepId,
  done: WorkerWizardDoneness,
  place: WizardPlace,
): Step[] =>
  WORKER_WIZARD_STEP_IDS.map((id) => {
    const open = blockingWorkerStepOf(id, done) === null;
    return {
      id,
      label: WORKER_WIZARD_STEPS[id].label,
      state: id === current ? 'current' : done[id] === true ? 'done' : 'upcoming',
      optional: WORKER_WIZARD_STEPS[id].optional,
      // A step past a required one that may not be passed yet is plain text: no jumping ahead.
      ...(open && id !== current
        ? {
            render: ({ className, children }) => (
              <StepLink place={place} step={id} className={className}>
                {children}
              </StepLink>
            ),
          }
        : {}),
    } satisfies Step;
  });

/** The person's projects, each with its execution setting — read only on the last step. */
const useProjectRows = (enabled: boolean): readonly ProjectRow[] | null => {
  const { endpoints } = useServices();
  const projects = useProjects();
  const items = enabled ? (projects.data?.items ?? []) : [];
  const executions = useQueries({
    queries: items.map((project) => ({
      queryKey: queryKeys.projectExecution(project.id),
      queryFn: () => endpoints.projectExecution(project.id),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  if (!enabled || projects.data === undefined) {
    return null;
  }
  return items.map((project, index) => ({
    id: project.id,
    key: project.key,
    name: project.name,
    execution: executions[index]?.data ?? null,
    failed: executions[index]?.isError === true,
  }));
};

const Wizard = ({ place }: { readonly place: WizardPlace }): ReactElement => {
  const navigate = useNavigate();
  const { endpoints, now } = useServices();
  useTopics(['org']);
  const session = useSession();
  const user = session.data?.user ?? null;
  const nowMs = now();

  // Before anything is read the step is the requested one (or unknown); the watch follows it.
  const watched = place.step === undefined || WATCHED.has(place.step);
  const workers = useQuery({
    queryKey: [...queryKeys.workers],
    queryFn: () => endpoints.workers(),
    refetchInterval: watched ? WATCH_INTERVAL_MS : false,
  });

  const sinceMs = Date.parse(place.since);
  const worker: WorkerSummary | false | null =
    user === null || workers.data === undefined
      ? workers.isError
        ? false
        : null
      : wizardWorkerOf(workers.data.items, user.id, sinceMs);

  const onLastStep = place.step === 'projects';
  const rows = useProjectRows(onLastStep);
  const projectTakes =
    rows === null || rows.some((row) => row.execution === null && !row.failed)
      ? null
      : rows.some((row) => row.execution !== null && projectTakesWorkers(row.execution));
  const done = workerWizardDonenessOf({
    installed: place.installed,
    worker,
    canClaim:
      worker === null || worker === false ? null : workerReadinessOf(worker, nowMs).can_claim,
    projectTakesWorkers: projectTakes,
  });

  const current = place.step ?? resumeWorkerStepOf(done);
  const blocking = current === null ? undefined : blockingWorkerStepOf(current, done);
  const commands = workerInstallCommands(window.location.origin);

  const header = (
    <PageHeader
      title="Add a worker"
      meta={<span>Your own computer, running this platform’s agent work.</span>}
      actions={
        <Link to="/workers" className={buttonClassName('default')}>
          Save and exit
        </Link>
      }
    />
  );

  if (current === null || blocking === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {workers.isError ? (
          <ErrorNotice title="Your workers could not be loaded." error={workers.error} />
        ) : null}
        <Skeleton label="Checking your workers…" lines={5} />
      </div>
    );
  }

  const boardKey =
    rows?.find((row) => row.execution !== null && projectTakesWorkers(row.execution))?.key ?? null;
  const index = WORKER_WIZARD_STEP_IDS.indexOf(current);
  const body: ReactNode =
    blocking !== null ? (
      // A deep link past a required step that may not be passed yet (NN/g: no jumping ahead).
      <Blankslate
        title={`${WORKER_WIZARD_STEPS[current].label} is not open yet`}
        hint={`${WORKER_WIZARD_STEPS[blocking].label} comes first: the steps go in order.`}
        action={
          <StepLink place={place} step={blocking} className={buttonClassName('default')}>
            Go to {WORKER_WIZARD_STEPS[blocking].label}
          </StepLink>
        }
      />
    ) : current === 'install' ? (
      <InstallStep
        commands={commands}
        firstOs={preferredInstallOs(globalThis.navigator?.userAgent ?? '')}
        installed={place.installed}
        onInstalled={(installed) => {
          void navigate({
            to: '/workers/new',
            search: searchOf({ ...place, installed }, current),
            replace: true,
          });
        }}
      />
    ) : current === 'start' ? (
      <StartStep commands={commands} />
    ) : current === 'approve' ? (
      <ApproveStep worker={worker} nowMs={nowMs} />
    ) : current === 'ready' ? (
      worker === null || worker === false ? (
        <Skeleton label="Checking your workers…" lines={3} />
      ) : (
        <ReadyStep worker={worker} nowMs={nowMs} />
      )
    ) : rows === null ? (
      <Skeleton label="Reading your projects…" lines={3} />
    ) : (
      <ProjectsStep rows={rows} isAdmin={user?.role === 'admin'} />
    );

  return (
    <div className="flex flex-col gap-4">
      {header}
      {workers.isError ? (
        <ErrorNotice title="Your workers could not be loaded." error={workers.error} />
      ) : null}
      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Setup" className="flex flex-col gap-4">
          <Stepper label="Worker setup steps" steps={stepStates(current, done, place)} />
        </nav>
        <section
          aria-labelledby="wizard-step-title"
          data-wizard-step={current}
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <p className="text-xs text-fg-muted">
              Step {index + 1} of {WORKER_WIZARD_STEP_IDS.length}
              {WORKER_WIZARD_STEPS[current].optional ? ' · Optional' : ''}
            </p>
            <h2
              id="wizard-step-title"
              className="text-2xl font-black tracking-[-0.02em] text-balance text-fg"
            >
              {WORKER_WIZARD_STEPS[current].label}
            </h2>
            <p className="text-sm text-fg-muted" data-step-purpose="">
              {PURPOSE[current]}
            </p>
          </div>
          {body}
          {blocking !== null ? null : (
            <Footer
              place={place}
              step={current}
              blocker={workerContinueBlockerOf(current, done)}
              boardKey={boardKey}
            />
          )}
        </section>
      </div>
    </div>
  );
};

export const WorkerWizardScreen = ({
  step,
  since,
  installed,
}: {
  /** `?step=` — absent, the wizard resumes at the first step not done. */
  readonly step: WorkerWizardStepId | undefined;
  /** `?since=` — when the wizard was opened; absent, it is now, written into the URL. */
  readonly since: string | undefined;
  /** `?installed=true` — the person ticked *I've done this* on the install step. */
  readonly installed: boolean;
}): ReactElement => {
  const navigate = useNavigate();
  const { now } = useServices();
  useEffect(() => {
    if (since === undefined) {
      void navigate({
        to: '/workers/new',
        search: {
          ...(step === undefined ? {} : { step }),
          since: new Date(now() - SINCE_SKEW_MS).toISOString(),
          ...(installed ? { installed: true } : {}),
        },
        replace: true,
      });
    }
  }, [since, step, installed, navigate, now]);
  if (since === undefined) {
    return <Skeleton label="Opening the setup…" lines={5} />;
  }
  return <Wizard place={{ step, since, installed }} />;
};
