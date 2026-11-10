/**
 * **While CI waits, it says what it is waiting for** (S-25.12, product/10's Task detail amendments
 * of 2026-11-07, AUT-6655): the open wait's words (`GateWaitNotice`, `gateWaitShort`) and the
 * parked wait's (`CiWaitStop`), over the task read's own `gateWaitSchema` shape — every provider
 * string a text node, every URL through `safeHref`.
 */
import { type GateWait, gateWaitSchema, type TaskStop } from '@platform/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CiWaitStop,
  GateWaitNotice,
  gateWaitHeld,
  gateWaitJobUrl,
  gateWaitMinutes,
  gateWaitShort,
  gateWaitStaleMinutes,
  gateWaitTime,
  openGateWait,
  providerName,
} from './gate-wait.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const PIPELINE_URL = 'https://git.example.invalid/acme/api/-/pipelines/41';
const JOB_URL = 'https://git.example.invalid/acme/api/-/jobs/977';
const SINCE = '2026-11-07T10:00:00.000Z';
/** Twelve and a half minutes after `SINCE`: the sentence says whole minutes. */
const NOW = Date.parse(SINCE) + 12.5 * 60_000;

/** A read as the server publishes it — parsed, so a fixture the contract refuses fails here. */
const held = (over: Partial<GateWait> = {}): GateWait =>
  gateWaitSchema.parse({
    pipeline_id: '41',
    pipeline_url: PIPELINE_URL,
    status: 'manual',
    held_job: 'sentry-release-commit',
    held_job_url: JOB_URL,
    draft: false,
    checked_at: '2026-11-07T10:11:30.000Z',
    waiting_since: SINCE,
    timeout_minutes: 60,
    ...over,
  });

const running = (over: Partial<GateWait> = {}): GateWait =>
  held({ status: 'running', held_job: null, held_job_url: null, ...over });

const stop = (over: Partial<TaskStop> = {}): TaskStop => ({
  stage: 'ci_gate',
  attempt: 1,
  cause: 'no_answer',
  loop: null,
  ci_failure: null,
  recorded:
    'the CI gate on a poll-only gitlab binding timed out (pipeline.limits.ci_timeout_minutes = 60)',
  recorded_cut: false,
  ci_ending: 'ci_timed_out',
  ...over,
});

const text = (selector: string): string | null | undefined =>
  document.querySelector(selector)?.textContent;

afterEach(() => {
  cleanup();
});

describe('a pipeline still running', () => {
  it('says the pipeline, the minutes so far and when the task gives up', () => {
    expect(gateWaitHeld(running())).toBe(false);
    render(<GateWaitNotice wait={running()} provider="gitlab" projectKey={null} nowMs={NOW} />);
    expect(text('[data-gate-wait="running"]')).toBe(
      'CI is running (pipeline 41, 12 min so far; the task gives up after 60).',
    );
    expect(screen.getByRole('link', { name: 'pipeline 41' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
    expect(document.querySelector('[data-gate-wait="held"]')).toBeNull();
  });

  it('leaves out when it gives up for a wait with no timeout (a webhook binding)', () => {
    render(
      <GateWaitNotice
        wait={running({ timeout_minutes: null })}
        provider="gitlab"
        projectKey={null}
        nowMs={NOW}
      />,
    );
    expect(text('[data-gate-wait="running"]')).toBe('CI is running (pipeline 41, 12 min so far).');
    expect(gateWaitTime(running({ timeout_minutes: null }), NOW)).toBe('12 min so far');
  });

  it('says a pipeline that has not started is queued, and counts to the read without a clock', () => {
    render(
      <GateWaitNotice
        wait={running({ status: 'pending', pipeline_url: null })}
        provider="gitlab"
        projectKey={null}
      />,
    );
    // No clock: from the attempt's entry to the read's own instant, 11.5 minutes.
    expect(text('[data-gate-wait="running"]')).toBe(
      'CI is queued (pipeline 41, 11 min so far; the task gives up after 60).',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never counts past the timeout, and says when a stale read was taken (review of PR #101)', () => {
    // The read stopped being refreshed at 11.5 min; the page's clock is 75 min in.
    const late = Date.parse(SINCE) + 75 * 60_000;
    expect(gateWaitMinutes(running(), late)).toBe(60);
    expect(gateWaitStaleMinutes(running(), late)).toBe(63);
    expect(gateWaitTime(running(), late)).toBe(
      '60 min so far; the task gives up after 60; last checked 63 min ago',
    );
    expect(gateWaitShort(running(), late)).toBe('CI running · 60 min of 60');
    // A fresh read (a minute old) says nothing about when it was taken; no clock, nothing either.
    expect(gateWaitStaleMinutes(running(), NOW)).toBeNull();
    expect(gateWaitStaleMinutes(running())).toBeNull();
    // With no timeout there is nothing to cap at.
    expect(gateWaitMinutes(running({ timeout_minutes: null }), late)).toBe(75);
  });

  it('is open only while the task is active (review of PR #101)', () => {
    expect(openGateWait({ task: { state: 'active' }, gate_wait: held() })).toEqual(held());
    for (const state of ['paused', 'needs_human', 'waiting_answers', 'cancelled'] as const) {
      expect(openGateWait({ task: { state }, gate_wait: held() }), state).toBeNull();
    }
    expect(openGateWait({ task: { state: 'active' }, gate_wait: null })).toBeNull();
  });

  it('never counts a negative wait, and has a short form for the header', () => {
    expect(gateWaitMinutes(running(), Date.parse(SINCE) - 60_000)).toBe(0);
    expect(gateWaitShort(running(), NOW)).toBe('CI running · 12 min of 60');
    expect(gateWaitShort(running({ timeout_minutes: null }), NOW)).toBe('CI running · 12 min');
  });
});

describe('a pipeline held at a manual job', () => {
  it('needs a person at once, says to start the job in GitLab, and links the job', () => {
    expect(gateWaitHeld(held())).toBe(true);
    render(<GateWaitNotice wait={held()} provider="gitlab" projectKey={null} nowMs={NOW} />);
    expect(text('[data-gate-wait-sentence]')).toBe(
      'CI is waiting for someone to start the manual job sentry-release-commit in GitLab. Start it there and the task continues.',
    );
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      JOB_URL,
    );
    expect(text('[data-gate-wait-time]')).toBe(
      'Pipeline 41 · 12 min so far; the task gives up after 60.',
    );
    expect(document.querySelector('[data-gate-wait-draft]')).toBeNull();
    expect(gateWaitShort(held(), NOW)).toBe(
      'CI waits for someone to start the manual job sentry-release-commit',
    );
  });

  it('links the job by its pipeline when the job’s own page is not known', () => {
    const wait = held({ held_job_url: null });
    expect(gateWaitJobUrl(wait)).toBe(PIPELINE_URL);
    render(<GateWaitNotice wait={wait} provider="gitlab" projectKey={null} nowMs={NOW} />);
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
  });

  it('names the job as text when no link is known, and a hostile name stays text', () => {
    const wait = held({ held_job: HOSTILE, held_job_url: null, pipeline_url: null });
    expect(gateWaitJobUrl(wait)).toBeNull();
    render(<GateWaitNotice wait={wait} provider="gitlab" projectKey={null} nowMs={NOW} />);
    expect(text('[data-gate-wait-sentence]')).toContain(`the manual job ${HOSTILE} in GitLab`);
    expect(document.querySelector('[data-gate-wait="held"] img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says "a manual job" when the pipeline named none, and the provider generically', () => {
    render(
      <GateWaitNotice
        wait={held({ held_job: null })}
        provider="house_git"
        projectKey={null}
        nowMs={NOW}
      />,
    );
    expect(text('[data-gate-wait-sentence]')).toBe(
      'CI is waiting for someone to start a manual job in the git provider. Start it there and the task continues.',
    );
    expect(providerName(undefined)).toBe('the git provider');
    expect(gateWaitShort(held({ held_job: null }), NOW)).toBe(
      'CI waits for someone to start a manual job',
    );
  });

  it('adds the draft note, without a link when the page has no project key', () => {
    render(
      <GateWaitNotice
        wait={held({ draft: true })}
        provider="gitlab"
        projectKey={null}
        nowMs={NOW}
      />,
    );
    expect(text('[data-gate-wait-draft]')).toBe(
      'The merge request is still a draft: the platform keeps it one until the task is ready. If this project’s CI rules hold jobs for drafts, its readiness shows a CI-rules warning.',
    );
  });

  it('links the draft note to the readiness panel’s CI-rules warning', async () => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => (
        <GateWaitNotice
          wait={held({ draft: true })}
          provider="gitlab"
          projectKey="ACME"
          nowMs={NOW}
        />
      ),
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: '/projects/$key/settings/$section',
      component: () => <h1>Settings</h1>,
    });
    const router = createRouter({
      routeTree: root.addChildren([page, settings]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    const link = await screen.findByRole('link', { name: 'Discovery & readiness' });
    expect(link.getAttribute('href')).toBe('/projects/ACME/settings/discovery');
    expect(text('[data-gate-wait-draft]')).toContain(
      'its readiness shows a CI-rules warning in Discovery & readiness.',
    );
  });
});

describe('a wait that ended with no answer', () => {
  it('says a timed-out wait did not finish within N minutes, held at the job, never that it failed', () => {
    render(<CiWaitStop stop={stop()} read={held()} provider="gitlab" />);
    const sentence = text('[data-stop-sentence]') ?? '';
    expect(sentence).toBe(
      'CI did not finish within 60 minutes: pipeline 41 was still held at the manual job sentry-release-commit.',
    );
    expect(sentence).not.toContain('failed');
    expect(text('[data-stop-next]')).toBe('Start the job in GitLab, then Retry.');
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      JOB_URL,
    );
    expect(screen.getByRole('link', { name: 'pipeline 41' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
    expect(document.querySelector('[data-ci-ending="ci_timed_out"]')).not.toBeNull();
    // The recorded sentence, internal words and all, is not quoted where the read exists.
    expect(document.body.textContent).not.toContain('ci_timeout_minutes');
  });

  it('says a timed-out wait on a pipeline still running, with its own next step', () => {
    render(<CiWaitStop stop={stop()} read={running()} provider="gitlab" />);
    expect(text('[data-stop-sentence]')).toBe(
      'CI did not finish within 60 minutes: pipeline 41 was still running.',
    );
    expect(text('[data-stop-next]')).toBe(
      'Look at the pipeline in GitLab; once it has finished, Retry.',
    );
  });

  it('says the time the platform waits when the read has no timeout', () => {
    render(
      <CiWaitStop
        stop={stop({ ci_ending: null })}
        read={running({ timeout_minutes: null, status: 'pending' })}
        provider="gitlab"
      />,
    );
    expect(text('[data-stop-sentence]')).toBe(
      'CI did not finish in the time the platform waits for it: pipeline 41 had still not started.',
    );
    expect(document.querySelector('[data-ci-ending="none"]')).not.toBeNull();
  });

  it('says a Retry on the same held pipeline did not wait again, and the two ways forward', () => {
    render(
      <CiWaitStop
        stop={stop({ ci_ending: 'ci_held_unchanged', attempt: 2 })}
        read={held()}
        provider="gitlab"
      />,
    );
    expect(text('[data-stop-sentence]')).toBe(
      'The pipeline is still held at the manual job sentry-release-commit, so Retry did not wait again.',
    );
    expect(text('[data-stop-next]')).toBe(
      'Start the job in GitLab, or change its rule, then Retry.',
    );
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      JOB_URL,
    );
  });
});

/**
 * S-28.7 (TD-036's 2026-11-10 amendment decisions 5 and 6): under the wait, what the platform did
 * about the jobs the project set to run; and, for a person's job it did not start, the way to have
 * it start that job next time.
 */
describe('the jobs the platform started (S-28.7)', () => {
  const entry = (
    jobId: string,
    name: string,
    outcome: 'started' | 'refused' | 'unsupported',
    pipelineId = '41',
  ) => ({
    job_id: jobId,
    pipeline_id: pipelineId,
    name,
    url: `https://git.example.invalid/acme/api/-/jobs/${jobId}`,
    at: '2026-11-07T10:05:00.000Z',
    outcome,
  });

  it('says started, refused and unsupported in plain words, for this pipeline only', () => {
    render(
      <GateWaitNotice
        wait={running()}
        provider="gitlab"
        projectKey={null}
        nowMs={NOW}
        started={[
          entry('1', 'build_composer', 'started'),
          entry('2', 'codeception', 'refused'),
          entry('3', 'crawler-test', 'unsupported'),
          entry('4', 'older-pipeline-job', 'started', '40'),
        ]}
      />,
    );
    const lines = [...document.querySelectorAll('[data-ci-manual-started] li')].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      'Started build_composer for you — waiting for its result.',
      'Could not start codeception: the platform’s GitLab account may not run it. Start it in GitLab, or give the account permission. Open job',
      'Could not start crawler-test: this GitLab connection cannot start manual jobs. Start it in GitLab. Open job',
    ]);
    expect(screen.getAllByRole('link', { name: 'Open job' })[0]?.getAttribute('href')).toBe(
      'https://git.example.invalid/acme/api/-/jobs/2',
    );
  });

  it('renders a hostile job name as text', () => {
    render(
      <GateWaitNotice
        wait={running()}
        provider="gitlab"
        projectKey={null}
        nowMs={NOW}
        started={[entry('1', HOSTILE, 'started')]}
      />,
    );
    expect(document.querySelector('[data-ci-manual-started] img')).toBeNull();
    expect(text('[data-ci-manual-started]')).toContain(HOSTILE);
  });

  const routed = async (started: Parameters<typeof GateWaitNotice>[0]['started']) => {
    const root = createRootRoute({ component: () => <Outlet /> });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => (
        <GateWaitNotice
          wait={held({ held_job: 'crawler-test' })}
          provider="gitlab"
          projectKey="ACME"
          nowMs={NOW}
          started={started}
        />
      ),
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: '/projects/$key/settings/$section',
      component: () => <h1>Settings</h1>,
    });
    const router = createRouter({
      routeTree: root.addChildren([page, settings]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    await screen.findByText(/CI is waiting for someone to start/);
  };

  it('links the Manual CI jobs card when a person must start a job the platform did not start', async () => {
    await routed([]);
    const link = screen.getByRole('link', { name: 'Have the platform start it next time' });
    expect(link.getAttribute('href')).toBe('/projects/ACME/settings/policies#manual-ci-jobs');
  });

  it('does not offer it for a job the platform tried to start', async () => {
    await routed([entry('3', 'crawler-test', 'refused')]);
    expect(screen.queryByRole('link', { name: 'Have the platform start it next time' })).toBeNull();
  });
});
