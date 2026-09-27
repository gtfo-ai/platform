/**
 * Every production `compilePipeline` call site, and **where each one gets the dial** — WP-62,
 * criterion 4 (PROGRESS backlog 72 (b)).
 *
 * WP-28 declined backlog 72 (b) with a measurement: a compile step that reads the dial changes
 * `compilePipeline`'s signature at every call site, *"which several of them are in no position to
 * do (the interpreter is pure, and two of those sites are inside a transaction the settings port
 * must not be asked from)"*. That was fifteen sites on the day; it is **twenty-four** on this one,
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
 * exists to prevent (a dial moved mid-task moving the task).
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
    sites: 2,
    how: "inside the human command's transaction (`writeTask`): the loaded row's `stored.pipelineDial` — the hand-back's target check therefore refuses a stage the dial disabled",
  },
  'packages/application/src/pipeline/dependency-gate.ts': {
    sites: 2,
    how: "inside the `pipeline.outbound` duty's transactions: the loaded row's `stored`/`current.pipelineDial`",
  },
  'packages/application/src/pipeline/stage-executor.ts': {
    sites: 1,
    how: "the `stage.execute` job's revalidation: the loaded row's `stored.pipelineDial`",
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

const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] });

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  file.includes('/src/testing/') ||
  file.includes('/dist/');

/** Comment lines out, so a docblock that names the function is not a call site. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
        ? ''
        : line;
    })
    .join('\n');

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

/** Every call whose dial is not a read of the frozen copy, by file and argument. */
export const unfrozenCalls = (found: ReadonlyMap<string, string[][]>): string[] =>
  [...found].flatMap(([file, calls]) =>
    calls
      .filter((args) => !FROZEN_COPY.some((pattern) => pattern.test(args[2] ?? '')))
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

  it('counts twenty-four — fifteen when WP-28 measured it — and states how each resolves the dial', () => {
    const total = [...census().values()].reduce((sum, calls) => sum + calls.length, 0);
    expect(total).toBe(24);
    for (const [file, entry] of Object.entries(EXPECTED_SITES)) {
      expect(entry.how.length, file).toBeGreaterThan(20);
    }
  });

  it('passes every site the task’s frozen copy, so none asks the settings port', () => {
    expect(unfrozenCalls(census())).toEqual([]);
  });

  it('refuses a site that resolves the dial from the project’s current settings (the canary)', () => {
    const planted = new Map([
      [
        'packages/application/src/pipeline/planted.ts',
        compileCalls(
          'const p = compilePipeline(stored.task.template, stored.template, pipelineDialFor(settings));',
        ),
      ],
      [
        'packages/application/src/pipeline/routed.ts',
        compileCalls('compilePipeline(stored.task.template, stored.template, live.pipelineDial)'),
      ],
      [
        'packages/application/src/pipeline/also-planted.ts',
        compileCalls('compilePipeline(stored.task.template, stored.template)'),
      ],
    ]);
    expect(unfrozenCalls(planted)).toEqual([
      'packages/application/src/pipeline/planted.ts: compilePipeline(stored.task.template, stored.template, pipelineDialFor(settings))',
      'packages/application/src/pipeline/routed.ts: compilePipeline(stored.task.template, stored.template, live.pipelineDial)',
      'packages/application/src/pipeline/also-planted.ts: compilePipeline(stored.task.template, stored.template)',
    ]);
  });
});
