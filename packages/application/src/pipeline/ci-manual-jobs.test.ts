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
    jobs: fc.array(jobArb, { maxLength: 8 }),
  });
  const policyArb: fc.Arbitrary<ManualJobPolicy> = fc.oneof(
    fc.constant(DEFAULT_MANUAL_JOB_POLICY),
    fc.constant<ManualJobPolicy>({ kind: 'none' }),
    fc.constant<ManualJobPolicy>({ kind: 'all' }),
    fc
      .subarray(['build', 'unit', 'e2e', 'lint', 'sentry-release-commit', 'deploy'])
      .map((names): ManualJobPolicy => ({ kind: 'named', names: new Set(names) })),
  );

  it('never passes a pipeline with a pending or running job, or a failure that is not allowed', () => {
    fc.assert(
      fc.property(pipelineArb, policyArb, (judgedPipeline, policy) => {
        if (judgeCiPipeline(judgedPipeline, policy).kind !== 'passed') return;
        expect(judgedPipeline.status === 'success' || judgedPipeline.status === 'manual').toBe(
          true,
        );
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
  });

  it('never passes, under the default, a pipeline with an unstarted blocking manual test job', () => {
    fc.assert(
      fc.property(pipelineArb, (judgedPipeline) => {
        if (judgeCiPipeline(judgedPipeline, DEFAULT_MANUAL_JOB_POLICY).kind !== 'passed') return;
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
  });

  it('passes a held pipeline only when a job succeeded and it shows what holds it', () => {
    fc.assert(
      fc.property(pipelineArb, policyArb, (judgedPipeline, policy) => {
        if (judgedPipeline.status !== 'manual') return;
        if (judgeCiPipeline(judgedPipeline, policy).kind !== 'passed') return;
        expect(judgedPipeline.jobs.some((each) => each.status === 'success')).toBe(true);
        expect(judgedPipeline.jobs.some(isBlockingManualJob)).toBe(true);
        expect(policy.kind).not.toBe('all');
      }),
      { numRuns: 2_000 },
    );
  });
});
