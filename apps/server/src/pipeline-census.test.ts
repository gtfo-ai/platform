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
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot, withoutComments } from './routes/web-sources.js';

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
 * The parse is deliberately blunt: **after the wrap, the raw instance is not named again**. It is a
 * text check like the rest of this file, so it cannot see an alias (`const raw = jobsRuntime.jobs`)
 * — which is why the calibration below demands that the wrapped identifier be passed several times,
 * so a file that stopped matching at all fails here rather than passing vacuously.
 */
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

  it('is calibrated: the wrapped instance is what the compositions are actually handed', () => {
    // Without this, deleting every `jobs` argument from the file would make the case above pass.
    // Thirteen `jobs,` sites today (counted off the file): the pipeline, the six command factories, the two crons and the three
    // worker runtimes — counted rather than listed, because the list is what went stale.
    const passedWrapped = [...rootSource.matchAll(/(?:^|[\s(,{])jobs,/g)].length;
    expect(passedWrapped).toBeGreaterThan(5);
  });
});
