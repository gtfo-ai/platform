/**
 * **Every task transition that leaves a stage closes its offer** — WP-276 criterion (3), TD-031
 * decision 3, counted off disk (the shape of `task-save-sites.test.ts`).
 *
 * Two tables, compared in both directions so neither can go stale:
 *
 * 1. **The domain's transitions** (`packages/domain/src/aggregates/task.ts`), each classified as
 *    leaving its stage entry or not. A new exported transition fails here until somebody decides.
 * 2. **Every production `tasks.save` site**, by file: how the file's saves close the stage offer —
 *    `applyDecision` (which closes before it moves the task, `./transitions.ts`), an explicit
 *    `closeStageOffer`/`endWithdrawnRun` call before the save, or a **stated** reason no stage offer
 *    can be live where it saves. A file that gains a `tasks.save` fails here until it is classified,
 *    and a file classified as closing must still contain a closing call.
 *
 * It is syntactic, like the save census: it cannot see an alias or a save through a variable, and it
 * does not prove the close is *before* the save in each function — the call sites carry that as a
 * comment and `offer-withdrawal.test.ts` asserts the order against the store.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** `true` = moves the task off its stage entry (or stops it there) — the offer must close. */
const DOMAIN_TRANSITIONS: ReadonlyMap<string, boolean> = new Map([
  ['createTask', false],
  ['queueTask', false],
  ['enterStage', true],
  ['completeStage', true],
  ['returnToStage', true],
  ['resumeStage', true],
  ['returnEscalatedTask', true],
  ['askQuestion', true],
  ['requestApproval', true],
  // S-27.1 (BACKLOG 1480): out of `paused` or `needs_human` back into the approval wait — a stopped
  // task holds no offer, and the wait asks for none.
  ['resumeIntoApprovalWait', false],
  // S-28.1 (M28 ruling 4): a paused attempt that never ran re-entered in place — a paused task holds
  // no offer, and the stage job the resume enqueues writes the entry's offer.
  ['resumePausedAttempt', false],
  ['pauseTask', true],
  ['escalateTask', true],
  ['amendEscalation', false],
  ['takeOverTask', true],
  ['handBackTask', true],
  ['steerRun', false],
  ['recordArtifact', false],
  ['markReadyForMerge', true],
  ['recordMerge', true],
  ['startRetrospective', true],
  ['startLibrarianCuration', true],
  ['completeTask', true],
  ['cancelTask', true],
]);

/** Exported helpers of `task.ts` that are not transitions at all. */
const NOT_TRANSITIONS = new Set([
  'isMergedTask',
  'handBackStages',
  'isCurrentStageAttempt',
  'taskBranchName',
  'resumeCommands',
  'isTaskFinished',
  'assertMutatingActionAllowed',
]);

type Closing = { readonly closes: true } | { readonly closes: false; readonly because: string };

const CLOSES: Closing = { closes: true };

/** How each file's `tasks.save` sites close the stage offer (WP-276). */
const SAVE_SITES: ReadonlyMap<string, Closing> = new Map<string, Closing>([
  ['packages/application/src/pipeline/transitions.ts', CLOSES], // `applyDecision` closes first
  ['packages/application/src/pipeline/commands.ts', CLOSES], // pause, cancel, take-over
  ['packages/application/src/pipeline/saga.ts', CLOSES], // the merge-request escalation
  [
    'packages/application/src/pipeline/settle.ts',
    { closes: false, because: "the run's own ending: its `finish` closed the offer first" },
  ],
  [
    'packages/application/src/recovery/run-lease.ts',
    { closes: false, because: "the sweep's `finish` closes the swept run's own offer" },
  ],
  [
    'packages/application/src/pipeline/stage-executor.ts',
    {
      closes: false,
      because:
        'admission saves only after `revalidateOpen` found no live stage offer; the planless escalation withdrew its own',
    },
  ],
  [
    'packages/application/src/recovery/stranded-stage.ts',
    { closes: false, because: 'it acts only on a stage entry with no run and no job' },
  ],
  [
    'packages/application/src/pipeline/deadlines.ts',
    { closes: false, because: 'a take-over expiry: the take-over withdrew or stopped the run' },
  ],
  [
    'packages/application/src/pipeline/dependency-gate.ts',
    {
      closes: false,
      because: "after the Developer's run settled (its own offer closed), before any next offer",
    },
  ],
  [
    'packages/application/src/shadow/report.ts',
    { closes: false, because: 'a shadow task at its human stage, where no agent offer exists' },
  ],
  ['packages/application/src/pipeline/task-conflict.ts', CLOSES],
  ['packages/application/src/pipeline/dead-letter.ts', CLOSES],
  ['packages/application/src/pipeline/job-escalation.ts', CLOSES],
  ['packages/application/src/pipeline/config-refusal.ts', CLOSES],
  // S-22.14 (backlog 744): a claim refused at admission pauses its task after closing its offer.
  ['packages/application/src/pipeline/claim-admission.ts', CLOSES],
  // S-28.5: the reverse sync escalates through `applyDecision` and (S-28.14) cancels through
  // `task-cancel.ts`, which closes first; its one save left is the amend of a `needs_human` task.
  [
    'packages/application/src/pipeline/ticket-status-recheck.ts',
    {
      closes: false,
      because:
        'its only save is the amended brief of a needs_human task, which holds no live offer; its cancel is task-cancel.ts and its escalation applyDecision',
    },
  ],
  // S-28.14: the one cancellation — `closeStageOffer` before the save.
  ['packages/application/src/pipeline/task-cancel.ts', CLOSES],
]);

const SAVE = /\btasks\.save\s*\(/;
const CLOSE = /\b(?:closeStageOffer|endWithdrawnRun)\s*\(/;

const isTestTier = (file: string): boolean =>
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) || file.includes('/src/testing/');

const production = (): readonly string[] =>
  censusPaths(REPO_ROOT, { pathspecs: ['packages/application/src/*.ts'] }).filter(
    (file) => !isTestTier(file),
  );

describe('every transition that leaves a stage closes its offer (WP-276 criterion 3)', () => {
  it('classifies every exported transition of the Task aggregate, in both directions', () => {
    const source = withoutComments(censusText(REPO_ROOT, 'packages/domain/src/aggregates/task.ts'));
    const exported = [...source.matchAll(/^export const (\w+) = \(/gm)]
      .map((match) => match[1] as string)
      .filter((name) => !NOT_TRANSITIONS.has(name))
      .sort();
    expect(exported).toEqual([...DOMAIN_TRANSITIONS.keys()].sort());
  }, 15_000);

  it('classifies every production file that saves a task, and each closing file closes', () => {
    const saving = production().filter((file) =>
      SAVE.test(withoutComments(censusText(REPO_ROOT, file))),
    );
    expect(saving.sort()).toEqual([...SAVE_SITES.keys()].sort());
    for (const [file, closing] of SAVE_SITES) {
      if (closing.closes) {
        expect(CLOSE.test(withoutComments(censusText(REPO_ROOT, file))), file).toBe(true);
      } else {
        expect(closing.because.length, file).toBeGreaterThan(0);
      }
    }
  }, 15_000);
});
