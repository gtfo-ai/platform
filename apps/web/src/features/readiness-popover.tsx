/**
 * The readiness badge's popover — the level's definition (product/10, product/17's 2026-11-06
 * amendment, S-25.2) — as a lazy chunk of its own (S-25.6, BACKLOG 1240): `readiness-label.tsx`
 * draws a plain button in its place and imports this module the first time the badge is hovered,
 * focused or pressed, so neither Base UI's Popover nor the readiness read is in the initial graph.
 *
 * The content is the level's meaning, the next rung and what it needs, the cheapest missing
 * criterion with its how-to and what it unlocks (the client's plain words, never the read's
 * `unlocks`), and a link to *Discovery & readiness*.
 *
 * The cheapest missing criterion is the readiness read's `next_improvements[0]` — the next rung's
 * first failing criterion (`nextReadinessImprovements` in the domain) — read **only once the popover
 * is open**, because the project list carries the level and nothing else, and a list of projects
 * must not cost a readiness read per row. A project discovery has not evaluated answers 409
 * `readiness_not_evaluated`; the popover then says nothing is known to be missing yet and points at
 * *Discovery & readiness* rather than inventing a criterion.
 */
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ApiError } from '../api/http.js';
import { useProjectReadiness } from '../app/queries.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { readinessCriterionLabel } from '../ui/humanize.js';
import { Popover } from '../ui/popover.js';
import { levelLook, readinessLadderName } from './readiness-words.js';

/**
 * What each level means now — product/17's "Platform behaviour" column, in plain words — indexed
 * like `READINESS_LEVELS` (`readiness-words.ts`, which keeps only the names and the badge words in
 * the initial graph).
 */
export const READINESS_LEVEL_MEANINGS: readonly string[] = [
  'Chores and spikes run with the defaults. A feature’s or a bug’s plan always waits for your approval, probation is on, and a person confirms the evidence at business review.',
  'Features and bugs run. A plan waits for your approval when the task is big, and probation is on.',
  'The documented defaults: a big plan waits for your approval, and a maintainer may relax probation.',
  'Agents plan on their own: the suggested default asks for your approval only on the largest (XL) plans, and business review may run the app.',
  'Everything level 3 allows. The project is eligible for auto-merging chores once the platform offers it, which this version does not.',
];

/**
 * What each rung adds — the domain's `READINESS_LEVEL_REQUIREMENTS` (product/17 § "Levels",
 * "Requires"), held equal to it by `readiness-label.test.tsx`. Index 0 is level 1's.
 */
export const READINESS_RUNG_REQUIREMENTS: readonly (readonly string[])[] = [
  ['R1', 'R3'],
  ['R2', 'R4', 'R5', 'R9'],
  ['R6', 'R8', 'R10', 'R12'],
  ['R7', 'R11', 'R13', 'R14'],
];

/**
 * A short how-to per criterion, and where it is fixed: product/17's "Criterion" and "How
 * detected" columns turned into the thing to do (the onboarding wizard's *"a short how-to for
 * each (no automated fixes)"*). Platform text; held to the domain's criterion ids by the test.
 */
export const READINESS_HOW_TO: Readonly<Record<string, string>> = {
  R1: 'Make the test suite pass on the default branch, and name its command in the CI configuration or in the knowledge base’s technical/how-to-run.md.',
  R2: 'Keep the whole test suite under 15 minutes: split the slow tests out or run them in parallel.',
  R3: 'Run a CI pipeline on every merge request.',
  R4: 'Fix or quarantine the flaky tests, so that fewer than 5% of CI runs need a rerun over 30 days.',
  R5: 'Add a CI job that runs the linter and checks the formatting.',
  R6: 'Give the repository one setup command: a make setup target, a devcontainer or a compose file.',
  R7: 'Add a CI job that runs the type checker or a static analyser.',
  R8: 'Add a CLAUDE.md or AGENTS.md of at most 200 lines that links to the knowledge base’s index.',
  R9: 'Protect the default branch in the git provider: require a merge request, and do not let the platform’s account approve its own.',
  R10: 'Add a merge request template and write down the commit convention.',
  R11: 'Connect an error tracker (Sentry) or a log source (Loki) to the project under Settings → Connections.',
  R12: 'Accept or write the missing knowledge pages until the knowledge base is at least 70% complete.',
  R13: 'Run a secret scanner in CI or as a pre-commit hook.',
  R14: 'Commit a dependency lockfile that installs from the allow-listed registries.',
};

/**
 * What each criterion buys the project, in plain words: product/17's "Unlocks / protects" column
 * said without the spec's stage names or decision ids. The readiness read's own `unlocks` is the
 * domain's text, which names *Implementation*, the *Investigation stage* and *BD-007*, so the
 * popover never renders it (backlog 1241 plain-words it at the source for the wizard). Platform
 * text; held to the domain's criterion ids by the test.
 */
export const READINESS_UNLOCKS: Readonly<Record<string, string>> = {
  R1: 'Agents check their own work against your tests, and the evidence that a ticket is done is real.',
  R2: 'Agents get test results quickly, so fewer runs time out.',
  R3: 'Every merge request is checked by CI the same way, and flaky tests can be spotted.',
  R4: 'A failure caused by CI itself is not blamed on the agent.',
  R5: 'Review skips style, so there are fewer rounds of small fixes.',
  R6: 'Every workspace is set up the same way, and the app can be started to check a change.',
  R7: 'Mistakes are caught earlier, while the change is being written.',
  R8: 'Agents start with better context and spend fewer tokens finding their way.',
  R9: 'A person always merges: an agent cannot approve its own merge request.',
  R10: 'Merge requests can be checked against written rules rather than taste.',
  R11: 'Agents investigating a bug can read its errors and logs.',
  R12: 'Agents notice when a ticket contradicts what the project knows, and ask fewer questions.',
  R13: 'An agent’s commit is less likely to leak a secret.',
  R14: 'Builds are the same every time, inside the allowed network.',
};

/** What a criterion unlocks in plain words, or `null` for an id this build does not know. */
export const readinessUnlocks = (id: string): string | null =>
  Object.hasOwn(READINESS_UNLOCKS, id) ? (READINESS_UNLOCKS[id] ?? null) : null;

/** The how-to for a criterion, or `null` for an id this build does not know. */
export const readinessHowTo = (id: string): string | null =>
  Object.hasOwn(READINESS_HOW_TO, id) ? (READINESS_HOW_TO[id] ?? null) : null;

/** The next rung's cheapest missing criterion, read from the evaluation once the popover is open. */
const CheapestMissing = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const readiness = useProjectReadiness(projectId);
  if (readiness.isPending) {
    return <p className="text-fg-muted">Reading what is missing…</p>;
  }
  if (readiness.isError) {
    return readiness.error instanceof ApiError &&
      readiness.error.code === 'readiness_not_evaluated' ? (
      <p className="text-fg-muted">
        Discovery has not evaluated this project yet, so nothing is known to be missing.
      </p>
    ) : (
      <p className="text-fg-muted">What is missing could not be loaded.</p>
    );
  }
  const top = readiness.data.next_improvements[0];
  if (top === undefined) {
    return <p className="text-fg-muted">The evaluation names nothing missing.</p>;
  }
  const howTo = readinessHowTo(top.id);
  const unlocks = readinessUnlocks(top.id);
  return (
    <div data-readiness-missing={top.id} className="flex flex-col gap-0.5">
      <p>
        <span className="font-medium">First missing: {readinessCriterionLabel(top.id)}.</span>
        {howTo === null ? null : ` ${howTo}`}
      </p>
      {/* The client's plain words, never the read's `unlocks` (the domain's, with spec references). */}
      {unlocks === null ? null : <p className="text-fg-muted">It unlocks: {unlocks}</p>}
    </div>
  );
};

export const ReadinessPopover = ({
  level,
  project,
  trigger,
  triggerId,
}: {
  readonly level: number;
  readonly project: { readonly id: string; readonly key: string };
  /** The badge, drawn by `readiness-label.tsx` exactly as its plain button was. */
  readonly trigger: ReactElement;
  /** The plain button's id, kept, so the focus survives the swap. */
  readonly triggerId: string;
}): ReactElement => {
  const look = levelLook(level);
  const next = levelLook(level + 1);
  const needs = READINESS_RUNG_REQUIREMENTS[level];
  return (
    <Popover title={readinessLadderName(level)} trigger={trigger} triggerId={triggerId}>
      <p>
        {READINESS_LEVEL_MEANINGS[level] ??
          `This version of the platform does not name level ${level}.`}
      </p>
      {look === undefined ? null : next === undefined || needs === undefined ? (
        <p className="text-fg-muted">This is the top of the readiness ladder.</p>
      ) : (
        <>
          <p>
            <span className="font-medium">
              Next: level {level + 1} · {next.name}
            </span>
            {` — ${next.badge}. It needs: ${needs.map((id) => readinessCriterionLabel(id)).join(', ')}.`}
          </p>
          <CheapestMissing projectId={project.id} />
        </>
      )}
      <Link
        to="/projects/$key/settings/$section"
        params={{ key: project.key, section: 'discovery' }}
        className={cx('self-start rounded-sm text-link hover:underline', FOCUS_RING)}
      >
        Discovery & readiness
      </Link>
    </Popover>
  );
};
