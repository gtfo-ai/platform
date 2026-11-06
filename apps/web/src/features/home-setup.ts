/**
 * The first-run setup checklist's done-ness (research/19 § 5.2 "Home", TD-033 § 9).
 *
 * Five steps — connect, create a project, run discovery, choose the autonomy, start a ticket (and,
 * on a platform with no server runner, connect a worker before the ticket) — and
 * **every ✓ is a fact the server answered**, never a flag this tab stored: a person who did a step
 * in another tab, in another browser or through the API sees it ticked on the next read. This
 * module is the pure half (facts in, steps out), so the table of answers is asserted directly in
 * `home-setup.test.ts`; `dashboard.tsx` gathers the facts from the read API.
 *
 * What each fact is read from:
 *
 * - **connect** — the organisation's live integrations (`GET /api/integrations`, retired rows
 *   excluded by the pickers' selector) hold a `task_management` **and** a `git` account;
 * - **project** — `GET /api/projects` is not empty;
 * - **discovery** — the setup project's `readiness_level` is above 0 (only an evaluation writes
 *   it), or `GET /api/projects/:id/readiness` answers 200 rather than its 409 `readiness_not_evaluated`;
 * - **autonomy** — `GET /api/projects/:id/autonomy` says the dial was `materialised` (applied);
 * - **worker** (S-23.20) — **only on a platform that needs one**: the setup project's execution
 *   read says nothing on the server would run it (`worker-need.ts`). Then it is done when an active
 *   worker takes work (`worker-readiness.ts`, over the server's `claim_blockers`), and while one
 *   exists that does not, the step names it with its first blocker's words and fix — or says it is
 *   updating itself (S-23.27), which needs nobody; on a platform whose
 *   server runs agent work the step is **absent**, not optional — an optional step on a checklist
 *   that disappears when complete would hold it open forever;
 * - **ticket** — the setup project's task list holds a task whose ticket is a provider's, not one
 *   of the platform's own one-off tasks (discovery, review-only, the lint: `provider: 'platform'`).
 *
 * **The setup project is the oldest one.** The checklist follows one project, the one the instance
 * was set up with, so the reads stay at three however many projects there are; a later project's
 * own steps are the wizard's to show (`/onboarding?project=<key>`), not Home's.
 */
import { wordInSentence } from '../ui/humanize.js';

/** One fact: answered yes, answered no, not answered yet, or the read failed. */
export type SetupFact = 'done' | 'todo' | 'pending' | 'unknown';

export const SETUP_STEP_IDS = [
  'connect',
  'project',
  'discovery',
  'autonomy',
  'worker',
  'ticket',
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * The facts; `worker` is **absent** on a platform that does not need one, and then so is its step.
 */
export type SetupFacts = Readonly<Record<Exclude<SetupStepId, 'worker'>, SetupFact>> & {
  readonly worker?: SetupFact;
};

/**
 * A worker that exists but cannot take work yet: the step names it and why, and *Continue setup*
 * opens the wizard at *Ready to work* for it.
 */
export interface BlockedWorker {
  /** Its name, already sanitised (`ui/untrusted-text.ts`): the hint is a plain string. */
  readonly name: string;
  /** The first blocker's row word (`WORKER_CLAIM_BLOCKER_WORDS`), as the server named it. */
  readonly reason: string;
  /** What to do about it, in the same table's words. */
  readonly fix: string;
  /** It is updating itself (`leadingClaimBlocker`, S-23.27): said as in progress, not as a fault. */
  readonly updating?: boolean;
  readonly createdAt: string;
}

/** Where a step is done: a screen of this app, resolved to a `<Link>` by the screen. */
export type SetupDestination =
  | { readonly to: '/integrations' }
  | { readonly to: '/onboarding'; readonly project?: string }
  | { readonly to: '/workers/new'; readonly step?: 'ready'; readonly since?: string }
  | { readonly to: '/projects/$key'; readonly key: string; readonly hash: string };

export interface SetupStep {
  readonly id: SetupStepId;
  readonly label: string;
  readonly hint: string;
  readonly fact: SetupFact;
  readonly destination: SetupDestination;
}

export interface SetupChecklist {
  readonly steps: readonly SetupStep[];
  /** Some fact has not been answered yet: draw a skeleton, not a checklist that will change. */
  readonly settling: boolean;
  /** Every step is done: the checklist disappears. */
  readonly complete: boolean;
  /** The first step that is not done — where *Continue setup* goes. `null` when complete. */
  readonly next: SetupStep | null;
}

const LABELS: Readonly<Record<SetupStepId, { readonly label: string; readonly hint: string }>> = {
  connect: {
    label: 'Connect your tracker and git host',
    hint: 'Where tickets come from and where merge requests go.',
  },
  project: {
    label: 'Create a project',
    hint: 'A project ties a ticket board to a repository.',
  },
  discovery: {
    label: 'Run technical discovery',
    hint: 'An agent reads the repository and says how ready it is for agents.',
  },
  autonomy: {
    label: 'Choose how autonomous agents are',
    hint: 'How much an agent may do before a person looks.',
  },
  worker: {
    label: 'Connect a worker',
    hint: 'Nothing on the platform server runs this project’s agents: a developer’s own computer has to.',
  },
  ticket: {
    label: 'Start your first ticket',
    hint: 'Give the pipeline one ticket and watch it work.',
  },
};

/** The board's start form's anchor (`app/project-frame.tsx`'s `START_TICKET_ANCHOR`). */
const START_TICKET_HASH = 'start-ticket';

/**
 * The checklist for these facts and this setup project (`null` before any project exists).
 *
 * A step after *Create a project* cannot be done without one, so with no project those three are
 * `todo` whatever was passed — there is nothing they could have been read from.
 */
export const setupChecklist = (
  facts: SetupFacts,
  setupProjectKey: string | null,
  blockedWorker: BlockedWorker | null = null,
): SetupChecklist => {
  const destination = (id: SetupStepId): SetupDestination => {
    switch (id) {
      case 'connect':
        return { to: '/integrations' };
      case 'project':
        return { to: '/onboarding' };
      case 'worker':
        return blockedWorker === null
          ? { to: '/workers/new' }
          : { to: '/workers/new', step: 'ready', since: blockedWorker.createdAt };
      case 'discovery':
      case 'autonomy':
        return setupProjectKey === null
          ? { to: '/onboarding' }
          : { to: '/onboarding', project: setupProjectKey };
      case 'ticket':
        return setupProjectKey === null
          ? { to: '/onboarding' }
          : { to: '/projects/$key', key: setupProjectKey, hash: START_TICKET_HASH };
    }
  };
  const steps = SETUP_STEP_IDS.flatMap((id): SetupStep[] => {
    const given = id === 'worker' ? facts.worker : facts[id];
    if (given === undefined) {
      return [];
    }
    const needsProject = id === 'discovery' || id === 'autonomy' || id === 'ticket';
    const fact = needsProject && setupProjectKey === null ? 'todo' : given;
    const hint =
      id !== 'worker' || fact === 'done' || blockedWorker === null
        ? LABELS[id].hint
        : blockedWorker.updating === true
          ? `${blockedWorker.name} is updating now. ${blockedWorker.fix}`
          : `${blockedWorker.name} can’t take work yet: ${wordInSentence(blockedWorker.reason)}. ${blockedWorker.fix}`;
    return [{ id, label: LABELS[id].label, hint, fact, destination: destination(id) }];
  });
  const next = steps.find((step) => step.fact !== 'done') ?? null;
  return {
    steps,
    settling: steps.some((step) => step.fact === 'pending'),
    complete: next === null,
    next,
  };
};

/** A ticket a provider knows — not one of the platform's own one-off tasks. */
export const PLATFORM_TICKET_PROVIDER = 'platform';

/** The oldest project — the one the checklist follows (see the module note). */
export const setupProjectOf = <T extends { readonly created_at: string; readonly id: string }>(
  projects: readonly T[],
): T | null =>
  projects.reduce<T | null>(
    (oldest, project) =>
      oldest === null ||
      Date.parse(project.created_at) < Date.parse(oldest.created_at) ||
      (Date.parse(project.created_at) === Date.parse(oldest.created_at) && project.id < oldest.id)
        ? project
        : oldest,
    null,
  );
