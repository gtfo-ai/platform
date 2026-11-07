/**
 * Backlog 1078: the pure half of the CI gate's recorded pending read — what a read keeps of the
 * provider's text, and when a retry is one nobody acted on. The job's use of it is driven
 * through the saga harness (`saga.test.ts` › "the recorded pending read (backlog 1078)"), the
 * store's write by the pipeline-store contract suite and the projection by `apps/server`'s
 * `pipeline-queries.test.ts`.
 */
import { MAX_GATE_WAIT_HELD_JOB_CHARS } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import {
  type CiPendingRead,
  type CiPipelineRead,
  ciPendingReadSchema,
  ciPipelineReadOf,
  heldManualJob,
  heldRetryBrief,
  heldRetryReason,
  isUnchangedHeldRetry,
  MAX_CI_READ_ID_CHARS,
  MAX_CI_READ_URL_CHARS,
  safeProviderUrl,
  toGateWait,
} from './ci-pending-read.js';
import { pendingPipelineDetail } from './gates.js';

const HEAD = '1'.repeat(40);
const SECRET = 'FAKE-project-access-token-DO-NOT-USE';
/** The binding redactor's shape, reduced to the one planted secret. */
const redact = (text: string): string => text.split(SECRET).join('[REDACTED:integration:gitlab]');
const identity = (text: string): string => text;

const job = (
  over: Partial<PipelineStatus['jobs'][number]> = {},
): PipelineStatus['jobs'][number] => ({
  id: '9003',
  name: 'sentry-release-commit',
  status: 'manual',
  stage: 'release',
  log_ref: '9003',
  allow_failure: false,
  web_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
  ...over,
});

const status = (over: Partial<PipelineStatus> = {}): PipelineStatus => ({
  id: '3038234623',
  head_sha: HEAD,
  status: 'manual',
  url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
  jobs: [job({ id: '9001', name: 'lint', status: 'success', web_url: null }), job()],
  coverage_pct: null,
  finished_at: null,
  ...over,
});

const read = (over: Partial<CiPipelineRead> = {}): CiPipelineRead => ({
  pipeline_id: '3038234623',
  pipeline_url: null,
  head_sha: HEAD,
  status: 'manual',
  held_job: 'sentry-release-commit',
  held_job_url: null,
  draft: true,
  ...over,
});

const stored = (over: Partial<CiPipelineRead> = {}): CiPendingRead => ({
  ...read(over),
  checked_at: '2026-11-06T20:27:30.000Z',
  timeout_minutes: 60,
});

describe('ciPipelineReadOf', () => {
  it('records the held pipeline AUT-6655 waited on, with both pages', () => {
    const recorded = ciPipelineReadOf(status(), { headSha: HEAD, draft: true, redact: identity });
    expect(recorded).toEqual({
      pipeline_id: '3038234623',
      pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
      head_sha: HEAD,
      status: 'manual',
      held_job: 'sentry-release-commit',
      held_job_url: 'https://gitlab.example.test/acme/api/-/jobs/9003',
      draft: true,
    });
    // What the job stores parses with the column's schema.
    expect(
      ciPendingReadSchema.safeParse({
        ...recorded,
        checked_at: '2026-11-06T19:58:00.000Z',
        timeout_minutes: null,
      }).success,
    ).toBe(true);
  });

  it('names no held job for a pipeline that is not itself manual, as the pending detail does', () => {
    const running = status({ status: 'running' });
    expect(heldManualJob(running)).toBeUndefined();
    expect(
      ciPipelineReadOf(running, { headSha: HEAD, draft: false, redact: identity }),
    ).toMatchObject({ status: 'running', held_job: null, held_job_url: null, draft: false });
    expect(pendingPipelineDetail(running, false, identity)).toBe('pipeline 3038234623 is running');
    // A manual pipeline with no manual job named: held, at no job the read can name.
    const unnamed = status({ jobs: [] });
    expect(
      ciPipelineReadOf(unnamed, { headSha: HEAD, draft: false, redact: identity }),
    ).toMatchObject({ status: 'manual', held_job: null, held_job_url: null });
  });

  it('picks the same held job the pending detail names', () => {
    const two = status({ jobs: [job({ name: 'first-manual' }), job({ name: 'second-manual' })] });
    expect(heldManualJob(two)?.name).toBe('first-manual');
    expect(pendingPipelineDetail(two, false, identity)).toContain('"first-manual"');
    expect(ciPipelineReadOf(two, { headSha: HEAD, draft: false, redact: identity })?.held_job).toBe(
      'first-manual',
    );
  });

  it('redacts the held job’s name and then bounds it', () => {
    const long = `deploy-${SECRET}-${'x'.repeat(200)}`;
    const recorded = ciPipelineReadOf(status({ jobs: [job({ name: long })] }), {
      headSha: HEAD,
      draft: false,
      redact,
    });
    expect(recorded?.held_job).not.toContain(SECRET);
    expect(recorded?.held_job?.startsWith('deploy-[REDACTED:integration:gitlab]-')).toBe(true);
    expect(recorded?.held_job).toHaveLength(MAX_GATE_WAIT_HELD_JOB_CHARS);
    const exact = 'j'.repeat(MAX_GATE_WAIT_HELD_JOB_CHARS);
    expect(
      ciPipelineReadOf(status({ jobs: [job({ name: exact })] }), {
        headSha: HEAD,
        draft: false,
        redact,
      })?.held_job,
    ).toBe(exact);
  });

  it('records no read for an id it would have to cut or redact — an identity is never rewritten', () => {
    const facts = { headSha: HEAD, draft: false, redact };
    expect(
      ciPipelineReadOf(status({ id: 'p'.repeat(MAX_CI_READ_ID_CHARS) }), facts),
    ).not.toBeNull();
    expect(
      ciPipelineReadOf(status({ id: 'p'.repeat(MAX_CI_READ_ID_CHARS + 1) }), facts),
    ).toBeNull();
    expect(ciPipelineReadOf(status({ id: `p-${SECRET}` }), facts)).toBeNull();
  });
});

describe('safeProviderUrl', () => {
  it('keeps an http(s) URL as the provider sent it', () => {
    for (const url of ['https://gitlab.example.test/a/-/jobs/1', 'http://gitlab.example.test/x']) {
      expect(safeProviderUrl(url, identity), url).toBe(url);
    }
  });

  it('drops every other scheme, credentials, a redacted URL, an overlong one and nothing', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://gitlab.example.test/x',
      'https://user:pass@gitlab.example.test/x',
      'https://oauth2@gitlab.example.test/x',
      `https://gitlab.example.test/x?token=${SECRET}`,
      `https://gitlab.example.test/${'a'.repeat(MAX_CI_READ_URL_CHARS)}`,
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(safeProviderUrl(url, redact), String(url)).toBeNull();
    }
  });

  it('applies to the pipeline and the held job alike', () => {
    const recorded = ciPipelineReadOf(
      status({ url: 'javascript:alert(1)', jobs: [job({ web_url: 'data:text/html,x' })] }),
      { headSha: HEAD, draft: false, redact },
    );
    expect(recorded).toMatchObject({
      pipeline_url: null,
      held_job_url: null,
      held_job: 'sentry-release-commit',
    });
  });
});

describe('isUnchangedHeldRetry (backlog 1078 criterion 3)', () => {
  it('is a retry nobody acted on: same pipeline, same head, manual both times', () => {
    expect(isUnchangedHeldRetry(stored(), read())).toBe(true);
  });

  it('waits as normal on anything else', () => {
    const cases: readonly [string, CiPendingRead | null, CiPipelineRead][] = [
      ['no previous read', null, read()],
      ['the person started the job', stored(), read({ status: 'running', held_job: null })],
      ['it is pending now', stored(), read({ status: 'pending', held_job: null })],
      ['the previous read was running', stored({ status: 'running' }), read()],
      ['a new pipeline', stored(), read({ pipeline_id: '3038234624' })],
      ['a new head', stored(), read({ head_sha: '2'.repeat(40) })],
      // Review of #89: job A was started and the pipeline stopped at job B — something moved.
      ['held at a later job', stored(), read({ held_job: 'deploy-production' })],
      ['held at a job it now names', stored({ held_job: null }), read()],
    ];
    for (const [why, previous, current] of cases) {
      expect(isUnchangedHeldRetry(previous, current), why).toBe(false);
    }
  });

  it('words the escalation: still held at that job, and what to do', () => {
    expect(heldRetryBrief(read(), 'GitLab')).toBe(
      'The CI pipeline 3038234623 for this merge request is still held at the manual job "sentry-release-commit" — the same pipeline on the same head commit the previous attempt waited on, so the gate did not wait for it again. ' +
        "Start the job on GitLab, or change the job's rule so it runs without a person, then Retry.",
    );
    expect(heldRetryBrief(read({ held_job: null }), 'GitLab')).toContain(
      'still held at a manual job —',
    );
    expect(heldRetryReason(read())).toBe(
      'the CI gate\'s new attempt read pipeline 3038234623 still held at the manual job "sentry-release-commit" on the same head commit as the previous attempt\'s last read, so it did not wait for it again',
    );
  });
});

describe('toGateWait', () => {
  it('publishes the read without the head it keys on, timed from the attempt’s entry', () => {
    expect(toGateWait(stored(), '2026-11-06T19:28:00.000Z')).toEqual({
      pipeline_id: '3038234623',
      pipeline_url: null,
      status: 'manual',
      held_job: 'sentry-release-commit',
      held_job_url: null,
      draft: true,
      checked_at: '2026-11-06T20:27:30.000Z',
      waiting_since: '2026-11-06T19:28:00.000Z',
      timeout_minutes: 60,
    });
  });
});
