/**
 * **The statistics screen renders an absence as prose and never as a zero** (WP-41).
 *
 * The screen it replaces was an honest empty state whose whole argument was one sentence: *"a
 * screen full of zeroes reads as 'we delivered nothing' rather than 'nothing is measured yet'"*.
 * The DTO now carries the difference — `absent` with a reason and an owner, `value: null` for a
 * ratio with nothing to divide, `0` for a count that really is zero — and this file is what stops
 * the screen collapsing the three back into one.
 *
 * It drives the **real** application against a fake API, like `checks-panel.test.tsx`, so the
 * assertions are about what a reader sees rather than about what a component was passed.
 */
import type { OrgStatsResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
} as unknown as SessionResponse;

const bucket = (start: string, end: string, value: number | null, samples: number) => ({
  start,
  end,
  value,
  samples,
});

const STATS: OrgStatsResponse = {
  range: {
    range: '30d',
    bucket: 'day',
    from: '2026-05-09',
    to: '2026-06-07',
    timezone: 'Europe/Prague',
    timezone_substituted: false,
  },
  project_id: null,
  metrics: [
    {
      id: 'tasks_delivered',
      label: 'Tasks delivered',
      definition: 'Tasks whose merge request merged, counted at merge time.',
      unit: 'count',
      value: 3,
      samples: 3,
      buckets: [bucket('2026-06-03', '2026-06-04', 3, 3)],
      absent: null,
      caveats: [],
    },
    {
      id: 'merge_rate',
      label: 'Merge rate',
      definition: 'Tasks delivered in the period divided by tasks started in the period.',
      unit: 'ratio',
      // Nothing to divide: not a zero.
      value: null,
      samples: 0,
      buckets: [bucket('2026-06-03', '2026-06-04', null, 0)],
      absent: null,
      caveats: [],
    },
    {
      id: 'reviewer_minutes_per_delivered_task',
      label: 'Reviewer minutes per delivered task',
      definition: 'Human review minutes in the period divided by the tasks delivered in it.',
      unit: 'minutes',
      value: 45,
      samples: 3,
      buckets: [bucket('2026-06-03', '2026-06-04', 45, 3)],
      absent: null,
      caveats: [
        'Over-counts: a bot that is not this platform opens a review window like a person.',
      ],
    },
    {
      id: 'loc_changed',
      label: 'Lines changed per merged MR',
      definition: 'LOC added/removed/changed per merged MR.',
      unit: 'count',
      value: null,
      samples: 0,
      buckets: [],
      absent: {
        reason: 'The one git provider this build ships publishes no insertion/deletion counts.',
        owner: 'Unowned — filed as discovered work by WP-41.',
      },
      caveats: [],
    },
  ],
  returns_by_stage: [
    { stage: 'code_review', entries: 4, returns: 1, rate: 0.25 },
    { stage: 'ci_gate', entries: 0, returns: 0, rate: null },
  ],
  generated_at: '2026-06-07T12:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes('/api/org/stats')) return json(STATS);
  if (url.endsWith('/api/projects')) return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  requested.length = 0;
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/stats');
});

const renderScreen = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByText('Tasks delivered');
  await waitFor(() => {
    expect(container.textContent).toContain('Not measured, and why');
  });
  return container;
};

describe('the statistics screen', () => {
  it('asks the server for the numbers rather than computing any of its own', async () => {
    await renderScreen();
    expect(requested.some((url) => url.includes('/api/org/stats?range=30d&bucket=day'))).toBe(true);
  });

  it('prints a measured zero, a null ratio and an absence as three different things', async () => {
    const container = await renderScreen();
    const text = container.textContent ?? '';

    // The count, as a number.
    expect(text).toContain('Tasks delivered');
    expect(text).toContain('3');
    // The ratio with nothing to divide — **not** "0.0%".
    expect(text).toContain('no data in this range');
    // The absence, with its reason and its owner, in the section that exists for it.
    const absentSection = text.slice(text.indexOf('Not measured, and why'));
    expect(absentSection).toContain('Lines changed per merged MR');
    expect(absentSection).toContain('publishes no insertion/deletion counts');
    expect(absentSection).toContain('Unowned');
    // …and the absent metric is not drawn as a metric card, which would give it a value.
    expect(text.slice(0, text.indexOf('Not measured, and why'))).not.toContain(
      'Lines changed per merged MR',
    );
  });

  it('shows the error directions of a figure that has them', async () => {
    const container = await renderScreen();
    expect(container.textContent).toContain('a bot that is not this platform');
  });

  it('names the zone the days were cut in', async () => {
    const container = await renderScreen();
    expect(container.textContent).toContain('Europe/Prague');
    expect(container.textContent).toContain('2026-05-09 to 2026-06-07');
  });

  it('prints a stage with no entries as "no entries" rather than 0%', async () => {
    const container = await renderScreen();
    const text = container.textContent ?? '';
    const returns = text.slice(text.indexOf('Returns by stage'));
    expect(returns).toContain('25.0%');
    expect(returns).toContain('no entries');
  });

  it('offers the CSV export as a link to the endpoint that serves it', async () => {
    const container = await renderScreen();
    const link = container.querySelector('a[href*="/api/org/stats.csv"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('range=30d');
    expect(link?.getAttribute('href')).toContain('bucket=day');
  });
});
