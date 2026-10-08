/**
 * Every production `compilePipeline` call site, and **where each one gets the dial** — WP-62,
 * criterion 4 (PROGRESS backlog 72 (b)).
 *
 * WP-28 declined backlog 72 (b) with a measurement: a compile step that reads the dial changes
 * `compilePipeline`'s signature at every call site, *"which several of them are in no position to
 * do (the interpreter is pure, and two of those sites are inside a transaction the settings port
 * must not be asked from)"*. That was fifteen sites on the day; it is **twenty-five** on this one,
 * which is why the number lives here, produced by the test, rather than in a sentence (standing
 * rule 63).
 *
 * ## How the preset is resolved — one answer for every site
 *
 * The dial's two pipeline policies are **frozen onto the task** by the site that creates it
 * (`StoredTask.pipelineDial`, `tasks.pipeline_dial`, migration 0049), off the project's
 * materialised preset (`pipelineDialFor`, BD-027:14) — the site that creates a task already holds
 * the project's settings, outside any transaction. So every compile passes the copy on the row it
 * has just loaded, and **no** site asks the settings port for it: not the ones inside a handler's or
 * a job's transaction, and not the rest. That is the property this census enforces — the third
 * argument of every call is a read of the frozen copy — so a site that reached for the project's
 * current settings instead would fail here by name, and would also be the defect the freeze
 * exists to prevent (a dial moved mid-task moving the task). Since WP-174 the fourth argument,
 * `qa_stage`, is held to the same rule (see `FROZEN_QA_STAGE` below: the literal `false` WP-174
 * admitted until the column existed is refused since WP-177 wrote it).
 *
 * ## Scope, and what it cannot see
 *
 * git's tree, tracked and untracked-but-committable (standing rules 7 and 85); production sources
 * only — a test compiles whatever it likes, including `null`, which is what a test *is*. It is a
 * syntactic check, like `task-save-sites.test.ts`: a call through an alias, or a dial laundered
 * through a local variable (`const d = settings…; compilePipeline(a, b, d)`), is not a
 * `.pipelineDial` read and **fails** here rather than passing — the fail-closed direction, at the
 * price of a false positive a reviewer resolves by adding a named exception below.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * Where each site is, how many there are, and the sentence criterion 4 asks for: how that site
 * resolves the preset. "In a transaction" names the sites the settings port must not be asked from.
 */
const EXPECTED_SITES: Readonly<Record<string, { readonly sites: number; readonly how: string }>> = {
  'packages/application/src/pipeline/saga.ts': {
    sites: 6,
    how: "the handler's own transaction (EventBus owns it) and intake's: the loaded task's `stored.pipelineDial`; intake's insert is the one writer, from `pipelineDialFor(settings)` read before the transaction opened",
  },
  'packages/application/src/pipeline/jobs.ts': {
    sites: 3,
    how: "inside the job's transaction: the loaded row's `stored`/`current.pipelineDial`",
  },
  'packages/application/src/pipeline/commands.ts': {
    sites: 5,
    how: "inside the human command's transaction (`writeTask`): the loaded row's `stored.pipelineDial` — the hand-back's and the return's target checks (`assertReturnTarget`, backlog 483) therefore refuse a stage the dial disabled, `keepGateFeedback` (WP-152) asks of the same compiled pipeline whether the parked stage is a gate, and `resumeTargetOf` (WP-152 round 1) which post-merge stage a merged task resumes into",
  },
  'packages/application/src/pipeline/dependency-gate.ts': {
    sites: 2,
    how: "inside the `pipeline.outbound` duty's transactions: the loaded row's `stored`/`current.pipelineDial`",
  },
  'packages/application/src/pipeline/merge-request-ready.ts': {
    sites: 2,
    how: "inside the two merge-request handlers' transactions (WP-138, backlog 486): the loaded row's `stored.pipelineDial` — only to ask whether the completed stage produces ImplementationNotes, and whether an entered stage is an agent stage",
  },
  'packages/application/src/pipeline/stage-executor.ts': {
    sites: 1,
    how: "the `stage.execute` job's revalidation: the loaded row's `stored.pipelineDial`",
  },
  'packages/application/src/pipeline/ready-head.ts': {
    sites: 1,
    how: "inside the `ready_head_check` duty's own transaction (WP-79): the re-loaded row's `current.pipelineDial` — so the gate a human's new commits re-enter is one the dial left enabled",
  },
  'packages/application/src/pipeline/ci-settle.ts': {
    sites: 1,
    how: "the loaded row's `stored.pipelineDial`",
  },
  'packages/application/src/pipeline/epic-split.ts': {
    sites: 1,
    how: "the loaded row's `stored.pipelineDial`",
  },
  'packages/application/src/pipeline/review-only.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, which the review-only creating site writes as `null` (its own opt-in, BD-028)',
  },
  'packages/application/src/pipeline/ticket-lint.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, written `null` by the linter’s creating site (its own opt-in)',
  },
  'packages/application/src/bootstrap/collect.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, written `null` — the platform’s own mining task, not a picked-up ticket',
  },
  'packages/application/src/shadow/batch.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, written `null` — shadow runs only at Observe, where product/19 §11 prints both pipeline policies as "—"',
  },
  'packages/application/src/shadow/report.ts': {
    sites: 1,
    how: "the loaded shadow task's `stored.pipelineDial` (null, above)",
  },
  'packages/application/src/maintenance/scheduler.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, written `null` — the maintenance batch is its own opt-in, scheduled rather than picked up',
  },
  'packages/application/src/onboarding/discovery.ts': {
    sites: 1,
    how: '`stored.pipelineDial`, written `null` — a one-off onboarding task',
  },
  'packages/application/src/recovery/stranded-stage.ts': {
    sites: 1,
    how: "the stranded-stage recovery's question *is this an agent or gate stage?* (WP-108): the loaded row's `stored.pipelineDial`, as `stage.execute` itself compiles it",
  },
  'packages/application/src/pipeline/ticket-claim.ts': {
    sites: 1,
    how: "the claim's refusal (WP-177), inside its own escalation transaction: the re-loaded row's `current.pipelineDial` — the escalation the claim raises closes the stage's row as every escalation does",
  },
  'packages/application/src/pipeline/ticket-lifecycle.ts': {
    sites: 1,
    how: "the lifecycle handler (WP-177), in the handler's own transaction: the loaded row's `stored.pipelineDial` — so the `approved` moment is the last review stage the dial left enabled",
  },
  'apps/server/src/queries/pipeline-queries.ts': {
    sites: 1,
    how: 'the read side: `tasks.pipeline_dial` off the same row the page reads, parsed through `taskPipelineDialSchema` (a row that fails offers no hand-back stage)',
  },
};

/**
 * The third arguments that are a read of the frozen copy: `stored`/`current.pipelineDial` — the two
 * names every site gives the `StoredTask` it has just loaded — and the read side's parse of the same
 * column.
 *
 * **Narrowed to those receivers in review round 1**, which measured the first version
 * (`^[a-z]\w*\.pipelineDial$`) accepting a dial routed through any local object —
 * `const live = { pipelineDial: pipelineDialFor(await deps.settings.forProject(…)) }` passed. The
 * residual, stated rather than implied: a local that is *named* `stored` or `current` and is not
 * the loaded row still passes; a syntactic census cannot tell the two apart.
 */
const FROZEN_COPY = [/^(?:stored|current)\.pipelineDial$/, /^dial === null \? null : dial\.data$/];

/**
 * The fourth argument, `qa_stage` (WP-174, TD-029 decision 9): whether the task has the human `qa`
 * stage, frozen on the task at creation (`tasks.qa_stage`, migration 0088). The same rule as the
 * dial — a read of the loaded row, never the project's current settings, because a mapping changed
 * mid-task must not reshape a task in flight.
 *
 * WP-174 added the argument before the column existed and admitted the literal `false` until the
 * column did; **WP-177 wrote the column** (migration 0088) and replaced every `false` with
 * `stored`/`current.qaStage`, so the literal is refused now. The read side's `task.qaStage` is the
 * same column off the Drizzle row the page reads (`apps/server/src/queries/pipeline-queries.ts`).
 */
const FROZEN_QA_STAGE = [/^(?:stored|current)\.qaStage$/, /^task\.qaStage$/];

const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] });

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  file.includes('/src/testing/') ||
  file.includes('/dist/');

/** The top-level arguments of every `compilePipeline(` call in `source`, as trimmed text. */
export const compileCalls = (source: string): string[][] => {
  const calls: string[][] = [];
  const key = 'compilePipeline(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(key, from);
    if (start < 0) {
      return calls;
    }
    const args: string[] = [];
    let depth = 1;
    let current = '';
    let index = start + key.length;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index] as string;
      if ('([{'.includes(character)) depth += 1;
      if (')]}'.includes(character)) depth -= 1;
      if (depth === 0) break;
      if (character === ',' && depth === 1) {
        args.push(current);
        current = '';
        continue;
      }
      current += character;
    }
    args.push(current);
    calls.push(args.map((arg) => arg.replace(/\s+/g, ' ').trim()).filter((arg) => arg.length > 0));
    from = index;
  }
};

const census = (): Map<string, string[][]> => {
  const found = new Map<string, string[][]>();
  for (const file of sources()) {
    if (isTestTier(file)) continue;
    const calls = compileCalls(withoutComments(censusText(REPO_ROOT, file)));
    if (calls.length > 0) found.set(file, calls);
  }
  return found;
};

/** Every call whose dial or `qa_stage` is not a read of the frozen copy, by file and argument. */
export const unfrozenCalls = (found: ReadonlyMap<string, string[][]>): string[] =>
  [...found].flatMap(([file, calls]) =>
    calls
      .filter(
        (args) =>
          args.length !== 4 ||
          !FROZEN_COPY.some((pattern) => pattern.test(args[2] ?? '')) ||
          !FROZEN_QA_STAGE.some((pattern) => pattern.test(args[3] ?? '')),
      )
      .map((args) => `${file}: compilePipeline(${args.join(', ')})`),
  );

describe('the `compilePipeline` call-site census (WP-62, criterion 4)', () => {
  it('has exactly the sites this work package states a resolution for, and no others', () => {
    const counts = Object.fromEntries(
      [...census()].map(([file, calls]) => [file, calls.length]).sort(),
    );
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_SITES)
        .map(([file, entry]) => [file, entry.sites])
        .sort(),
    );
    expect(counts).toEqual(expected);
  });

  it('counts thirty-three — fifteen when WP-28 measured it, twenty-four before WP-79, twenty-five before WP-108, twenty-six before WP-138, twenty-seven before backlog 483, twenty-eight before backlog 486, twenty-nine before WP-152, thirty-one before WP-177 — and states how each resolves the dial', () => {
    const total = [...census().values()].reduce((sum, calls) => sum + calls.length, 0);
    expect(total).toBe(33);
    for (const [file, entry] of Object.entries(EXPECTED_SITES)) {
      expect(entry.how.length, file).toBeGreaterThan(20);
    }
  });

  it('passes every site the task’s frozen copy of the dial and of qa_stage, so none asks the settings port', () => {
    expect(unfrozenCalls(census())).toEqual([]);
  });

  it('sees a call after a `//` inside a string, and drops a trailing comment from its arguments (backlog 269)', () => {
    // Until WP-96 this file dropped only whole comment lines, so a trailing comment inside a call
    // rode into the argument text; the shared scanner removes it and keeps the string's `//`.
    const planted =
      "const u = 'https://x'; compilePipeline(t, stored.template, // the dial\n  pipelineDialFor(settings), false);";
    expect(compileCalls(withoutComments(planted))).toEqual([
      ['t', 'stored.template', 'pipelineDialFor(settings)', 'false'],
    ]);
  });

  it('refuses a site that resolves the dial from the project’s current settings (the canary)', () => {
    const planted = new Map([
      [
        'packages/application/src/pipeline/planted.ts',
        compileCalls(
          'const p = compilePipeline(stored.task.template, stored.template, pipelineDialFor(settings), false);',
        ),
      ],
      [
        'packages/application/src/pipeline/routed.ts',
        compileCalls(
          'compilePipeline(stored.task.template, stored.template, live.pipelineDial, false)',
        ),
      ],
      [
        'packages/application/src/pipeline/also-planted.ts',
        compileCalls('compilePipeline(stored.task.template, stored.template)'),
      ],
      [
        'packages/application/src/pipeline/qa-asked.ts',
        compileCalls(
          'compilePipeline(stored.task.template, stored.template, stored.pipelineDial, lifecycle.qa !== undefined)',
        ),
      ],
      [
        'packages/application/src/pipeline/qa-missing.ts',
        compileCalls('compilePipeline(stored.task.template, stored.template, stored.pipelineDial)'),
      ],
      [
        'packages/application/src/pipeline/qa-literal.ts',
        compileCalls(
          'compilePipeline(stored.task.template, stored.template, stored.pipelineDial, false)',
        ),
      ],
      [
        'packages/application/src/pipeline/qa-frozen.ts',
        compileCalls(
          'compilePipeline(stored.task.template, stored.template, stored.pipelineDial, stored.qaStage)',
        ),
      ],
    ]);
    expect(unfrozenCalls(planted)).toEqual([
      'packages/application/src/pipeline/planted.ts: compilePipeline(stored.task.template, stored.template, pipelineDialFor(settings), false)',
      'packages/application/src/pipeline/routed.ts: compilePipeline(stored.task.template, stored.template, live.pipelineDial, false)',
      'packages/application/src/pipeline/also-planted.ts: compilePipeline(stored.task.template, stored.template)',
      'packages/application/src/pipeline/qa-asked.ts: compilePipeline(stored.task.template, stored.template, stored.pipelineDial, lifecycle.qa !== undefined)',
      'packages/application/src/pipeline/qa-missing.ts: compilePipeline(stored.task.template, stored.template, stored.pipelineDial)',
      // WP-177: the literal WP-174 admitted until the column existed is refused now.
      'packages/application/src/pipeline/qa-literal.ts: compilePipeline(stored.task.template, stored.template, stored.pipelineDial, false)',
    ]);
  });
});
