/**
 * **Every optional collaborator of the pipeline runtime is either passed by this composition root
 * or is an admitted omission with a reason.**
 *
 * PROGRESS backlog 104. WP-35 shipped `PipelineRuntimeOptions.bootstrap` as an optional key, wired
 * it in the test harness, and did **not** wire it in `apps/server/src/pipeline.ts`; every unit,
 * contract and integration tier stayed green, because an optional key that is absent is a *valid*
 * program. The e2e found it — a bootstrap batch ran past its cap and finished `done` instead of
 * `paused` — three minutes of container time later, and only because that one case existed. It is
 * standing rule **31**'s shape (an optional collaborator is one production omits) and it had no
 * guard. This file is the guard, in `routes/client-census.test.ts`' shape: neither half is a list
 * in this file, and the comparison is an equality in **both** directions, so a key that gains a
 * wiring while still admitted fails exactly as loudly as one that loses it.
 *
 * ## How each half is obtained
 *
 * - **The declared half is read off the interface sources.** `PipelineRuntimeOptions` and the two
 *   interfaces it extends, plus `StageExecutorOptions` — parsed for `readonly x?:` members, with
 *   the `extends` clause of each checked against {@link OPTION_SOURCES} in both directions, so a
 *   new base interface cannot quietly add optional keys this census is blind to.
 * - **The passed half is read off the call sites.** The object literal `composePipeline` hands
 *   `createPipelineRuntime`, and — for the executor's own options — the literal
 *   `createPipelineRuntime` hands `createStageExecutor` plus the root's `execution:` block. A
 *   conditional spread counts as passing the key it names (`...(x === null ? {} : { x })`), because
 *   that is a deliberate "absent when unconfigured" rather than an omission.
 *
 * ## What it cannot see, stated rather than implied
 *
 * It is a **text** parse, not a type check: a key passed through a spread of a variable
 * (`...someOptions`) is invisible, and so is a collaborator handed over at a second call site. The
 * parse is calibrated rather than trusted — every **required** key of each interface must also be
 * found, so a parser that silently returned nothing fails here instead of passing vacuously. It
 * says nothing about whether a passed collaborator *works*; that is the e2e's, and it is the tier
 * this file exists to stop paying for a missing key.
 *
 * It reads sources through `withoutComments`, which until WP-73 took a `/*` inside a string or a
 * `//` comment for a block-comment opener and deleted the code up to the next `*\/` — WP-72 lost
 * `heldConnections` and `shadow` from this census to a comment naming `/webhooks/*` (PROGRESS
 * backlog 261). The stripper is a scanner now, and its own docblock states its one heuristic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readSource,
  repositoryRoot,
  sourceFilesUnder,
  withoutComments,
} from './routes/web-sources.js';

const read = (path: string): string =>
  withoutComments(readFileSync(join(repositoryRoot, path), 'utf8'));

const RUNTIME = 'packages/application/src/pipeline/runtime.ts';
const EXECUTOR = 'packages/application/src/pipeline/stage-executor.ts';
const COMPOSITION = 'apps/server/src/pipeline.ts';
const ROOT = 'apps/server/src/runtime.ts';

/**
 * Where each options interface of the runtime lives.
 *
 * `PipelineRuntimeOptions` extends two others, and an optional collaborator added to either is
 * exactly as absent in production as one added to the first. The list is held to the sources by
 * {@link extendsOf} below rather than by memory.
 */
const OPTION_SOURCES: Readonly<Record<string, string>> = {
  PipelineRuntimeOptions: RUNTIME,
  PipelineSagaOptions: 'packages/application/src/pipeline/saga.ts',
  NotifyOptions: 'packages/application/src/notify/options.ts',
};

/**
 * The optional collaborators this composition root deliberately does not pass, and why.
 *
 * An **admitted-omission list, not a filter**: the assertions below are equalities, so a key that
 * leaves this list without a wiring fails, and a key that gains a wiring while still listed fails
 * too (standing rule 7's corollary — a list that only suppressed failures goes stale silently).
 */
const ADMITTED_OMISSIONS: Readonly<Record<string, string>> = {
  reviewCommentWindowMs:
    'BD-007’s batch window for human merge-request comments, whose default (2 minutes, DEFAULT_REVIEW_COMMENT_WINDOW_MS) is the shipped behaviour. It is a number with a stated default rather than a collaborator whose absence changes what the pipeline can do, so there is nothing for this root to decide until it becomes configuration.',
};

/** The same, for the options the stage executor takes that this root owns. */
const ADMITTED_EXECUTION_OMISSIONS: Readonly<Record<string, string>> = {
  concurrency:
    'declared on StageExecutorOptions and read by nothing: createPipelineRuntime sizes the stage worker from its own `stageConcurrency` (runtime.ts’s `work({concurrency})`), so passing this would configure a field the executor never consults. Filed as discovered work rather than wired, because deleting a declared option is a decision for the ring that owns it.',
};

/** The body of `export interface <name> … { … }`, brace-matched. */
const interfaceBody = (source: string, name: string): string => {
  const at = source.search(new RegExp(`export interface ${name}\\b`));
  if (at < 0) {
    throw new Error(`census: interface ${name} not found`);
  }
  return braceBody(source, source.indexOf('{', at));
};

/** The interfaces `<name>` extends, or none. */
const extendsOf = (source: string, name: string): string[] => {
  const declaration = new RegExp(`export interface ${name}\\b([^{]*)\\{`).exec(source);
  const clause = declaration?.[1] ?? '';
  const extended = /extends\s+([^{]*)$/.exec(clause.trim());
  return (extended?.[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/** From the `{` at `open` to its match, exclusive — counting `(`, `[` and `{` alike. */
const braceBody = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error('census: unbalanced source');
};

const members = (body: string, optional: boolean): string[] => {
  const found = new Set<string>();
  for (const segment of topLevel(body)) {
    const match = /^readonly\s+(\w+)(\?)?\s*[:(]/.exec(segment.trim());
    if (match !== null && (match[2] === '?') === optional) {
      found.add(match[1] as string);
    }
  }
  return [...found];
};

/** The segments of an object body or interface body, split on its own top-level separators. */
const topLevel = (body: string): string[] => {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
    }
    if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
};

/**
 * The keys of the object literal at `marker` (which ends with its opening brace).
 *
 * A spread contributes the keys its object branches name, so a collaborator composed only when an
 * operator configured it — `...(x === null ? {} : { x })` — counts as passed. A spread of a
 * *variable* contributes nothing, which is the blindness the module note states.
 */
const passedKeys = (source: string, marker: string): Set<string> => {
  const at = source.indexOf(marker);
  if (at < 0) {
    throw new Error(`census: call site ${marker} not found`);
  }
  const keys = new Set<string>();
  for (const segment of topLevel(braceBody(source, at + marker.length - 1))) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith('...')) {
      for (const [, name] of trimmed.matchAll(/\{\s*(\w+)\s*[,}:]/g)) {
        keys.add(name as string);
      }
      continue;
    }
    const named = /^(\w+)\s*[:,]/.exec(trimmed) ?? /^(\w+)$/.exec(trimmed);
    if (named !== null) {
      keys.add(named[1] as string);
    }
  }
  return keys;
};

const missing = (declared: readonly string[], passed: ReadonlySet<string>): string[] =>
  declared.filter((key) => !passed.has(key)).toSorted();

describe('the pipeline runtime’s optional collaborators', () => {
  const compositionSource = read(COMPOSITION);
  const passed = passedKeys(compositionSource, 'createPipelineRuntime({');

  it('names every interface the options extend, so no base adds keys unseen', () => {
    const extended = new Set(
      Object.entries(OPTION_SOURCES).flatMap(([name, path]) => extendsOf(read(path), name)),
    );
    const declared = new Set(Object.keys(OPTION_SOURCES));
    // Both directions: an unlisted base fails, and a listed interface nothing extends fails too —
    // the second is what keeps this list from outliving the type it describes.
    expect([...extended].toSorted()).toEqual(
      [...declared].filter((name) => name !== 'PipelineRuntimeOptions').toSorted(),
    );
  });

  it('passes every optional collaborator, or admits the omission with a reason', () => {
    const optional = Object.entries(OPTION_SOURCES).flatMap(([name, path]) =>
      members(interfaceBody(read(path), name), true),
    );
    expect(missing(optional, passed)).toEqual(Object.keys(ADMITTED_OMISSIONS).toSorted());
  });

  it('is calibrated: the same parse finds every required collaborator too', () => {
    // Without this, a parser that returned an empty set would make the census above pass while
    // asserting nothing (standing rule 44). The required keys are the ones a missing wiring would
    // fail the typecheck on, so they are the honest control group.
    const required = Object.entries(OPTION_SOURCES).flatMap(([name, path]) =>
      members(interfaceBody(read(path), name), false),
    );
    expect(required.length).toBeGreaterThan(5);
    expect(missing(required, passed)).toEqual([]);
  });

  it('wires the two collaborators whose absence this census was written for', () => {
    // Named positively as well as covered by the equality, because these two are the measurement:
    // `bootstrap` was the omission (backlog 104), and `shadow` is the one WP-34 got right.
    expect(passed.has('bootstrap')).toBe(true);
    expect(passed.has('shadow')).toBe(true);
  });
});

describe('the stage executor’s own options', () => {
  const executorSource = read(EXECUTOR);
  const runtimeSource = read(RUNTIME);
  const compositionSource = read(COMPOSITION);
  /**
   * The executor is composed twice over: `createPipelineRuntime` supplies what it owns, and this
   * root supplies the rest through `execution:`. A key is passed when **either** does, which is why
   * both call sites are read rather than one.
   */
  const supplied = new Set([
    ...passedKeys(runtimeSource, 'createStageExecutor({'),
    ...passedKeys(compositionSource, 'execution: {'),
  ]);

  it('passes every optional option, or admits the omission with a reason', () => {
    const optional = members(interfaceBody(executorSource, 'StageExecutorOptions'), true);
    expect(missing(optional, supplied)).toEqual(
      Object.keys(ADMITTED_EXECUTION_OMISSIONS).toSorted(),
    );
  });

  it('is calibrated: the same parse finds every required option too', () => {
    const required = members(interfaceBody(executorSource, 'StageExecutorOptions'), false);
    expect(required.length).toBeGreaterThan(5);
    expect(missing(required, supplied)).toEqual([]);
  });

  it('wires the budget guard and the two per-feature caps', () => {
    // BD-010's guard and the two caps that decide whether a run starts: absent, each is silently
    // "never blocks", which is the failure mode this file exists for.
    expect(supplied.has('budgets')).toBe(true);
    expect(supplied.has('shadow')).toBe(true);
    expect(supplied.has('bootstrap')).toBe(true);
  });
});

/**
 * **The `Jobs` every composition of this process enqueues through is the one `startRuntime` wrapped.**
 *
 * PROGRESS backlog **106**, and the same shape as the census above: WP-36 moved
 * {@link PipelineComposition.jobs}'s seam out of `composePipeline` and into `startRuntime` so that
 * the drop-the-enqueue reproduction of the lost-wake-up class would cover more than the pipeline's
 * own enqueues — and left the three **worker** runtimes (knowledge, onboarding, history bootstrap)
 * taking `jobsRuntime.jobs`, while the docblock beside the wrap listed one of them as covered. Two
 * of that class's sites are enqueued from those runtimes, so the seam read as if it tested the
 * class and could only reach one site of it.
 *
 * ## Why this is a census and not a count (WP-48)
 *
 * The first version asserted that the raw instance is named exactly twice and that *some* number of
 * call sites take the wrapped one. That catches the spelling it was written for and nothing else: a
 * **fourth** worker runtime added below the wrap is a line somebody adds, and a count of `jobs,`
 * sites greater than five stays true whatever it is handed. So the call sites are now **read off
 * disk** and compared with {@link WRAPPED_JOBS_CALL_SITES} in **both** directions — a new
 * composition fails until somebody writes down why it takes a queue, and one that loses its `jobs`
 * argument fails too.
 *
 * The **file set** is read the way `client-census.test.ts` reads the SPA's: `git ls-files` plus the
 * untracked-but-not-ignored half (standing rule 85), so a composition root somebody has written and
 * not yet committed is censused rather than skipped.
 *
 * ## What it cannot see, stated rather than implied
 *
 * It is a **text** parse: an alias (`const raw = jobsRuntime.jobs`) and a `jobs` argument handed
 * over through a spread of a variable are both invisible. That is why the raw instance's own
 * spelling is pinned separately below, and why the calibration demands the parse actually find the
 * call sites rather than passing on an empty set (standing rule 44).
 */

/**
 * Every composition `startRuntime` hands a `Jobs`, and why each must be the **wrapped** one.
 *
 * Not a filter and not a suppression list: the assertion is an equality, so a call site that leaves
 * this table fails exactly as loudly as one that joins it.
 */
const WRAPPED_JOBS_CALL_SITES: Readonly<Record<string, string>> = {
  registerPartitionMaintenance:
    'the daily partition cron. It enqueues nothing a test drops, but it takes the process’s one queue and a second instance here would be a second pg-boss client.',
  registerPriceListMaintenance: 'the price-list cron, for registerPartitionMaintenance’s reason.',
  composePipeline:
    'the pipeline: every stage job, every outbound duty and the recovery pass’s own re-enqueues.',
  composeKnowledgeIndexing:
    'the knowledge runtime, which registers the Librarian’s `artifact.created` handler — PROGRESS backlog 36’s lost curation wake-up is enqueued from here.',
  composeOnboardingRecording:
    'the discovery recorder’s `artifact.created` handler and its job (WP-21).',
  composeHistoryBootstrap:
    'the bootstrap’s two workers and the `record` handler — PROGRESS backlog 106’s lost wake-up is enqueued from here.',
  createOnboardingCommands:
    'the wizard’s writes; a discovery start refuses by name without a queue.',
  createTaskCommands: 'the task and run command surface (WP-15i).',
  composeAsks: 'ask-the-task’s API half (WP-31).',
  createShadowCommands: 'the shadow batch command (WP-34).',
  createHistoryBootstrapCommands: 'the bootstrap start command (WP-35).',
  createKnowledgeCommands: 'the proposal decision, which asks for a commit (WP-18b).',
  createProjectConfigCommands:
    'a change of the default branch asks for a knowledge index of the new branch (WP-142).',
};

/** The segments of the object literal at `open`, or `null` when the call takes no literal. */
const objectArgument = (source: string, open: number): string[] | null => {
  const brace = source.indexOf('{', open);
  if (brace < 0) return null;
  // Only when the literal is the argument itself: anything but whitespace between them means the
  // call passes something else first (and the positional form is read separately below).
  if (source.slice(open + 1, brace).trim().length > 0) return null;
  return topLevel(braceBody(source, brace));
};

/** Every call in `source` that passes a `jobs` argument, as callee → the expression it passes. */
const jobsCallSites = (source: string): { callee: string; value: string }[] => {
  const sites: { callee: string; value: string }[] = [];
  for (const match of source.matchAll(/(\w+)\(/g)) {
    const callee = match[1] as string;
    const open = (match.index ?? 0) + match[0].length - 1;
    const positional = /^\(\s*(\w+(?:\.\w+)*)\s*,/.exec(source.slice(open));
    if (positional !== null && (positional[1] as string).endsWith('jobs')) {
      sites.push({ callee, value: positional[1] as string });
      continue;
    }
    const segments = objectArgument(source, open);
    if (segments === null) continue;
    for (const segment of segments) {
      const trimmed = segment.trim();
      const named = /^jobs\s*:\s*(.+)$/s.exec(trimmed);
      if (named !== null) {
        sites.push({ callee, value: (named[1] as string).trim() });
      } else if (trimmed === 'jobs') {
        sites.push({ callee, value: 'jobs' });
      }
    }
  }
  return sites;
};

describe('the jobs seam every composition shares', () => {
  const rootSource = read(ROOT);

  it('names the raw instance only where it is wrapped, and for the lifecycle it owns', () => {
    const raw = [...rootSource.matchAll(/jobsRuntime\.jobs/g)].length;
    // Exactly the two inside `options.pipeline?.jobs === undefined ? jobsRuntime.jobs : options.pipeline.jobs(jobsRuntime.jobs)`
    // — the branch that composes the real instance, and the argument the seam wraps.
    expect(raw).toBe(2);
    expect(
      /\?\s*jobsRuntime\.jobs\s*:\s*options\.pipeline\.jobs\(jobsRuntime\.jobs\)/.test(rootSource),
    ).toBe(true);
    // `start`/`stop` are the runtime's own and stay on it: the seam is about enqueues.
    expect(/jobsRuntime\.(start|stop)\(\)/.test(rootSource)).toBe(true);
  });

  it('hands the wrapped instance to every composition that takes one, and to no other', () => {
    const sites = jobsCallSites(rootSource);
    // Both directions: an unlisted composition fails, and a listed one that stopped taking a queue
    // fails too — the second is what keeps this table from outliving the code it describes.
    expect([...new Set(sites.map((site) => site.callee))].toSorted()).toEqual(
      Object.keys(WRAPPED_JOBS_CALL_SITES).toSorted(),
    );
    // …and each is handed the **wrapped** binding rather than the raw instance, which is the
    // defect itself: three of these took `jobsRuntime.jobs` for four work packages.
    expect(sites.filter((site) => site.value !== 'jobs')).toEqual([]);
  });

  it('is calibrated: the parse finds the call sites, and would see the defect it was written for', () => {
    // Without this, a parser that returned nothing would make the equality above a comparison of
    // two empty sets the moment somebody emptied the table too (standing rule 44).
    expect(jobsCallSites(rootSource).length).toBeGreaterThanOrEqual(
      Object.keys(WRAPPED_JOBS_CALL_SITES).length,
    );
    // The defect, spelled as it was: the same parse over a source that passes the raw instance
    // reports it, so the assertion above is a check rather than a tautology.
    expect(
      jobsCallSites('const x = composeKnowledgeIndexing({ pool, jobs: jobsRuntime.jobs });'),
    ).toEqual([{ callee: 'composeKnowledgeIndexing', value: 'jobsRuntime.jobs' }]);
  });

  it('builds the process’s only queue client in the one file that wraps it', () => {
    /**
     * The half a census of one file cannot see: a *fourth runtime* composed in a **new file** with
     * a queue client of its own would enqueue through something this seam never touched, and every
     * tier would stay green. Read off disk (tracked and untracked, rule 85), so a composition root
     * somebody has written and not committed is censused rather than skipped.
     */
    const builders = sourceFilesUnder('apps/server/src')
      .filter((path) => withoutComments(readSource(path)).includes('createPgBossJobs('))
      .toSorted();
    expect(builders).toEqual([ROOT]);
  });
});

/**
 * **The dead-letter sink is registered by this composition root** (WP-49).
 *
 * `EventBus.onDeadLetter` is optional, and standing rule 31 says an optional collaborator is one
 * production omits — which is backlog 104's lesson and the reason this file exists. It cannot be a
 * row of the census above, because it is not a `createPipelineRuntime` option: the bus is built by
 * `createEventing` before this function has a `PipelineStore`, so the wiring is a call rather than a
 * key. Without it a poisoned event still leaves the queue and **no task is ever escalated**, which
 * every other tier would call a pass.
 */
describe('the dead-letter sink (WP-49)', () => {
  const compositionSource = read(COMPOSITION);

  it('is registered on the bus this process dispatches with, exactly once', () => {
    expect(compositionSource.match(/\.onDeadLetter\(/g) ?? []).toHaveLength(1);
    expect(compositionSource).toMatch(/onDeadLetter\(\s*createDeadLetterEscalation\(/);
    // Calibration (standing rule 44): the same read finds the handler registrations it stands
    // beside, so a parse that returned nothing fails here instead of passing vacuously.
    expect((compositionSource.match(/eventing\.bus\.register\(/g) ?? []).length).toBeGreaterThan(2);
  });
});

/**
 * **Every other runtime's composition, censused the same way** (WP-96, the remainder of PROGRESS
 * backlog 104).
 *
 * The pipeline's census above was the instance; the class is every `create…Runtime` this process
 * composes. The knowledge-index, librarian, onboarding and history-bootstrap runtimes — and the ask
 * block the pipeline runtime takes as `ask:` — each take an options object with optional members,
 * and each is composed in its own file under `apps/server/src`, so an optional collaborator added
 * to any of them and wired only in a test harness is backlog 104 again. Each row names an options
 * interface, the file that declares it, and the object literal in the composition that fills it —
 * anchored inside the runtime's own call, because `record: {` and `apply: {` are not unique words.
 *
 * The same rules as above: optional members read off the interface (and every interface it
 * extends, which must itself be a row's or {@link RUNTIME_EXTENDS}' — both directions), passed keys
 * read off the literal, an equality against an admitted-omission list with the reason at the line,
 * and a calibration that the same parse finds every **required** member.
 *
 * **Every runtime, asserted rather than listed**: the set of `create…Runtime(` calls under
 * `apps/server/src` (tracked and untracked, rule 85) must equal the runtimes this table names plus
 * the pipeline's, so a sixth runtime composed in a new file fails here until it has rows.
 */
interface RuntimeOptionsRow {
  /** The options interface. */
  readonly name: string;
  /** Where it is declared. */
  readonly source: string;
  /** The composition file, the runtime call inside it, and the literal (inside that call) it fills. */
  readonly site: string;
  readonly call: string;
  readonly literal: string;
}

const RUNTIME_OPTION_ROWS: readonly RuntimeOptionsRow[] = [
  {
    name: 'HistoryBootstrapRuntimeOptions',
    source: 'packages/application/src/bootstrap/runtime.ts',
    site: 'apps/server/src/bootstrap.ts',
    call: 'createHistoryBootstrapRuntime({',
    literal: 'createHistoryBootstrapRuntime({',
  },
  {
    name: 'HistoryCollectOptions',
    source: 'packages/application/src/bootstrap/collect.ts',
    site: 'apps/server/src/bootstrap.ts',
    call: 'createHistoryBootstrapRuntime({',
    literal: 'collect: {',
  },
  {
    name: 'HistoryRecordOptions',
    source: 'packages/application/src/bootstrap/record.ts',
    site: 'apps/server/src/bootstrap.ts',
    call: 'createHistoryBootstrapRuntime({',
    literal: 'record: {',
  },
  {
    name: 'KnowledgeIndexRuntimeOptions',
    source: 'packages/application/src/knowledge/index-job.ts',
    site: 'apps/server/src/knowledge.ts',
    call: 'createKnowledgeIndexRuntime({',
    literal: 'createKnowledgeIndexRuntime({',
  },
  {
    name: 'LibrarianRuntimeOptions',
    source: 'packages/application/src/knowledge/runtime.ts',
    site: 'apps/server/src/knowledge.ts',
    call: 'createLibrarianRuntime({',
    literal: 'createLibrarianRuntime({',
  },
  {
    name: 'LibrarianJobOptions',
    source: 'packages/application/src/knowledge/librarian.ts',
    site: 'apps/server/src/knowledge.ts',
    call: 'createLibrarianRuntime({',
    literal: 'curation: {',
  },
  {
    name: 'KnowledgeApplyOptions',
    source: 'packages/application/src/knowledge/apply.ts',
    site: 'apps/server/src/knowledge.ts',
    call: 'createLibrarianRuntime({',
    literal: 'apply: {',
  },
  {
    name: 'KnowledgeHygieneOptions',
    source: 'packages/application/src/knowledge/hygiene.ts',
    site: 'apps/server/src/knowledge.ts',
    call: 'createLibrarianRuntime({',
    literal: 'hygiene: {',
  },
  {
    name: 'OnboardingRuntimeOptions',
    source: 'packages/application/src/onboarding/runtime.ts',
    site: 'apps/server/src/onboarding.ts',
    call: 'createOnboardingRuntime({',
    literal: 'createOnboardingRuntime({',
  },
  {
    name: 'DiscoveryRecordOptions',
    source: 'packages/application/src/onboarding/record.ts',
    site: 'apps/server/src/onboarding.ts',
    call: 'const record: DiscoveryRecordOptions = {',
    literal: 'const record: DiscoveryRecordOptions = {',
  },
  {
    name: 'ReadinessRecheckOptions',
    source: 'packages/application/src/onboarding/recheck.ts',
    site: 'apps/server/src/onboarding.ts',
    call: 'const recheck: ReadinessRecheckOptions = {',
    literal: 'const recheck: ReadinessRecheckOptions = {',
  },
  {
    name: 'AskRuntimeOptions',
    source: 'packages/application/src/ask/runtime.ts',
    site: COMPOSITION,
    call: 'createPipelineRuntime({',
    literal: 'ask: {',
  },
];

/** Interfaces a row's interface extends, and where each lives — held to the sources below. */
const RUNTIME_EXTENDS: Readonly<Record<string, string>> = {
  KnowledgeIndexJobOptions: 'packages/application/src/knowledge/index-job.ts',
};

/** The runtimes composed under `apps/server/src`, by the factory the table's rows are filled for. */
const CENSUSED_RUNTIMES = [
  'createHistoryBootstrapRuntime',
  'createKnowledgeIndexRuntime',
  'createLibrarianRuntime',
  'createOnboardingRuntime',
  'createPipelineRuntime',
];

/** Optional members these compositions deliberately do not pass, as `Interface.member` → why. */
const ADMITTED_RUNTIME_OMISSIONS: Readonly<Record<string, string>> = {
  'AskRuntimeOptions.concurrency':
    'how many asks one process answers at once, whose default (1 — "an ask is a minute") is the shipped behaviour: a number with a stated default, like reviewCommentWindowMs above, rather than a collaborator whose absence changes what the process can do.',
};

/** The literal `literal`, found at or after the runtime call `call`. */
const literalKeys = (row: RuntimeOptionsRow): Set<string> => {
  const source = read(row.site);
  const at = source.indexOf(row.call);
  if (at < 0) {
    throw new Error(`census: ${row.call} not found in ${row.site}`);
  }
  return passedKeys(source.slice(at), row.literal);
};

/** The row's interface and everything it extends, as `[name, source]` pairs. */
const interfaceChain = (name: string, source: string): [string, string][] => [
  [name, source],
  ...extendsOf(read(source), name).flatMap((base) => {
    const baseSource = RUNTIME_EXTENDS[base];
    if (baseSource === undefined) {
      throw new Error(`census: ${name} extends ${base}, which RUNTIME_EXTENDS does not name`);
    }
    return interfaceChain(base, baseSource);
  }),
];

const runtimeMembers = (row: RuntimeOptionsRow, optional: boolean): string[] =>
  interfaceChain(row.name, row.source).flatMap(([name, source]) =>
    members(interfaceBody(read(source), name), optional),
  );

describe('every runtime’s optional collaborators (WP-96, backlog 104)', () => {
  it('passes every optional member of every row, or admits the omission with a reason', () => {
    const omitted = RUNTIME_OPTION_ROWS.flatMap((row) =>
      missing(runtimeMembers(row, true), literalKeys(row)).map((key) => `${row.name}.${key}`),
    );
    expect(omitted.toSorted()).toEqual(Object.keys(ADMITTED_RUNTIME_OMISSIONS).toSorted());
  });

  it('is calibrated: the same parse finds every required member of every row', () => {
    for (const row of RUNTIME_OPTION_ROWS) {
      const required = runtimeMembers(row, false);
      expect(required.length, row.name).toBeGreaterThan(0);
      expect(missing(required, literalKeys(row)), row.name).toEqual([]);
    }
  });

  it('finds the optional members it was written for, so an empty parse cannot pass', () => {
    // The four runtimes backlog 104 named each took one optional `logger` when it was filed.
    const optional = new Set(
      RUNTIME_OPTION_ROWS.flatMap((row) =>
        runtimeMembers(row, true).map((key) => `${row.name}.${key}`),
      ),
    );
    expect(optional.has('HistoryBootstrapRuntimeOptions.logger')).toBe(true);
    expect(optional.has('AskRuntimeOptions.budgets')).toBe(true);
    expect(optional.size).toBeGreaterThan(5);
  });

  it('names every interface a row extends, and nothing no row extends', () => {
    const extended = RUNTIME_OPTION_ROWS.flatMap((row) =>
      interfaceChain(row.name, row.source)
        .slice(1)
        .map(([name]) => name),
    );
    expect([...new Set(extended)].toSorted()).toEqual(Object.keys(RUNTIME_EXTENDS).toSorted());
  });

  it('covers every runtime this process composes, read off disk', () => {
    const composed = new Set<string>();
    for (const path of sourceFilesUnder('apps/server/src')) {
      for (const [, factory] of withoutComments(readSource(path)).matchAll(
        /\b(create\w+Runtime)\s*\(/g,
      )) {
        composed.add(factory as string);
      }
    }
    // `createPipelineRuntime` is the census above's; the rest are this table's.
    expect([...composed].toSorted()).toEqual(CENSUSED_RUNTIMES.toSorted());
    expect(
      [...new Set(RUNTIME_OPTION_ROWS.map((row) => row.call.replace(/\(\{$/, '')))]
        .filter((call) => call.startsWith('create'))
        .toSorted(),
    ).toEqual(CENSUSED_RUNTIMES.toSorted());
  });
});
