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
 * **Once a ticket has run, the checklist is gone unless a piece is missing** (product/10's
 * 2026-11-06 amendment, research/21 F10). A working install lingered on "4 of 5 done" for good, with
 * step 1 current while every later step was ticked. So `homeSetup` asks one question first — did
 * the setup project run a ticket? — and if it did, the steps no longer matter: what Home shows is
 * only the **pieces** a working install still lacks (`missingPieces`: the tracker, the git host, and
 * on a platform that needs one a worker that takes work), each with what its absence costs and
 * where to fix it. Discovery and the autonomy dial are choices with working defaults, not pieces,
 * so they are not named again once a ticket has run (the project's settings still hold them).
 *
 * **The setup project is the oldest one.** The checklist follows one project, the one the instance
 * was set up with, so the reads stay at three however many projects there are; a later project's
 * own steps are the wizard's to show (`/onboarding?project=<key>`), not Home's.
 */
import type { WorkerClaimBlocker } from '@platform/contracts';
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
  /** The first blocker's id, which Home's count of several machines groups by (S-25.15). */
  readonly blocker?: WorkerClaimBlocker;
  readonly createdAt: string;
}

/** Where a step is done: a screen of this app, resolved to a `<Link>` by the screen. */
export type SetupDestination =
  | { readonly to: '/integrations' }
  | { readonly to: '/onboarding'; readonly project?: string }
  | { readonly to: '/workers/new'; readonly step?: 'ready'; readonly since?: string }
  | { readonly to: '/workers' }
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

// ── Once a ticket has run: what is missing ───────────────────────────────────

/** A piece a working install still needs: without it something the reader expects cannot happen. */
export type MissingPieceId = 'tracker' | 'git' | 'worker';

/** The facts the pieces are read from — each `done`, `todo`, `pending` or `unknown`. */
export interface SetupPieces {
  /** A live `task_management` integration exists. */
  readonly tracker: SetupFact;
  /** A live `git` integration exists. */
  readonly git: SetupFact;
  /** As `SetupFacts.worker`: absent where the platform needs no worker. */
  readonly worker?: SetupFact;
}

export interface MissingPiece {
  readonly id: MissingPieceId;
  /** What is missing and what that costs, in one sentence. */
  readonly text: string;
  /** The link's words. */
  readonly action: string;
  readonly destination: SetupDestination;
}

/**
 * Why a machine can't take work, as a count says it (S-25.15): "2 not connected, 1 needs an
 * update" — the singular, and the plural where the verb changes. Short on purpose: the sentence
 * names the reasons and the Workers screen says each machine's fix.
 *
 * **The second wording of `WORKER_CLAIM_BLOCKER_WORDS`** (`ui/words/worker-blockers.ts`), keyed by
 * the same blockers — the type makes a blocker added there fail to compile here until it has its
 * count form, and a reworded blocker there is reworded here too. It is not derived from that
 * table's `word`: those are row headlines ("Not connected to the platform", "It has no run
 * images") with no plural, and a `count` field on that table would put these words in the
 * worker's local page, which loads it within its own 120 kB budget (BACKLOG 1455).
 */
const COUNT_WORDS: Readonly<
  Record<WorkerClaimBlocker | 'updating', string | readonly [string, string]>
> = {
  not_set_up: 'not set up yet',
  revoked: 'removed',
  owner_disabled: ['with its owner’s account disabled', 'with their owners’ accounts disabled'],
  offline: 'not connected',
  protocol_outdated: ['needs an update', 'need an update'],
  platform_images_unresolved: 'waiting for the platform’s run images',
  claude_rejected: 'signed out of Claude',
  paused: 'paused',
  draining: 'draining',
  usage_limited: 'at the Claude usage limit',
  launcher_unreachable: ['with its launcher not answering', 'with their launchers not answering'],
  images_missing: 'without run images',
  images_outdated: ['needs an update', 'need an update'],
  no_eligible_project: 'given no project',
  pick_only: ['taking only runs its owner picks', 'taking only runs their owners pick'],
  updating: 'updating now',
};

/** "2 not connected" — the count and its reason, agreeing in number. */
const countPhrase = (count: number, worker: BlockedWorker): string => {
  const key = worker.updating === true ? 'updating' : worker.blocker;
  const words = key === undefined ? wordInSentence(worker.reason) : COUNT_WORDS[key];
  return `${count} ${typeof words === 'string' ? words : count === 1 ? words[0] : words[1]}`;
};

/**
 * Several machines that can't take work, in one sentence (S-25.15, the walk of 2026-11-07): how
 * many, and why, grouped — the largest group first, ties in the order the machines were listed.
 * "2 needs an update" and "1 needs an update" are one group even when one is the protocol and one
 * the images: the words are the same, so the reader sees one reason.
 */
const severalBlocked = (workers: readonly BlockedWorker[]): string => {
  const groups = new Map<string, { readonly first: BlockedWorker; count: number }>();
  for (const worker of workers) {
    const key = countPhrase(1, worker);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: worker, count: 1 });
    } else {
      group.count += 1;
    }
  }
  const reasons = [...groups.values()]
    .sort((left, right) => right.count - left.count)
    .map((group) => countPhrase(group.count, group.first));
  return `No machine can take this project’s tickets right now: ${workers.length} can’t take work (${reasons.join(', ')}).`;
};

/**
 * The pieces that are **answered missing** (`todo`), in the order they matter. A read that failed
 * or has not answered names nothing: an unknown is not a missing piece (rule 16), and a box that
 * claims one on a read error would send an administrator to fix what works.
 *
 * `blockedWorkers` is every machine that exists and can't take work, the newest first: one is
 * named, with its fix and its setup; several are counted by reason, with the Workers screen
 * (S-25.15: naming only the newest of three told an owner the wrong story).
 */
export const missingPieces = (
  pieces: SetupPieces,
  blockedWorkers: readonly BlockedWorker[] = [],
): MissingPiece[] => {
  const [blockedWorker = null] = blockedWorkers;
  const missing: MissingPiece[] = [];
  if (pieces.tracker === 'todo') {
    missing.push({
      id: 'tracker',
      text: 'New tickets can’t reach the agents until a tracker is connected.',
      action: 'Connect a tracker',
      destination: { to: '/integrations' },
    });
  }
  if (pieces.git === 'todo') {
    missing.push({
      id: 'git',
      text: 'Merge requests can’t be opened until a git host is connected.',
      action: 'Connect a git host',
      destination: { to: '/integrations' },
    });
  }
  if (pieces.worker === 'todo' && blockedWorkers.length > 1) {
    missing.push({
      id: 'worker',
      text: severalBlocked(blockedWorkers),
      action: 'Open Workers',
      destination: { to: '/workers' },
    });
  } else if (pieces.worker === 'todo') {
    missing.push(
      blockedWorker === null
        ? {
            id: 'worker',
            text: 'No agent can run this project’s tickets until a worker is connected: nothing on the platform server runs them.',
            action: 'Connect a worker',
            destination: { to: '/workers/new' },
          }
        : {
            id: 'worker',
            text:
              blockedWorker.updating === true
                ? `${blockedWorker.name} is updating now. ${blockedWorker.fix}`
                : `No agent can run this project’s tickets yet: ${blockedWorker.name} can’t take work (${wordInSentence(blockedWorker.reason)}). ${blockedWorker.fix}`,
            action: 'Open the worker’s setup',
            destination: { to: '/workers/new', step: 'ready', since: blockedWorker.createdAt },
          },
    );
  }
  return missing;
};

/** What Home's setup box is: the checklist, the missing pieces, or nothing. */
export type HomeSetup =
  | { readonly kind: 'checklist'; readonly checklist: SetupChecklist }
  | { readonly kind: 'missing'; readonly pieces: readonly MissingPiece[] }
  | { readonly kind: 'none' };

/**
 * The checklist until the setup project has run a ticket (and nothing while a fact is still being
 * read, rather than a box that flickers); after that, only the pieces still missing — or nothing.
 */
export const homeSetup = (
  checklist: SetupChecklist,
  missing: readonly MissingPiece[],
): HomeSetup => {
  const ticket = checklist.steps.find((step) => step.id === 'ticket');
  if (ticket?.fact === 'done') {
    return missing.length === 0 ? { kind: 'none' } : { kind: 'missing', pieces: missing };
  }
  return checklist.settling || checklist.complete
    ? { kind: 'none' }
    : { kind: 'checklist', checklist };
};
