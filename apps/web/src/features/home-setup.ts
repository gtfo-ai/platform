/**
 * The first-run setup checklist's done-ness (research/19 § 5.2 "Home", TD-033 § 9).
 *
 * Five steps — connect, create a project, run discovery, choose the autonomy, start a ticket — and
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
 * - **ticket** — the setup project's task list holds a task whose ticket is a provider's, not one
 *   of the platform's own one-off tasks (discovery, review-only, the lint: `provider: 'platform'`).
 *
 * **The setup project is the oldest one.** The checklist follows one project, the one the instance
 * was set up with, so the reads stay at three however many projects there are; a later project's
 * own steps are the wizard's to show (`/onboarding?project=<key>`), not Home's.
 */

/** One fact: answered yes, answered no, not answered yet, or the read failed. */
export type SetupFact = 'done' | 'todo' | 'pending' | 'unknown';

export const SETUP_STEP_IDS = ['connect', 'project', 'discovery', 'autonomy', 'ticket'] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export type SetupFacts = Readonly<Record<SetupStepId, SetupFact>>;

/** Where a step is done: a screen of this app, resolved to a `<Link>` by the screen. */
export type SetupDestination =
  | { readonly to: '/integrations' }
  | { readonly to: '/onboarding'; readonly project?: string }
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
): SetupChecklist => {
  const destination = (id: SetupStepId): SetupDestination => {
    switch (id) {
      case 'connect':
        return { to: '/integrations' };
      case 'project':
        return { to: '/onboarding' };
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
  const steps = SETUP_STEP_IDS.map((id): SetupStep => {
    const needsProject = id === 'discovery' || id === 'autonomy' || id === 'ticket';
    const fact = needsProject && setupProjectKey === null ? 'todo' : facts[id];
    return { id, ...LABELS[id], fact, destination: destination(id) };
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
