/**
 * The CI gate's manual-job rule as a pure function (S-27.2, TD-036 decisions 2–4). The evaluator's
 * table over the same cases is in `gates.test.ts`; this file holds the rule's own branches and the
 * property the risk of the slice rests on: **the gate never passes** a pipeline with a job still
 * queued or running, a failure the provider does not allow, or — under the default rule — an
 * unstarted blocking manual job in stage `test`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import {
  DEFAULT_MANUAL_JOB_POLICY,
  isBlockingManualJob,
  judgeCiPipeline,
  type ManualJobPolicy,
  manualJobPolicyOf,
  manualJobsHolding,
} from './ci-manual-jobs.js';
import { defaultProjectSettings } from './settings.js';

type Job = PipelineStatus['jobs'][number];

const job = (
  name: string,
  status: Job['status'],
  stage: string | null,
  allowFailure = false,
): Job => ({ id: `id-${name}`, name, status, stage, log_ref: null, allow_failure: allowFailure });

const pipeline = (status: PipelineStatus['status'], jobs: readonly Job[]) => ({
  status,
  jobs: [...jobs],
});

/** AUT-6655's pipeline 3038234623: green build and tests, held at a release step. */
const AUT_6655 = pipeline('manual', [
  job('build_composer', 'success', 'build'),
  job('phpstan', 'success', 'test'),
  job('codeception', 'success', 'test'),
  job('sentry-release-commit', 'manual', 'release'),
]);

const NAMED = (...names: string[]): ManualJobPolicy => ({ kind: 'named', names: new Set(names) });

describe('manualJobPolicyOf — pipeline.ci.required_manual_jobs, read', () => {
  const of = (required: unknown) =>
    manualJobPolicyOf(
      defaultProjectSettings('p', {
        config: { pipeline: { ci: { required_manual_jobs: required as never } } },
      }),
    );

  it('reads absent as the default, [] as none, all as all, and a list as exactly those names', () => {
    expect(manualJobPolicyOf(defaultProjectSettings('p'))).toEqual(DEFAULT_MANUAL_JOB_POLICY);
    expect(of([])).toEqual({ kind: 'none' });
    expect(of('all')).toEqual({ kind: 'all' });
    expect(of(['e2e'])).toEqual({ kind: 'named', names: new Set(['e2e']) });
  });

  it('reads a value the schema would refuse as the default — never as [], which skips tests', () => {
    for (const hostile of ['none', 7, [1], { all: true }]) {
      expect(of(hostile), JSON.stringify(hostile)).toEqual(DEFAULT_MANUAL_JOB_POLICY);
    }
  });
});

describe('judgeCiPipeline — the default rule (TD-036 decision 2)', () => {
  it('passes AUT-6655’s shape and names the release step it left unstarted', () => {
    const judged = judgeCiPipeline(AUT_6655, DEFAULT_MANUAL_JOB_POLICY);
    expect(judged.kind).toBe('passed');
    expect(judged.kind === 'passed' && judged.notRun.map((each) => each.name)).toEqual([
      'sentry-release-commit',
    ]);
  });

  it('does not list an optional manual job (allow_failure) as not run: it held nothing', () => {
    const judged = judgeCiPipeline(
      pipeline('manual', [...AUT_6655.jobs, job('deploy-preview', 'manual', 'deploy', true)]),
      DEFAULT_MANUAL_JOB_POLICY,
    );
    expect(judged.kind === 'passed' && judged.notRun.map((each) => each.name)).toEqual([
      'sentry-release-commit',
    ]);
  });

  it.each([
    [
      'an unstarted blocking manual job in stage test',
      [job('build', 'success', 'build'), job('e2e', 'manual', 'test')],
      'manual_required',
    ],
    [
      'a job with no stage (a provider with none)',
      [job('build', 'success', null), job('release', 'manual', null)],
      'manual_required',
    ],
    [
      'a job queued behind the held one',
      [job('build_composer', 'manual', 'build'), job('phpstan', 'pending', 'test')],
      'in_flight',
    ],
    [
      'a still-running job',
      [job('phpstan', 'running', 'test'), job('sentry-release-commit', 'manual', 'release')],
      'in_flight',
    ],
    [
      'a pipeline in which no job succeeded',
      [job('sentry-release-commit', 'manual', 'release')],
      'nothing_ran',
    ],
    [
      'a held pipeline whose blocking manual job the read does not show',
      [job('phpstan', 'success', 'test'), job('deploy', 'manual', 'deploy', true)],
      'manual_unseen',
    ],
  ] as const)('waits on %s', (_case, jobs, cause) => {
    const judged = judgeCiPipeline(pipeline('manual', jobs), DEFAULT_MANUAL_JOB_POLICY);
    expect(judged).toMatchObject({ kind: 'waiting', cause });
  });

  it('counts every job as a test when the pipeline has no test stage', () => {
    const judged = judgeCiPipeline(
      pipeline('manual', [job('build', 'success', 'build'), job('verify', 'manual', 'verify')]),
      DEFAULT_MANUAL_JOB_POLICY,
    );
    expect(judged).toMatchObject({ kind: 'waiting', cause: 'manual_required' });
  });

  it('names the test job the wait is for before the release step it is also held at', () => {
    const judged = judgeCiPipeline(
      pipeline('manual', [
        job('phpstan', 'success', 'test'),
        job('sentry-release-commit', 'manual', 'release'),
        job('e2e', 'manual', 'test'),
      ]),
      DEFAULT_MANUAL_JOB_POLICY,
    );
    expect(judged.kind === 'waiting' && judged.heldAt.map((each) => each.name)).toEqual([
      'e2e',
      'sentry-release-commit',
    ]);
  });

  it.each([
    ['failed', job('lint', 'failed', 'test')],
    ['canceled', job('lint', 'canceled', 'test')],
  ] as const)('fails a held pipeline with a %s job that is not allowed to fail', (_status, bad) => {
    const judged = judgeCiPipeline(
      pipeline('manual', [...AUT_6655.jobs, bad]),
      DEFAULT_MANUAL_JOB_POLICY,
    );
    expect(judged).toMatchObject({ kind: 'failed', required: false });
    expect(judged.kind === 'failed' && judged.failing.map((each) => each.name)).toEqual(['lint']);
  });

  it('passes a held pipeline whose only failure is allowed', () => {
    const judged = judgeCiPipeline(
      pipeline('manual', [...AUT_6655.jobs, job('flaky', 'failed', 'test', true)]),
      DEFAULT_MANUAL_JOB_POLICY,
    );
    expect(judged.kind).toBe('passed');
  });

  it('keeps the other statuses as before: running waits, failed fails, success passes', () => {
    expect(judgeCiPipeline(pipeline('running', []), DEFAULT_MANUAL_JOB_POLICY).kind).toBe(
      'waiting',
    );
    expect(judgeCiPipeline(pipeline('pending', []), DEFAULT_MANUAL_JOB_POLICY).kind).toBe(
      'waiting',
    );
    for (const status of ['failed', 'canceled', 'skipped'] as const) {
      expect(judgeCiPipeline(pipeline(status, []), DEFAULT_MANUAL_JOB_POLICY).kind).toBe('failed');
    }
    expect(
      judgeCiPipeline(
        pipeline('success', [job('unit', 'success', 'test')]),
        DEFAULT_MANUAL_JOB_POLICY,
      ),
    ).toEqual({ kind: 'passed', notRun: [] });
  });
});

describe('judgeCiPipeline — the project’s rule (TD-036 decision 3)', () => {
  const heldTest = pipeline('manual', [
    job('build', 'success', 'build'),
    job('e2e', 'manual', 'test'),
  ]);

  it('absent gives the default', () => {
    expect(judgeCiPipeline(AUT_6655, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('passed');
    expect(judgeCiPipeline(heldTest, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('waiting');
  });

  it('[] passes a held test job, and still waits on a queued job or fails on a disallowed failure', () => {
    const none: ManualJobPolicy = { kind: 'none' };
    expect(judgeCiPipeline(heldTest, none)).toMatchObject({ kind: 'passed' });
    expect(
      judgeCiPipeline(
        pipeline('manual', [job('build', 'manual', 'build'), job('unit', 'pending', 'test')]),
        none,
      ).kind,
    ).toBe('waiting');
    expect(
      judgeCiPipeline(pipeline('manual', [...heldTest.jobs, job('lint', 'failed', 'test')]), none)
        .kind,
    ).toBe('failed');
  });

  it('all reproduces the wait from before TD-036: every held pipeline waits', () => {
    expect(judgeCiPipeline(AUT_6655, { kind: 'all' })).toMatchObject({
      kind: 'waiting',
      cause: 'manual_required',
    });
  });

  it('a named job waits even on a success pipeline, and whatever its stage or allow_failure', () => {
    const green = pipeline('success', [
      job('unit', 'success', 'test'),
      job('smoke', 'manual', 'deploy', true),
    ]);
    expect(judgeCiPipeline(green, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('passed');
    expect(judgeCiPipeline(green, NAMED('smoke'))).toMatchObject({
      kind: 'waiting',
      cause: 'manual_required',
    });
    expect(judgeCiPipeline(AUT_6655, NAMED('sentry-release-commit')).kind).toBe('waiting');
  });

  it('a named job that ran and failed fails the gate, on a success pipeline too', () => {
    const judged = judgeCiPipeline(
      pipeline('success', [job('unit', 'success', 'test'), job('smoke', 'failed', 'deploy', true)]),
      NAMED('smoke'),
    );
    expect(judged).toMatchObject({ kind: 'failed', required: true });
    expect(judged.kind === 'failed' && judged.failing.map((each) => each.name)).toEqual(['smoke']);
  });

  it('a name the pipeline does not contain is not waited for, and the unnamed held test job passes', () => {
    expect(judgeCiPipeline(AUT_6655, NAMED('e2e')).kind).toBe('passed');
    expect(judgeCiPipeline(heldTest, NAMED('smoke')).kind).toBe('passed');
  });
});

describe('what the rule cannot see, and what never runs (BACKLOG 1490, 1493)', () => {
  it('never passes a held pipeline on a job list the provider cut, and waits as before', () => {
    const cut = { ...AUT_6655, jobs_truncated: true };
    expect(judgeCiPipeline(AUT_6655, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('passed');
    for (const policy of [DEFAULT_MANUAL_JOB_POLICY, { kind: 'none' } as const, NAMED('e2e')]) {
      expect(judgeCiPipeline(cut, policy), policy.kind).toMatchObject({
        kind: 'waiting',
        cause: 'jobs_unseen',
      });
    }
    // `mr_pipeline` reads the same hold: a cut list may hide a manual test job.
    expect(manualJobsHolding(cut, DEFAULT_MANUAL_JOB_POLICY).holds).toBe(true);
  });

  it('waits on a cut list of a green pipeline only when it is asked for names', () => {
    const green = {
      ...pipeline('success', [job('unit', 'success', 'test')]),
      jobs_truncated: true,
    };
    expect(judgeCiPipeline(green, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('passed');
    expect(judgeCiPipeline(green, NAMED('smoke'))).toMatchObject({
      kind: 'waiting',
      cause: 'jobs_unseen',
    });
  });

  it('fails a required manual job the pipeline’s rules skipped: it never runs', () => {
    const judged = judgeCiPipeline(
      pipeline('success', [job('unit', 'success', 'test'), job('smoke', 'skipped', 'deploy')]),
      NAMED('smoke'),
    );
    expect(judged).toMatchObject({ kind: 'failed', required: true });
    expect(judged.kind === 'failed' && judged.skipped.map((each) => each.name)).toEqual(['smoke']);
    // A skipped job nobody named is not the project's requirement: it passes as before.
    expect(
      judgeCiPipeline(
        pipeline('success', [job('unit', 'success', 'test'), job('smoke', 'skipped', 'deploy')]),
        DEFAULT_MANUAL_JOB_POLICY,
      ).kind,
    ).toBe('passed');
  });
});

/**
 * The coordinator's ruling on #114: a pipeline whose own status is `success` keeps the behaviour
 * before TD-036. GitLab lists `created` jobs on a green pipeline (a job that `needs:` an optional
 * manual job); waiting on them would hold the task until its CI timeout.
 */
describe('a success pipeline keeps the behaviour before TD-036', () => {
  const green = pipeline('success', [
    job('unit', 'success', 'test'),
    { ...job('preview', 'manual', 'deploy', true) },
    job('preview-smoke', 'pending', 'deploy'),
    job('flaky', 'failed', 'test'),
  ]);

  it('passes a green pipeline that lists a created job, under every policy without names', () => {
    for (const policy of [
      DEFAULT_MANUAL_JOB_POLICY,
      { kind: 'none' } as const,
      { kind: 'all' } as const,
    ]) {
      expect(judgeCiPipeline(green, policy).kind, policy.kind).toBe('passed');
    }
  });

  it('asks it only the named jobs, and only when names are configured', () => {
    expect(judgeCiPipeline(green, NAMED('e2e')).kind, 'a name it does not contain').toBe('passed');
    expect(judgeCiPipeline(green, NAMED('preview')), 'a named job still manual').toMatchObject({
      kind: 'waiting',
      cause: 'manual_required',
    });
    expect(judgeCiPipeline(green, NAMED('flaky')), 'a named job that failed').toMatchObject({
      kind: 'failed',
      required: true,
    });
  });
});

describe('manualJobsHolding — the question mr_pipeline shares (TD-036 decision 4)', () => {
  it('does not hold for a release step, holds for a test job, also inside a running pipeline', () => {
    expect(manualJobsHolding(AUT_6655, DEFAULT_MANUAL_JOB_POLICY).holds).toBe(false);
    expect(
      manualJobsHolding(
        pipeline('running', [job('unit', 'running', 'test'), job('e2e', 'manual', 'test')]),
        DEFAULT_MANUAL_JOB_POLICY,
      ).holds,
    ).toBe(true);
    expect(manualJobsHolding(pipeline('manual', []), DEFAULT_MANUAL_JOB_POLICY).holds).toBe(true);
    expect(manualJobsHolding(pipeline('manual', []), { kind: 'none' }).holds).toBe(false);
  });
});

/**
 * **The property** (S-27.2 criterion 1): over arbitrary pipelines — every status, every job status,
 * stages in and out of `test` and `null`, either `allow_failure` — and every policy, a pass never
 * coexists with a job still queued or running, a failure the provider does not allow, or (under the
 * default) an unstarted blocking manual test job.
 */
describe('the gate never passes what it must not', () => {
  const jobArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    name: fc.constantFrom('build', 'unit', 'e2e', 'lint', 'sentry-release-commit', 'deploy'),
    status: fc.constantFrom(
      'success',
      'failed',
      'canceled',
      'skipped',
      'pending',
      'running',
      'manual',
    ) as fc.Arbitrary<Job['status']>,
    stage: fc.constantFrom<string | null>('build', 'test', 'release', 'deploy', null),
    log_ref: fc.constant(null),
    allow_failure: fc.boolean(),
  });
  const randomPipelineArb = fc.record({
    status: fc.constantFrom(
      'success',
      'failed',
      'canceled',
      'skipped',
      'pending',
      'running',
      'manual',
    ) as fc.Arbitrary<PipelineStatus['status']>,
    jobs: fc.array(jobArb, { maxLength: 8 }),
    jobs_truncated: fc.boolean(),
  });
  /**
   * AUT-6655's shape with arbitrary extra jobs — a test job that ran green and a blocking manual
   * release step — so the generator reaches the passing held pipelines the properties are about
   * (counted below), not only the random ones that almost never pass.
   */
  const heldReleaseArb = fc
    .record({
      extra: fc.array(jobArb, { maxLength: 3 }),
      jobs_truncated: fc.boolean(),
    })
    .map(({ extra, jobs_truncated }) => ({
      status: 'manual' as PipelineStatus['status'],
      jobs: [
        job('unit', 'success', 'test'),
        job('sentry-release-commit', 'manual', 'release'),
        ...extra,
      ],
      jobs_truncated,
    }));
  const pipelineArb = fc.oneof(randomPipelineArb, heldReleaseArb);
  const policyArb: fc.Arbitrary<ManualJobPolicy> = fc.oneof(
    fc.constant(DEFAULT_MANUAL_JOB_POLICY),
    fc.constant<ManualJobPolicy>({ kind: 'none' }),
    fc.constant<ManualJobPolicy>({ kind: 'all' }),
    fc
      .subarray(['build', 'unit', 'e2e', 'lint', 'sentry-release-commit', 'deploy'])
      .map((names): ManualJobPolicy => ({ kind: 'named', names: new Set(names) })),
  );

  /**
   * Over **held** pipelines: a `success` pipeline keeps the behaviour before TD-036 (the
   * coordinator's ruling on #114), so its listed jobs are not judged by (a) or (b). The count holds
   * the generator to the case: a property whose passing branch never ran asserts nothing.
   */
  it('never passes a held pipeline with a pending or running job, or a failure that is not allowed', () => {
    let heldPasses = 0;
    fc.assert(
      fc.property(pipelineArb, policyArb, (judgedPipeline, policy) => {
        const verdict = judgeCiPipeline(judgedPipeline, policy).kind;
        if (verdict !== 'passed') return;
        expect(judgedPipeline.status === 'success' || judgedPipeline.status === 'manual').toBe(
          true,
        );
        if (judgedPipeline.status !== 'manual') return;
        heldPasses += 1;
        expect(
          judgedPipeline.jobs.some(
            (each) => each.status === 'pending' || each.status === 'running',
          ),
        ).toBe(false);
        expect(
          judgedPipeline.jobs.some(
            (each) =>
              (each.status === 'failed' || each.status === 'canceled') && !each.allow_failure,
          ),
        ).toBe(false);
      }),
      { numRuns: 2_000 },
    );
    expect(heldPasses, 'the generator produced passing held pipelines').toBeGreaterThan(0);
  });

  it('never passes, under the default, a held pipeline with an unstarted blocking manual test job', () => {
    let heldPasses = 0;
    fc.assert(
      fc.property(pipelineArb, (judgedPipeline) => {
        if (judgedPipeline.status !== 'manual') return;
        if (judgeCiPipeline(judgedPipeline, DEFAULT_MANUAL_JOB_POLICY).kind !== 'passed') return;
        heldPasses += 1;
        const anyTestStage = judgedPipeline.jobs.some((each) => each.stage === 'test');
        const heldTest = judgedPipeline.jobs.some(
          (each) =>
            isBlockingManualJob(each) &&
            (each.stage === 'test' || each.stage === null || !anyTestStage),
        );
        expect(heldTest).toBe(false);
      }),
      { numRuns: 2_000 },
    );
    expect(heldPasses, 'the generator produced passing held pipelines').toBeGreaterThan(0);
  });

  it('never passes a held pipeline on a job list the provider cut (BACKLOG 1490)', () => {
    fc.assert(
      fc.property(pipelineArb, policyArb, (judgedPipeline, policy) => {
        if (judgedPipeline.status !== 'manual' || !judgedPipeline.jobs_truncated) return;
        expect(judgeCiPipeline(judgedPipeline, policy).kind).not.toBe('passed');
      }),
      { numRuns: 2_000 },
    );
  });

  it('passes a held pipeline only when a job succeeded and it shows what holds it', () => {
    let heldPasses = 0;
    fc.assert(
      fc.property(pipelineArb, policyArb, (judgedPipeline, policy) => {
        if (judgedPipeline.status !== 'manual') return;
        if (judgeCiPipeline(judgedPipeline, policy).kind !== 'passed') return;
        heldPasses += 1;
        expect(judgedPipeline.jobs.some((each) => each.status === 'success')).toBe(true);
        expect(judgedPipeline.jobs.some(isBlockingManualJob)).toBe(true);
        expect(policy.kind).not.toBe('all');
      }),
      { numRuns: 2_000 },
    );
    expect(heldPasses, 'the generator produced passing held pipelines').toBeGreaterThan(0);
  });
});

/**
 * S-28.7 (the M28 ruling): `pipeline.ci.manual_jobs` — `run` (the platform starts it and it is a
 * required check), `wait` (a person starts it; `required_manual_jobs`' meaning) and `ignore` (never
 * started, never a check). Autix's shape: `build_composer` held first; the test jobs `needs:` it and
 * are `manual` only once it has succeeded; `nette-tester` is optional; a deploy trigger is manual.
 */
describe('manual_jobs — run, wait and ignore (S-28.7)', () => {
  const MODES = (
    modes: Record<string, 'run' | 'wait' | 'ignore'>,
    base: ManualJobPolicy = DEFAULT_MANUAL_JOB_POLICY,
  ): ManualJobPolicy => ({ ...base, modes: new Map(Object.entries(modes)) });
  const AUTIX = MODES({ build_composer: 'run', codeception: 'run', 'crawler-test': 'wait' });

  /** Wave 1: `build_composer` held; the jobs that `needs:` it are `created` (the port's `pending`). */
  const WAVE_1 = pipeline('manual', [
    job('phpstan', 'success', 'test'),
    job('build_composer', 'manual', 'build-deps'),
    job('codeception', 'pending', 'test'),
    job('crawler-test', 'pending', 'test'),
    job('nette-tester', 'manual', 'test_optional', true),
  ]);
  /** Wave 2: `build_composer` succeeded; the test jobs are `manual` now. */
  const WAVE_2 = pipeline('manual', [
    job('phpstan', 'success', 'test'),
    job('build_composer', 'success', 'build-deps'),
    job('codeception', 'manual', 'test'),
    job('crawler-test', 'manual', 'test'),
    job('nette-tester', 'manual', 'test_optional', true),
  ]);

  it('reads manual_jobs beside required_manual_jobs, and leaves an old policy unchanged', () => {
    const of = (ci: Record<string, unknown>) =>
      manualJobPolicyOf(defaultProjectSettings('p', { config: { pipeline: { ci: ci as never } } }));
    expect(of({ manual_jobs: { codeception: 'run' } })).toEqual({
      kind: 'default',
      modes: new Map([['codeception', 'run']]),
    });
    expect(of({ required_manual_jobs: ['e2e'], manual_jobs: { deploy: 'ignore' } })).toEqual({
      kind: 'named',
      names: new Set(['e2e']),
      modes: new Map([['deploy', 'ignore']]),
    });
    // No `modes` key at all without the key: an old configuration reads exactly as before.
    expect(of({ required_manual_jobs: ['e2e'] })).toEqual({
      kind: 'named',
      names: new Set(['e2e']),
    });
    // A word the schema would refuse is skipped, never read as run.
    expect(of({ manual_jobs: { codeception: 'start' } })).toEqual(DEFAULT_MANUAL_JOB_POLICY);
  });

  it('wave 1: starts build_composer, and waits — never on nette-tester, which is not chosen', () => {
    const judged = judgeCiPipeline(WAVE_1, AUTIX);
    expect(judged).toMatchObject({ kind: 'waiting', cause: 'in_flight' });
    expect(judged.kind === 'waiting' && judged.toStart.map((each) => each.name)).toEqual([
      'build_composer',
    ]);
  });

  it('wave 2: starts codeception, waits on a person for crawler-test, and never starts the rest', () => {
    const judged = judgeCiPipeline(WAVE_2, AUTIX);
    expect(judged).toMatchObject({ kind: 'waiting', cause: 'manual_required' });
    if (judged.kind !== 'waiting') return;
    expect(judged.toStart.map((each) => each.name)).toEqual(['codeception']);
    expect(judged.heldAt.map((each) => each.name)).toEqual(['codeception', 'crawler-test']);
    // `mr_pipeline`'s question: held for a person (crawler-test), so a fresh pipeline is asked —
    expect(manualJobsHolding(WAVE_2, AUTIX).heldForPerson).toBe(true);
    // — but never because of a job the platform starts itself.
    const onlyRun = MODES({ build_composer: 'run', codeception: 'run', 'crawler-test': 'run' });
    expect(manualJobsHolding(WAVE_2, onlyRun)).toMatchObject({ holds: true, heldForPerson: false });
  });

  it('an already-started run job is not started again: the pipeline is running and waits', () => {
    const started = pipeline('running', [
      job('build_composer', 'success', 'build-deps'),
      job('codeception', 'running', 'test'),
      job('crawler-test', 'manual', 'test'),
    ]);
    const judged = judgeCiPipeline(started, AUTIX);
    expect(judged).toMatchObject({ kind: 'waiting', cause: 'in_flight' });
    expect(judged.kind === 'waiting' && judged.toStart).toEqual([]);
  });

  it('a played run job that failed fails the gate even with allow_failure, on a green pipeline too', () => {
    const red = pipeline('success', [
      job('build_composer', 'success', 'build-deps'),
      job('codeception', 'failed', 'test', true),
    ]);
    const judged = judgeCiPipeline(red, MODES({ codeception: 'run' }));
    expect(judged).toMatchObject({ kind: 'failed', required: true });
    expect(judged.kind === 'failed' && judged.failing.map((each) => each.name)).toEqual([
      'codeception',
    ]);
    // Without the choice the same pipeline passes: an allowed failure is not the gate's.
    expect(judgeCiPipeline(red, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('passed');
  });

  it('passes once every run and wait job has run green', () => {
    const done = pipeline('success', [
      job('build_composer', 'success', 'build-deps'),
      job('codeception', 'success', 'test'),
      job('crawler-test', 'success', 'test'),
      job('nette-tester', 'manual', 'test_optional', true),
    ]);
    expect(judgeCiPipeline(done, AUTIX).kind).toBe('passed');
  });

  it('ignore: a blocking manual test job is not waited for, and its failure is not the gate’s', () => {
    const held = pipeline('manual', [job('unit', 'success', 'test'), job('e2e', 'manual', 'test')]);
    expect(judgeCiPipeline(held, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('waiting');
    const ignored = judgeCiPipeline(held, MODES({ e2e: 'ignore' }));
    expect(ignored.kind).toBe('passed');
    // Still named as not run: the provider may still show the pipeline blocked at it.
    expect(ignored.kind === 'passed' && ignored.notRun.map((each) => each.name)).toEqual(['e2e']);
    expect(judgeCiPipeline(held, MODES({ e2e: 'ignore' }, { kind: 'all' })).kind).toBe('passed');
    const failedIgnored = pipeline('manual', [
      job('unit', 'success', 'test'),
      job('deploy', 'failed', 'deploy'),
      job('release', 'manual', 'release'),
    ]);
    expect(judgeCiPipeline(failedIgnored, DEFAULT_MANUAL_JOB_POLICY).kind).toBe('failed');
    expect(judgeCiPipeline(failedIgnored, MODES({ deploy: 'ignore' })).kind).toBe('passed');
  });

  it('never starts a trigger job: run reads as wait for one', () => {
    const held = pipeline('manual', [
      job('unit', 'success', 'test'),
      { ...job('deploy:tenants:hetzner', 'manual', 'test'), trigger: true },
    ]);
    const judged = judgeCiPipeline(held, MODES({ 'deploy:tenants:hetzner': 'run' }));
    expect(judged).toMatchObject({ kind: 'waiting', cause: 'manual_required' });
    expect(judged.kind === 'waiting' && judged.toStart).toEqual([]);
    expect(manualJobsHolding(held, MODES({ 'deploy:tenants:hetzner': 'run' })).heldForPerson).toBe(
      true,
    );
  });

  it('wait on a success pipeline is a named job, like required_manual_jobs', () => {
    const green = pipeline('success', [
      job('unit', 'success', 'test'),
      job('smoke', 'manual', 'deploy', true),
    ]);
    expect(judgeCiPipeline(green, MODES({ smoke: 'wait' }))).toMatchObject({
      kind: 'waiting',
      cause: 'manual_required',
      toStart: [],
    });
    expect(judgeCiPipeline(green, MODES({ smoke: 'run' }))).toMatchObject({
      kind: 'waiting',
      toStart: [expect.objectContaining({ name: 'smoke' })],
    });
  });
});

/**
 * **An old configuration behaves exactly as before S-28.7** (the M28 ruling): the rule as it stood
 * at S-27.2, kept here verbatim as the oracle, against the rule now — over every random pipeline and
 * every policy with no `manual_jobs`. And nothing is ever offered to start without a `run` mode.
 */
describe('a configuration without manual_jobs is judged as before S-28.7', () => {
  const blockingManual = (each: Job): boolean => each.status === 'manual' && !each.allow_failure;
  const legacyHold = (
    judged: typeof AUT_6655 & { jobs_truncated?: boolean },
    policy: ManualJobPolicy,
  ) => {
    const unseen =
      judged.status === 'manual' &&
      (judged.jobs_truncated === true || !judged.jobs.some(blockingManual));
    switch (policy.kind) {
      case 'none':
        return { holds: false, jobs: [] as Job[], unseen };
      case 'all': {
        const jobs = judged.jobs.filter(blockingManual);
        return { holds: jobs.length > 0 || unseen, jobs, unseen };
      }
      case 'named': {
        const jobs = judged.jobs.filter(
          (each) => each.status === 'manual' && policy.names.has(each.name),
        );
        return { holds: jobs.length > 0 || unseen, jobs, unseen };
      }
      default: {
        const hasTest = judged.jobs.some((each) => each.stage === 'test');
        const counted = (each: Job) => !hasTest || each.stage === 'test' || each.stage === null;
        const jobs = judged.jobs.filter((each) => blockingManual(each) && counted(each));
        return { holds: jobs.length > 0 || unseen, jobs, unseen };
      }
    }
  };
  const jobArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    name: fc.constantFrom('build', 'unit', 'e2e', 'sentry-release-commit'),
    status: fc.constantFrom(
      'success',
      'failed',
      'canceled',
      'skipped',
      'pending',
      'running',
      'manual',
    ) as fc.Arbitrary<Job['status']>,
    stage: fc.constantFrom<string | null>('build', 'test', 'release', null),
    log_ref: fc.constant(null),
    allow_failure: fc.boolean(),
  });
  const pipelineArb = fc.record({
    status: fc.constantFrom(
      'success',
      'failed',
      'canceled',
      'skipped',
      'pending',
      'running',
      'manual',
    ) as fc.Arbitrary<PipelineStatus['status']>,
    jobs: fc.array(jobArb, { maxLength: 6 }),
    jobs_truncated: fc.boolean(),
  });
  const policyArb: fc.Arbitrary<ManualJobPolicy> = fc.oneof(
    fc.constant(DEFAULT_MANUAL_JOB_POLICY),
    fc.constant<ManualJobPolicy>({ kind: 'none' }),
    fc.constant<ManualJobPolicy>({ kind: 'all' }),
    fc
      .subarray(['build', 'unit', 'e2e', 'sentry-release-commit'])
      .map((names): ManualJobPolicy => ({ kind: 'named', names: new Set(names) })),
  );

  it('holds exactly where the S-27.2 rule held, for the same jobs, and only for a person', () => {
    fc.assert(
      fc.property(pipelineArb, policyArb, (judged, policy) => {
        const now = manualJobsHolding(judged, policy);
        const before = legacyHold(judged, policy);
        expect(now.holds).toBe(before.holds);
        expect(now.jobs).toEqual(before.jobs);
        expect(now.unseen).toBe(before.unseen);
        expect(now.heldForPerson).toBe(now.holds);
      }),
    );
  });

  it('offers nothing to start, and a mode for a job the pipeline lacks changes no verdict', () => {
    fc.assert(
      fc.property(pipelineArb, policyArb, (judged, policy) => {
        const verdict = judgeCiPipeline(judged, policy);
        if (verdict.kind === 'waiting') expect(verdict.toStart).toEqual([]);
        const absent = { ...policy, modes: new Map([['not-in-any-pipeline', 'run' as const]]) };
        const withAbsent = judgeCiPipeline(judged, absent);
        // A run/wait name makes a green pipeline asked about names, so only compare when the base
        // policy already asks, or when the pipeline is not green.
        if (policy.kind === 'named' || judged.status !== 'success') {
          expect(withAbsent).toEqual(verdict);
        }
      }),
    );
  });
});
