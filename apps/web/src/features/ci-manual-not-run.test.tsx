/**
 * **A manual job nobody started is not a check, unless it is a test** (S-27.2, TD-036 decisions 5
 * and 7): the CI item's *CI passed — the manual job X was not run* and the Ready sentence about a
 * pipeline the provider still shows blocked, over the task read's own `ciManualNotRunSchema` shape —
 * every provider string a text node, every URL through `safeHref`, and nothing that says *can be
 * merged*.
 */
import {
  type CiManualNotRun,
  ciManualNotRunSchema,
  type TaskDetailResponse,
} from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManualNotRunValue,
  ReadyBlockedNotice,
  readyBlockedPipeline,
} from './ci-manual-not-run.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const PIPELINE_URL = 'https://git.example.invalid/acme/api/-/pipelines/3038234623';
const JOB_URL = 'https://git.example.invalid/acme/api/-/jobs/9003';

/** A record as the server publishes it — parsed, so a fixture the contract refuses fails here. */
const notRun = (over: Partial<CiManualNotRun> = {}): CiManualNotRun =>
  ciManualNotRunSchema.parse({
    pipeline_id: '3038234623',
    pipeline_url: PIPELINE_URL,
    pipeline_status: 'manual',
    jobs: [{ name: 'sentry-release-commit', stage: 'release', url: JOB_URL }],
    checked_at: '2026-11-07T10:00:00.000Z',
    ...over,
  });

afterEach(() => {
  cleanup();
});

describe('the CI item when a pass left manual jobs nobody started', () => {
  it('reads CI passed — the manual job sentry-release-commit was not run, the job linked', () => {
    render(<ManualNotRunValue notRun={notRun()} />);
    const value = document.querySelector('[data-ci-manual-not-run]');
    expect(value?.textContent).toBe('CI passed — the manual job sentry-release-commit was not run');
    const link = screen.getByRole('link', { name: 'sentry-release-commit' });
    expect(link.getAttribute('href')).toBe(JOB_URL);
  });

  it('names several jobs, and renders a hostile name as text, never as markup', () => {
    render(
      <ManualNotRunValue
        notRun={notRun({
          jobs: [
            { name: 'sentry-release-commit', stage: 'release', url: null },
            { name: HOSTILE, stage: null, url: null },
          ],
        })}
      />,
    );
    const value = document.querySelector('[data-ci-manual-not-run]');
    expect(value?.textContent).toBe(
      `CI passed — the manual jobs sentry-release-commit, ${HOSTILE} were not run`,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('Ready over a pipeline the provider still shows blocked (TD-036 decision 7)', () => {
  it('names the pipeline and the job to start, and never says the merge request can be merged', () => {
    render(<ReadyBlockedNotice notRun={notRun()} provider="gitlab" />);
    const sentence = document.querySelector('[data-ready-blocked]')?.textContent ?? '';
    expect(sentence).toBe(
      'GitLab shows pipeline 3038234623, the latest for this commit, as blocked at the manual job sentry-release-commit. If this project requires pipelines to succeed, GitLab won’t merge it until sentry-release-commit has run: start it on GitLab.',
    );
    expect(sentence).not.toMatch(/can be merged/i);
    expect(screen.getByRole('link', { name: 'pipeline 3038234623' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
  });

  it('says the provider generically when this build does not name it', () => {
    render(<ReadyBlockedNotice notRun={notRun({ pipeline_url: null })} provider={null} />);
    const sentence = document.querySelector('[data-ready-blocked]')?.textContent ?? '';
    expect(sentence.startsWith('The git provider shows pipeline 3038234623')).toBe(true);
  });

  it('is shown only at Ready, and only for a pipeline the provider still holds', () => {
    const detail = (state: string, record: CiManualNotRun | null) =>
      ({ task: { state }, ci_manual_not_run: record }) as unknown as TaskDetailResponse;
    expect(readyBlockedPipeline(detail('ready_for_merge', notRun()))).not.toBeNull();
    expect(readyBlockedPipeline(detail('active', notRun()))).toBeNull();
    expect(
      readyBlockedPipeline(detail('ready_for_merge', notRun({ pipeline_status: 'success' }))),
    ).toBeNull();
    expect(readyBlockedPipeline(detail('ready_for_merge', null))).toBeNull();
    expect(
      readyBlockedPipeline({
        task: { state: 'ready_for_merge' },
      } as unknown as TaskDetailResponse),
      'a fixture that predates the field',
    ).toBeNull();
  });
});
