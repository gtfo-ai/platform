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
import { QueryClient } from '@tanstack/react-query';
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
      // Two buckets with a value: enough for a sparkline.
      buckets: [bucket('2026-06-02', '2026-06-03', 1, 1), bucket('2026-06-03', '2026-06-04', 2, 2)],
      absent: null,
      caveats: [],
    },
    {
      // An average count: eight returns on one delivered task is "8.0", never "800.0%".
      id: 'returns_per_delivered_task',
      label: 'Returns per delivered task',
      definition: 'Average number of stage returns per delivered task.',
      unit: 'decimal',
      value: 8,
      samples: 1,
      buckets: [bucket('2026-06-03', '2026-06-04', 8, 1)],
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
      // An absent metric of this build's (WP-61 made `loc_changed`, the one this used to be,
      // computable — backlog 179).
      id: 'queue_wait_minutes',
      label: 'Queue wait',
      definition: 'How long a task waited between being queued and being picked up.',
      unit: 'minutes',
      value: null,
      samples: 0,
      buckets: [],
      absent: {
        reason: '`task.dequeued` is declared unconsumed and nothing projects it.',
        owner: 'Nobody yet — a row that folds task.queued against task.dequeued owns it.',
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
/** S-25.18: when set, the statistics read answers this refusal. */
let statsRefusal: {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} | null = null;

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes('/api/org/stats')) {
    return statsRefusal === null
      ? json(STATS)
      : json(
          { error: { code: statsRefusal.code, message: statsRefusal.message } },
          statsRefusal.status,
        );
  }
  if (url.endsWith('/api/projects')) return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  requested.length = 0;
  statsRefusal = null;
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
    // The ratio with nothing to divide — **not** "0.0%": a muted dash and the sentence, small.
    const mergeRate = container.querySelector('[data-metric-card="merge_rate"]');
    expect(mergeRate?.textContent).toContain('—');
    expect(mergeRate?.textContent).toContain('No data in this range');
    expect(mergeRate?.textContent).not.toMatch(/\d/);
    // The absence, with its reason and its owner, in the section that exists for it.
    const absentSection = text.slice(text.indexOf('Not measured, and why'));
    expect(absentSection).toContain('Queue wait');
    expect(absentSection).toContain('nothing projects it');
    expect(absentSection).toContain('Nobody yet');
    // …and the absent metric is not drawn as a metric card, which would give it a value.
    expect(text.slice(0, text.indexOf('Not measured, and why'))).not.toContain('Queue wait');
  });

  it('shows the error directions of a figure in one disclosure, never under the value', async () => {
    const container = await renderScreen();
    const disclosure = [...container.querySelectorAll('details')].find((details) =>
      details.textContent?.startsWith('How these are measured'),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Reviewer minutes per delivered task');
    expect(disclosure?.textContent).toContain('a bot that is not this platform');
    // The card itself carries the value and one muted line, and no caveat.
    const card = container.querySelector(
      '[data-metric-card="reviewer_minutes_per_delivered_task"]',
    );
    expect(card?.textContent).not.toContain('a bot that is not this platform');
  });

  it('groups the figures into sections with headings, in the order the owner reads them', async () => {
    await renderScreen();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Throughput', 'Quality', 'Time', 'Returns by stage']);
    const throughput = screen.getByRole('region', { name: 'Throughput' });
    expect(throughput.textContent).toContain('Tasks delivered');
    expect(throughput.textContent).toContain('Merge rate');
    expect(screen.getByRole('region', { name: 'Quality' }).textContent).toContain(
      'Returns per delivered task',
    );
  });

  it('prints an average count as a plain number, says what it is from and which way is good (S-25.7)', async () => {
    const container = await renderScreen();
    const returns = container.querySelector('[data-metric-card="returns_per_delivered_task"]');
    expect(returns?.textContent).toContain('8.0');
    expect(returns?.textContent).not.toContain('%');
    // "From 1 delivered task", never "1 observation" (research/21 F15).
    expect(returns?.textContent).toContain('From 1 delivered task');
    expect(returns?.querySelector('[data-metric-reading]')?.textContent).toBe('Lower is better');
    const delivered = container.querySelector('[data-metric-card="tasks_delivered"]');
    expect(delivered?.textContent).toContain('From 3 delivered tasks');
    expect(delivered?.querySelector('[data-metric-reading]')?.textContent).toBe('Higher is better');
    expect(container.textContent).not.toMatch(/observation/i);
  });

  it('draws a sparkline only where two buckets carry a value, with the trend in words', async () => {
    const container = await renderScreen();
    const delivered = container.querySelector('[data-metric-card="tasks_delivered"]');
    const svg = delivered?.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('polyline')?.getAttribute('points')).toBe('0,22 100,2');
    expect(delivered?.querySelector('.sr-only')?.textContent).toBe(
      'Trend by day: 2 of 2 days with data; lowest 1, highest 2, latest 2.',
    );
    // One bucket is not a trend.
    const returns = container.querySelector('[data-metric-card="returns_per_delivered_task"]');
    expect(returns?.querySelector('svg')).toBeNull();
    // The line is drawn with attributes and a colour class, never a `style` (S-23.19's brief).
    const spark = delivered?.querySelector('[data-sparkline]');
    expect(spark).not.toBeNull();
    expect(spark?.matches('[style]') || spark?.querySelector('[style]') !== null).toBe(false);
  });

  it('names the zone the days were cut in', async () => {
    const container = await renderScreen();
    expect(container.textContent).toContain('Europe/Prague');
    // The same date format as every other screen (S-25.7, research/21 F15), never ISO.
    expect(container.textContent).toContain('May 9, 2026 to Jun 7, 2026');
    expect(container.textContent).not.toContain('2026-05-09');
  });

  it('prints a stage with no entries as "no entries" rather than 0%', async () => {
    const container = await renderScreen();
    const text = container.textContent ?? '';
    const returns = text.slice(text.indexOf('Returns by stage'));
    expect(returns).toContain('25.0%');
    expect(returns).toContain('1 return in 4 entries');
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

describe('a statistics read that fails (S-25.18)', () => {
  it('says why in its own words, and keeps the server’s message behind Technical details', async () => {
    const message = 'stats over 400 days need 1 200 000 rows; the bound is 500 000 (stats-queries)';
    statsRefusal = { status: 409, code: 'stats_range_too_large', message };
    // The app's client retries a failed read once, after a second; the refusal is the case under
    // test, so it is said at once rather than after the retry.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    render(createApp({ fetchImpl, realtime: false, queryClient }).element);
    let alert: HTMLElement | undefined;
    await waitFor(() => {
      alert = screen
        .getAllByRole('alert')
        .find((each) => each.textContent?.includes('Statistics could not be loaded'));
      expect(alert).toBeDefined();
    });
    const visible = alert?.cloneNode(true) as HTMLElement;
    for (const details of visible.querySelectorAll('details')) {
      details.remove();
    }
    expect(visible.textContent).toContain('That period holds too much to add up at once.');
    expect(visible.textContent).not.toContain(message);
    expect(alert?.querySelector('details')?.textContent).toContain(message);
  });
});
