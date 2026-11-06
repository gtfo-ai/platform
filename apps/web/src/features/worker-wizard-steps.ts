/**
 * The *Add a worker* wizard's steps, what each one being *done* means, and the commands it shows
 * (S-23.20; TD-033 decision 9's wizard shape, research/19 § 6, the worker UX review § 3).
 *
 * Pure and dependency-free apart from the contracts, so the route tree can validate `?step=` against
 * {@link WORKER_WIZARD_STEP_IDS} without pulling the wizard's chunk into the initial bundle, and so
 * the rules are unit-tested as rules (`worker-wizard-steps.test.ts`).
 *
 * ## Done-ness is the server's — with one stated exception
 *
 * | step | done when | may be passed when |
 * |---|---|---|
 * | install | the person says so (*I've done this*, kept in the URL as `?installed=true`), or a worker of theirs from this wizard exists | done |
 * | start | a worker of theirs from this wizard exists | always — a person may already hold the code |
 * | approve | a worker of theirs from this wizard exists (`GET /api/workers`) | done |
 * | ready | that worker takes work — by itself, or when its owner picks a run (`worker-readiness.ts`, over the server's `claim_blockers`) | done |
 * | projects *(optional)* | some project of theirs lets workers run it | — (the last step) |
 *
 * **Install is the one step whose done-ness is the person's word**: running the installer is
 * invisible to the platform. The core cannot tell that a pending device code is this person's either (the
 * request is anonymous by design, TD-031 §10c), so *start* is done only when *approve* is.
 *
 * **A worker "from this wizard"** is the newest active worker of the signed-in person created at or
 * after `?since=` — the instant the wizard was opened, kept in the URL so *Save and exit* and Home
 * resume it. The wizard writes `since` a little before its own clock ({@link SINCE_SKEW_MS}), because
 * `created_at` is the server's clock and the browser's may run ahead of it.
 *
 * ## The commands
 *
 * Install is **one command** — the core's installer ({@link WORKER_INSTALL_PATHS}, S-22.20): the
 * shell one for macOS and Linux, the PowerShell one for Windows (S-22.21, BACKLOG 984), both shown,
 * the browser's own platform's first ({@link preferredInstallOs}). Each checks Docker, puts the
 * bundle in {@link WORKER_INSTALL_DIR}, starts it and opens the worker's own page — with the
 * compose file and `.env.worker` lines behind *Set it up by hand* while {@link INSTALLER_AVAILABLE}
 * says the core serves them.
 * Start is then the worker's own page, which signs in to Claude; the hand-made sign-in
 * (`claude setup-token`) stays as that step's fallback.
 */
import {
  type ProjectExecutionResponse,
  REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  type WorkerSummary,
} from '@platform/contracts';

export const WORKER_WIZARD_STEP_IDS = ['install', 'start', 'approve', 'ready', 'projects'] as const;

export type WorkerWizardStepId = (typeof WORKER_WIZARD_STEP_IDS)[number];

export const WORKER_WIZARD_STEPS: Readonly<
  Record<WorkerWizardStepId, { readonly label: string; readonly optional: boolean }>
> = {
  install: { label: 'Install', optional: false },
  start: { label: 'Start it and sign in', optional: false },
  approve: { label: 'Approve', optional: false },
  ready: { label: 'Ready to work', optional: false },
  projects: { label: 'Choose projects', optional: true },
};

/** How far before its own clock the wizard records `since` (server and browser clocks differ). */
export const SINCE_SKEW_MS = 2 * 60_000;

/** What the wizard knows; `null` is "not read yet". */
export interface WorkerWizardFacts {
  /** The person ticked *I've done this* on the install step. */
  readonly installed: boolean;
  /** The worker from this wizard; `null` while the workers read is in flight, `false` for none. */
  readonly worker: WorkerSummary | false | null;
  /** That worker takes work now (`isReadyToWork`); `null` while unknown. */
  readonly canClaim: boolean | null;
  /** Some project of the person's lets workers run it; `null` while unknown. */
  readonly projectTakesWorkers: boolean | null;
}

export type WorkerWizardDoneness = Readonly<Record<WorkerWizardStepId, boolean | null>>;

export const workerWizardDonenessOf = (facts: WorkerWizardFacts): WorkerWizardDoneness => {
  const exists = facts.worker === null ? null : facts.worker !== false;
  return {
    install: facts.installed || exists === true ? true : exists === null ? null : false,
    start: exists,
    approve: exists,
    ready: exists === false ? false : exists === null ? null : facts.canClaim,
    projects: facts.projectTakesWorkers,
  };
};

/** Whether a person may move past `step` (see the table in the module note). */
const passable = (step: WorkerWizardStepId, done: WorkerWizardDoneness): boolean | null =>
  step === 'start' ? true : done[step];

const indexOf = (step: WorkerWizardStepId): number => WORKER_WIZARD_STEP_IDS.indexOf(step);

export const previousWorkerStep = (step: WorkerWizardStepId): WorkerWizardStepId | null =>
  WORKER_WIZARD_STEP_IDS[indexOf(step) - 1] ?? null;
export const nextWorkerStep = (step: WorkerWizardStepId): WorkerWizardStepId | null =>
  WORKER_WIZARD_STEP_IDS[indexOf(step) + 1] ?? null;

/**
 * The first required step before `step` that may not be passed yet — what keeps `step` closed — or
 * `null` when nothing does; `undefined` while one of them has not been read.
 */
export const blockingWorkerStepOf = (
  step: WorkerWizardStepId,
  done: WorkerWizardDoneness,
): WorkerWizardStepId | null | undefined => {
  for (const earlier of WORKER_WIZARD_STEP_IDS.slice(0, indexOf(step))) {
    if (WORKER_WIZARD_STEPS[earlier].optional) {
      continue;
    }
    const may = passable(earlier, done);
    if (may === null) {
      return undefined;
    }
    if (!may) {
      return earlier;
    }
  }
  return null;
};

/** Where the wizard opens with no `?step=`: the first step not done; `null` while unknown. */
export const resumeWorkerStepOf = (done: WorkerWizardDoneness): WorkerWizardStepId | null => {
  const required = WORKER_WIZARD_STEP_IDS.filter((step) => !WORKER_WIZARD_STEPS[step].optional);
  for (const step of required) {
    if (done[step] === null) {
      return null;
    }
    if (done[step] === false) {
      return step;
    }
  }
  return 'projects';
};

/** Why *Continue* is off on `step`, in the step's words — or `null` when it may be pressed. */
export const workerContinueBlockerOf = (
  step: WorkerWizardStepId,
  done: WorkerWizardDoneness,
): string | null => {
  const may = WORKER_WIZARD_STEPS[step].optional ? true : passable(step, done);
  if (may === true) {
    return null;
  }
  if (may === null) {
    return 'Checking your workers…';
  }
  switch (step) {
    case 'install':
      return 'Tick “I’ve done this” once the file is downloaded.';
    case 'approve':
      return 'Continue opens once the code is approved and the worker connects.';
    case 'ready':
      return 'Continue opens once the worker can take work.';
    default:
      return null;
  }
};

/** The newest active worker of `userId` created at or after `sinceMs`, or `false` for none. */
export const wizardWorkerOf = (
  items: readonly WorkerSummary[],
  userId: string,
  sinceMs: number,
): WorkerSummary | false =>
  items
    .filter(
      (worker) =>
        worker.user.id === userId &&
        worker.state === 'active' &&
        Date.parse(worker.created_at) >= sinceMs,
    )
    .reduce<WorkerSummary | false>(
      (newest, worker) =>
        newest === false || Date.parse(worker.created_at) > Date.parse(newest.created_at)
          ? worker
          : newest,
      false,
    );

/** The project's git integration keeps its run credential off developers' machines (WP-283). */
export const credentialKeepsWorkersOff = (execution: ProjectExecutionResponse): boolean =>
  execution.notice?.includes(REMOTE_RUN_CREDENTIAL_REFUSED_NOTICE) === true;

/** Workers may run the project's stages: its mode admits them and its credential lets them. */
export const projectTakesWorkers = (execution: ProjectExecutionResponse): boolean =>
  execution.mode !== 'server_only' && !credentialKeepsWorkersOff(execution);

/**
 * Whether the core serves the installer at {@link WORKER_INSTALL_PATHS} (S-22.20). `true` since
 * S-23.24 — `GET /api/worker/v1/install.sh` answers 200 on a released core — so the one-line
 * installer is Install's default and the by-hand setup is behind *Set it up by hand*. Kept as a
 * flag so a core that stops serving it is one edit away from the by-hand step again.
 */
export const INSTALLER_AVAILABLE: boolean = true;

/**
 * The one-command installer's paths on the core (S-22.20), one constant so a changed path is one
 * edit: the shell installer (macOS and Linux) and the PowerShell one (Windows, S-22.21). Both are
 * shown.
 */
export const WORKER_INSTALL_PATHS = {
  unix: `${WORKER_API_PREFIX}/install.sh`,
  windows: `${WORKER_API_PREFIX}/install.ps1`,
} as const;

/** Which installer: the shell one (macOS and Linux) or the PowerShell one (Windows). */
export type InstallOs = keyof typeof WORKER_INSTALL_PATHS;

/**
 * The installer to show first, from what the browser says it runs on — a guess about the computer
 * the person is reading on, which is usually the one they install on; the other one is right below
 * it. Anything that does not name Windows, an empty string included, is macOS/Linux.
 */
export const preferredInstallOs = (platform: string): InstallOs =>
  // `Windows`/`Win32`/`Win64` — never a bare `win`, which `Darwin` contains.
  /\bWin(?:dows|32|64)\b/.test(platform) ? 'windows' : 'unix';

/**
 * What the browser says it runs on: `navigator.userAgentData.platform` (`Windows`, `macOS`,
 * `Linux`; Chromium only) and else the older `navigator.platform` (`Win32`, `MacIntel`, …), read
 * defensively — either may be missing, and neither is typed the same in every browser — and `''`
 * when neither is a string.
 */
export const browserPlatformOf = (navigator: unknown): string => {
  if (typeof navigator !== 'object' || navigator === null) {
    return '';
  }
  const { userAgentData, platform } = navigator as {
    readonly userAgentData?: unknown;
    readonly platform?: unknown;
  };
  const hinted =
    typeof userAgentData === 'object' && userAgentData !== null
      ? (userAgentData as { readonly platform?: unknown }).platform
      : undefined;
  if (typeof hinted === 'string' && hinted !== '') {
    return hinted;
  }
  return typeof platform === 'string' ? platform : '';
};

/** What each installer is called on screen; also its field's label. */
export const INSTALL_OS_LABEL: Readonly<Record<InstallOs, string>> = {
  unix: 'macOS or Linux (Terminal)',
  windows: 'Windows (PowerShell)',
};

/** An installer's URL and the one line that runs it. */
export interface InstallerLine {
  readonly url: string;
  readonly run: string;
}

/** The commands the wizard shows, built from this platform's own origin. */
export interface WorkerInstallCommands {
  readonly origin: string;
  /** Each installer's URL and the line that runs it. */
  readonly installer: {
    readonly unix: InstallerLine;
    /**
     * The line `install.ps1`'s own header documents (`powershell -ExecutionPolicy ByPass -c "irm
     * … | iex"`); `download` and `runFile` are the same header's way to read the script before
     * running it.
     */
    readonly windows: InstallerLine & { readonly download: string; readonly runFile: string };
  };
  readonly download: string;
  readonly coreUrlLine: string;
  readonly signIn: string;
  readonly writeToken: string;
  readonly up: string;
  readonly ps: string;
}

/** The compose arguments every command after the download uses. */
const COMPOSE = 'docker compose --env-file .env.worker -f compose.worker.yml';

/**
 * The commands for `origin` — the page's own origin, the platform this browser talks to. Normalised
 * through `URL` so a trailing slash or a path never reaches a command; the values are shown as text
 * fields (`ui/copy-field.tsx`), never as markup.
 */
export const workerInstallCommands = (pageOrigin: string): WorkerInstallCommands => {
  const origin = new URL(pageOrigin).origin;
  return {
    origin,
    installer: {
      unix: {
        url: `${origin}${WORKER_INSTALL_PATHS.unix}`,
        run: `curl -fsSL '${origin}${WORKER_INSTALL_PATHS.unix}' | sh`,
      },
      windows: {
        url: `${origin}${WORKER_INSTALL_PATHS.windows}`,
        run: `powershell -ExecutionPolicy ByPass -c "irm '${origin}${WORKER_INSTALL_PATHS.windows}' | iex"`,
        download: `irm '${origin}${WORKER_INSTALL_PATHS.windows}' -OutFile install.ps1; notepad install.ps1`,
        runFile: 'powershell -ExecutionPolicy ByPass -File install.ps1',
      },
    },
    download: `curl -fsSo compose.worker.yml ${origin}${WORKER_API_PREFIX}/${WORKER_PATHS.composeFile}`,
    coreUrlLine: `APP_CORE_URL=${origin}`,
    signIn: 'claude setup-token',
    // A silent prompt, so the token is never printed or kept in the shell's history.
    writeToken: `read -rs T && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' "$T" >> .env.worker && unset T`,
    up: `${COMPOSE} up -d`,
    ps: `${COMPOSE} ps`,
  };
};

/** The worker's own page on the computer it runs on (`compose.worker.yml`'s default port). */
export const WORKER_LOCAL_PAGE = 'http://127.0.0.1:7357';

/** Where the installer puts the worker's bundle (S-22.20). */
export const WORKER_INSTALL_DIR = '~/agentic-worker';
