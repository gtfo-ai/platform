/**
 * **Every reader of the project's settings is decided about `configRefusal`** — WP-106 review
 * round 1, read off disk.
 *
 * Since WP-106 the settings port answers a configuration this release cannot parse as
 * `ProjectSettings.configRefusal`, with the platform's defaults standing in for the unreadable
 * layer. A reader that decides a task's next transition or policy must not act on those defaults
 * (the reviewer measured one that did: a plan-approval gate let a task reach Ready). This census
 * finds every `settings.forProject(` and `options.settings(` call in the application ring's
 * sources (git's scope, tracked and untracked, through `scripts/census-files.mjs`) and requires
 * **one of two** things of each:
 *
 *  - it is **guarded**: `configRefusal` (or `settingsAdmission`) appears within the next
 *    {@link WINDOW} lines, which is where every guard this round wrote sits; or
 *  - it is **declared** below, by file and count, with the reason acting on the defaults is safe
 *    there (or the guard that stands in front of it).
 *
 * Both directions are checked, so a new reader fails here until somebody decides it, and a stale
 * declaration fails too.
 *
 * **What it cannot see** (each spelling stated, rule 48): a read through **another name** for the
 * port — `const { settings: port } = options; port.forProject(id)`, or a port handed to a helper and
 * read there — which the reviewer measured passing the census. It is not closed by widening the
 * pattern to every `.forProject(`, because `PipelineIntegrationsPort.forProject` and
 * `GitMirrorCredentials.forProject` share the name, and a census that fires on them gets switched
 * off. Also, a reader that takes `ProjectSettings` as an argument from a caller (the
 * planner, `runBudgetUsd`, the snapshot) rather than reading the port. Those are reached only through
 * a guarded or declared read, which is the property this census pins. A guard placed more than
 * {@link WINDOW} lines after its read is reported as unguarded; move it closer or declare it.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CensusUnreadableError,
  censusPaths,
  readCensus,
} from '../../../../scripts/census-files.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const WINDOW = 25;

/** Unguarded reads, by file, with how many and why acting on the defaults is safe there. */
const DECLARED: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  'packages/application/src/ask/executor.ts': {
    count: 1,
    reason: 'the ask admission: `admissionVerdict` asks `settingsAdmission` further down',
  },
  'packages/application/src/ask/runtime.ts': {
    count: 1,
    reason: 'composition: hands the port to the ask executor, whose admission is the guard',
  },
  'packages/application/src/pipeline/runtime.ts': {
    count: 1,
    reason: 'composition: hands the port to the stage executor, whose admission is the guard',
  },
  'packages/application/src/pipeline/stage-executor.ts': {
    count: 1,
    reason: 'the run admission: `admit` asks `settingsAdmission` before anything else',
  },
  'packages/application/src/ask/mirror.ts': {
    count: 1,
    reason:
      'mirrors an answer to the ticket only when `features.ask.mirror_to_ticket` is on; off on the defaults, so nothing is posted (closed)',
  },
  'packages/application/src/bootstrap/batch.ts': {
    count: 1,
    reason:
      'starting a batch needs `features.history_bootstrap.enabled`; off on the defaults, so it is refused `feature_disabled` (closed, misnamed: GET …/config names the cause)',
  },
  'packages/application/src/bootstrap/collect.ts': {
    count: 1,
    reason: 'chunk tasks are marked `settingsRefreezePending` and their runs refused at admission',
  },
  'packages/application/src/maintenance/scheduler.ts': {
    count: 1,
    reason: 'schedules only when `features.maintenance.enabled`; off on the defaults (closed)',
  },
  'packages/application/src/notify/digest.ts': {
    count: 1,
    reason: 'a notification fails open (rule 20): delivered under the shipped digest defaults',
  },
  'packages/application/src/notify/duty.ts': {
    count: 1,
    reason: 'a notification fails open (rule 20): delivered under the shipped digest defaults',
  },
  'packages/application/src/notify/maintenance-report.ts': {
    count: 1,
    reason: 'a notification fails open (rule 20)',
  },
  'packages/application/src/onboarding/discovery.ts': {
    count: 1,
    reason:
      'creates the discovery task marked `settingsRefreezePending`; its run is refused at admission',
  },
  'packages/application/src/onboarding/rediscovery.ts': {
    count: 2,
    reason:
      'the ceiling shown on the button and the new discovery task; the run is refused at admission',
  },
  'packages/application/src/pipeline/commands.ts': {
    count: 1,
    reason:
      'the retry’s model check (WP-159) admits the stage’s configured model; on the defaults that is the template default, which is listed anyway, and a model only the unreadable document pinned is refused `model_not_listed` (closed); the attempt it would start is refused at admission',
  },
  'packages/application/src/pipeline/delivery-measures.ts': {
    count: 1,
    reason:
      'a statistic; it reads `templateByIssueType`, which the port never takes from the document',
  },
  'packages/application/src/pipeline/gates.ts': {
    count: 2,
    reason:
      'the CI wait on a poll-only binding (WP-136) and the same gate’s provider-outage bound (backlog 490) read only `ci_timeout_minutes`; on the defaults each waits 60 minutes and parks (closed), and the gate it waits for settles through `judgeCiSettlement`, which refuses a refused configuration by name',
  },
  'packages/application/src/pipeline/manual-start.ts': {
    count: 1,
    reason:
      'the manual start (WP-122) asks only `picksUpNewTickets`, the predicate intake asks on the same settings, so the two answer alike; the match it records goes through intake, which parks a refused configuration at its first step',
  },
  'packages/application/src/pipeline/saga.ts': {
    count: 5,
    reason:
      'intake fails open (the task is created, marked, and parked by its first decided step); the plan and budget approval gates run only behind the stage-completion guard in `stageCompletedHandler`; the scheduler admits under the schema floor `REFUSED_CONFIGURATION_WIP_LIMITS`, and an admitted task meets the named refusal at its first step; the default-branch handler (WP-142) reads only `defaultBranch`, the `projects.default_branch` column, which no configuration document carries',
  },
  'packages/application/src/pipeline/ticket-claim.ts': {
    count: 1,
    reason:
      'the ticket claim (WP-177) reads only `ticketLifecycle`, the task-management binding’s block, which no configuration document carries; the run it admits is still refused by name at `admit`',
  },
  'packages/application/src/pipeline/ticket-lifecycle.ts': {
    count: 2,
    reason:
      'the lifecycle handler and its duty (WP-177) read only `ticketLifecycle` — the task-management binding’s block, which no configuration document carries — and move the ticket, never the task',
  },
  'packages/application/src/pipeline/ticket-release.ts': {
    count: 1,
    reason:
      'the ticket release (WP-177, its own module since WP-178) reads only `ticketLifecycle`’s `pick_up_from` — the binding’s, which no configuration document carries — and moves the ticket, never the task',
  },
  'packages/application/src/pipeline/jobs.ts': {
    count: 1,
    reason:
      'the human-return window (WP-178) reads `ticketLifecycle` — the binding’s, which no configuration document carries — and `human_returns.acknowledgements`, whose default is no added word: acting on the defaults reads fewer words as thanks, so it returns the task where the project’s words would not, which is the failure direction TD-029 decision 8 chose',
  },
  'packages/application/src/pipeline/workpad.ts': {
    count: 2,
    reason:
      'the status mapping writes nothing on the defaults (closed); the workpad render reads no document key',
  },
  'packages/application/src/shadow/batch.ts': {
    count: 1,
    reason:
      'starting a batch needs `features.shadow_mode.enabled`; off on the defaults, so it is refused `feature_disabled` (closed, misnamed)',
  },
  'packages/application/src/shadow/human-review.ts': {
    count: 1,
    reason:
      'the comparison task is created marked `settingsRefreezePending` (`insertReviewTask`); its run is refused at admission',
  },
};

const READ = /settings\.forProject\(|options\.settings\(/;

const unguardedReads = (): Map<string, number> => {
  const { files, unreadable } = readCensus(
    REPO_ROOT,
    censusPaths(REPO_ROOT, { pathspecs: ['packages/application/src/*.ts'] }),
  );
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  const found = new Map<string, number>();
  for (const { path: file, contents } of files) {
    if (file.endsWith('.test.ts') || file.includes('/testing/') || file.endsWith('/settings.ts')) {
      continue;
    }
    const lines = contents.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!READ.test(line) || trimmed.startsWith('*') || trimmed.startsWith('//')) {
        return;
      }
      const window = lines.slice(index, index + WINDOW).join('\n');
      if (!window.includes('configRefusal') && !window.includes('settingsAdmission')) {
        found.set(file, (found.get(file) ?? 0) + 1);
      }
    });
  }
  return found;
};

describe('the readers of a configuration that cannot be read (WP-106 review round 1)', () => {
  it('decides every settings read: guarded within the window, or declared with its reason', () => {
    const found = unguardedReads();
    const declared = new Map(Object.entries(DECLARED).map(([file, entry]) => [file, entry.count]));
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(declared));
  });
});
