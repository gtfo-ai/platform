/**
 * **While CI waits, it says what it is waiting for** (S-25.11 step (2b), AUT-6655): the waiting
 * component, over its local `GateWait` shape. It is rendered nowhere until the task read carries the
 * gate's pending read (BACKLOG 1293), so this test is what holds its words and its links.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type GateWait, GateWaitNotice, gateWaitNeedsYou, gateWaitTime } from './gate-wait.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const PIPELINE_URL = 'https://git.example.invalid/acme/api/-/pipelines/41';
const JOB_URL = 'https://git.example.invalid/acme/api/-/jobs/977';

const held = (over: Partial<GateWait> = {}): GateWait => ({
  pipeline_id: '41',
  pipeline_url: PIPELINE_URL,
  status: 'manual',
  held_job: 'sentry-release-commit',
  held_job_url: JOB_URL,
  provider: 'gitlab',
  waited_minutes: 12,
  timeout_minutes: 60,
  draft: false,
  ...over,
});

afterEach(() => {
  cleanup();
});

describe('a pipeline held at a manual job', () => {
  it('needs a person at once, and says to start the job in GitLab', () => {
    expect(gateWaitNeedsYou(held())).toBe(true);
    render(<GateWaitNotice wait={held()} />);
    const notice = document.querySelector('[data-gate-wait="held"]');
    expect(notice?.textContent).toBe(
      'CI is waiting for someone to start the manual job sentry-release-commit in GitLab (pipeline 41, 12 min so far; the task gives up after 60). Start it there and the task continues.',
    );
  });

  it('links the job by name to its own page, and the pipeline to its own', () => {
    render(<GateWaitNotice wait={held()} />);
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      JOB_URL,
    );
    expect(screen.getByRole('link', { name: 'pipeline 41' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
  });

  it('falls back to the pipeline’s page for the job when the job’s URL is not known', () => {
    render(<GateWaitNotice wait={held({ held_job_url: null })} />);
    expect(screen.getByRole('link', { name: 'sentry-release-commit' }).getAttribute('href')).toBe(
      PIPELINE_URL,
    );
  });

  it('links nothing that is not http(s), and renders the job’s name as text', () => {
    render(
      <GateWaitNotice
        wait={held({
          held_job: HOSTILE,
          held_job_url: 'javascript:alert(1)',
          pipeline_url: 'javascript:alert(2)',
        })}
      />,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    const notice = document.querySelector('[data-gate-wait="held"]');
    expect(notice?.textContent).toContain(HOSTILE);
    expect(notice?.querySelector('img')).toBeNull();
    expect(notice?.querySelectorAll('[data-link-refused="true"]').length).toBe(2);
  });

  it('says why a draft may hold it, only for a draft', () => {
    render(<GateWaitNotice wait={held({ draft: true })} />);
    expect(document.querySelector('[data-gate-wait-draft]')).not.toBeNull();
    cleanup();
    render(<GateWaitNotice wait={held()} />);
    expect(document.querySelector('[data-gate-wait-draft]')).toBeNull();
  });

  it('names an unknown provider generically rather than raw', () => {
    render(<GateWaitNotice wait={held({ provider: 'house_git' })} />);
    expect(document.querySelector('[data-gate-wait="held"]')?.textContent).toContain(
      'in the provider (',
    );
  });
});

describe('a pipeline still running', () => {
  it('is not Needs you, and says how long and when the task gives up', () => {
    const running = held({ status: 'running', held_job: null, held_job_url: null });
    expect(gateWaitNeedsYou(running)).toBe(false);
    render(<GateWaitNotice wait={running} />);
    expect(document.querySelector('[data-gate-wait="running"]')?.textContent).toBe(
      'CI is running (pipeline 41, 12 min so far; the task gives up after 60).',
    );
    expect(document.querySelector('[data-gate-wait="held"]')).toBeNull();
  });

  it('says queued for a pending pipeline, and no pipeline when none has started', () => {
    render(<GateWaitNotice wait={held({ status: 'pending', held_job: null })} />);
    expect(document.querySelector('[data-gate-wait="running"]')?.textContent).toContain(
      'CI is queued',
    );
    cleanup();
    render(
      <GateWaitNotice
        wait={held({ status: null, pipeline_id: null, pipeline_url: null, held_job: null })}
      />,
    );
    expect(document.querySelector('[data-gate-wait="running"]')?.textContent).toBe(
      'CI has not started a pipeline yet (12 min so far; the task gives up after 60).',
    );
  });

  it('says no give-up time it does not know', () => {
    expect(gateWaitTime(held({ timeout_minutes: null }))).toBe('12 min so far');
  });
});
