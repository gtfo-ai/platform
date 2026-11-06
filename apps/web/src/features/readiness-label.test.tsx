/**
 * The readiness badge says what the level means for the people using the project (product/17's
 * 2026-11-06 amendment, research/21 F3), and its popover is the level's definition.
 *
 * Driven through `createApp` with a fake server on the Projects list, so the router, the query client
 * and the readiness read's parser are the real ones. Five claims:
 *
 * 1. per level, the badge's words are the amendment's own, level 0 is neutral (no ✕, never the
 *    failure colour), and the ladder's name and number are in the popover, not on the badge;
 * 2. the popover opens by a click and by the keyboard, and Escape gives the focus back;
 * 3. it names the next level, what it needs, and the evaluation's cheapest missing criterion with its
 *    how-to — read only once it is open — and links to *Discovery & readiness*;
 * 4. a project discovery has not evaluated is told so rather than given an invented criterion;
 * 5. the client's tables are the domain's ladder and criteria.
 */
import { READINESS_CRITERION_IDS, READINESS_LEVEL_REQUIREMENTS } from '@platform/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import {
  READINESS_LEVELS,
  readinessBadgeWord,
  readinessLadderName,
  readinessNameAndWord,
  readinessSummary,
  readinessTone,
} from './readiness-label.js';
import {
  READINESS_HOW_TO,
  READINESS_LEVEL_MEANINGS,
  READINESS_RUNG_REQUIREMENTS,
  READINESS_UNLOCKS,
} from './readiness-popover.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const projectRow = (level: number) => ({
  id: PROJECT,
  key: 'acme_api',
  name: 'ACME API',
  repo_url: 'https://git.example.test/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: level,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The first missing criterion of the next rung, as `nextReadinessImprovements` would name it. */
const FIRST_MISSING: Readonly<Record<number, string>> = { 0: 'R3', 1: 'R9', 2: 'R8', 3: 'R11' };

/** The read's `unlocks` is the domain's text, which carries spec references (R9's names BD-007). */
const DOMAIN_UNLOCKS = 'Human merge guarantee (BD-007); Investigation stage has evidence';

/** What a person must never be shown: a decision, slice or question id, or a spec page (F18). */
const SPEC_REFERENCE = /\b(?:BD|TD|WP|Q)-?\d+\b|product\/\d+|technical\/\d+/;

let readinessReads: number;

const fetchFor = (level: number, readiness: 'evaluated' | 'not_evaluated' = 'evaluated') =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/readiness')) {
      readinessReads += 1;
      if (readiness === 'not_evaluated') {
        return json(
          { error: { code: 'readiness_not_evaluated', message: 'no evaluation recorded' } },
          409,
        );
      }
      const missing = FIRST_MISSING[level];
      return json({
        level,
        evaluated_at: '2026-09-13T04:00:00.000Z',
        source: 'discovery',
        criteria: [],
        next_improvements:
          missing === undefined
            ? []
            : [{ id: missing, title: 'the criterion', unlocks: DOMAIN_UNLOCKS }],
      });
    }
    if (url.endsWith('/api/projects')) return json({ items: [projectRow(level)] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  readinessReads = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/projects');
});

const WORDS = [
  [0, 'Plans need your OK', 'Level 0 · Unverified', 'neutral'],
  [1, 'Big plans need your OK', 'Level 1 · Basic', 'neutral'],
  [2, 'Big plans need your OK', 'Level 2 · Reliable', 'neutral'],
  [3, 'Agents plan on their own', 'Level 3 · Agent-ready', 'success'],
  [4, 'Ready for more autonomy', 'Level 4 · Autonomous-capable', 'success'],
  // The contract allows a level product/17 does not name: shown, never given an invented name.
  [5, 'Level 5', 'Level 5', 'success'],
] as const;

const badge = async (word: string): Promise<HTMLElement> =>
  screen.findByRole('button', { name: `Readiness: ${word}` });

describe('the readiness badge, per level', () => {
  it.each(WORDS)(
    'level %i reads %j, neutral at the start, and its popover is the definition',
    async (level, word, ladder, tone) => {
      expect(readinessBadgeWord(level)).toBe(word);
      expect(readinessLadderName(level)).toBe(ladder);
      expect(readinessTone(level)).toBe(tone);

      render(createApp({ fetchImpl: fetchFor(level), realtime: false }).element);
      const trigger = await badge(word);
      // The badge says what agents may do; the ladder's name and number are not on it.
      expect(trigger.textContent).toBe(word);
      expect(trigger.getAttribute('data-readiness-tone')).toBe(tone);
      // Never the failure look: no ✕ glyph, no danger colour, no failure status label.
      expect(trigger.textContent).not.toContain('✕');
      expect(trigger.className).not.toMatch(/danger/);
      expect(trigger.querySelector('[data-status="failure"]')).toBeNull();
      expect(document.querySelector('[data-state-label="failure"]')).toBeNull();
      // Nothing is read until somebody asks: a list of projects costs no readiness read per row.
      expect(readinessReads).toBe(0);

      await userEvent.setup().click(trigger);
      const popover = await screen.findByRole('dialog', { name: ladder });
      const meaning = READINESS_LEVEL_MEANINGS[level];
      if (meaning !== undefined) {
        expect(popover.textContent).toContain(meaning);
      } else {
        expect(popover.textContent).toContain('does not name level 5');
      }
      const next = READINESS_LEVELS[level + 1];
      if (next !== undefined) {
        expect(popover.textContent).toContain(`Next: level ${level + 1} · ${next.name}`);
        expect(popover.textContent).toContain(next.badge);
        const missing = FIRST_MISSING[level] ?? '';
        await waitFor(() => {
          expect(popover.querySelector(`[data-readiness-missing="${missing}"]`)).not.toBeNull();
        });
        expect(popover.textContent).toContain(READINESS_HOW_TO[missing] ?? '∅');
        expect(popover.textContent).toContain(`It unlocks: ${READINESS_UNLOCKS[missing] ?? '∅'}`);
        expect(popover.textContent).not.toContain(DOMAIN_UNLOCKS);
        expect(readinessReads).toBe(1);
      } else if (level === 4) {
        expect(popover.textContent).toContain('the top of the readiness ladder');
      }
      expect(
        within(popover).getByRole('link', { name: 'Discovery & readiness' }).getAttribute('href'),
      ).toBe('/projects/acme_api/settings/discovery');
      // Plain words only: no spec reference reaches the screen, whatever the read carried.
      expect(popover.textContent ?? '').not.toMatch(SPEC_REFERENCE);
    },
  );
});

describe('the readiness popover', () => {
  it('is a lazy chunk: the badge is a plain button until it is pressed, and the swap keeps the focus (S-25.6)', async () => {
    const user = userEvent.setup();
    render(createApp({ fetchImpl: fetchFor(0), realtime: false }).element);
    const plain = await badge('Plans need your OK');
    // The popover trigger's own attributes, before its module has arrived.
    expect(plain.getAttribute('aria-haspopup')).toBe('dialog');
    expect(plain.getAttribute('aria-expanded')).toBe('false');
    // Hover and focus only fetch the chunk ahead: the element under the pointer stays the same, so
    // a press on its way is not lost to a swap (CI on #83).
    await user.hover(plain);
    plain.focus();
    await new Promise((settle) => setTimeout(settle, 50));
    expect(screen.getByRole('button', { name: 'Readiness: Plans need your OK' })).toBe(plain);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readinessReads).toBe(0);
    // A press swaps it: the popover's trigger — a new element, the same id and name — opens at once.
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Level 0 · Unverified' })).toBeTruthy();
    const swapped = screen.getByRole('button', { name: 'Readiness: Plans need your OK' });
    expect(swapped).not.toBe(plain);
    expect(swapped.id).toBe(plain.id);
    // …and the focus comes back to it, not to the body, when the popover closes.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(swapped);
  });

  it('opens from the keyboard and gives the focus back on Escape', async () => {
    const user = userEvent.setup();
    render(createApp({ fetchImpl: fetchFor(0), realtime: false }).element);
    (await badge('Plans need your OK')).focus();
    await user.keyboard('{Enter}');
    const popover = await screen.findByRole('dialog', { name: 'Level 0 · Unverified' });
    // Re-read: the first press may have arrived before the chunk, whose trigger replaced the button.
    const trigger = await badge('Plans need your OK');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(popover.textContent).toContain('It needs: Tests run green, CI runs on merge requests.');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Level 0 · Unverified' })).toBeNull();
    });
    expect(document.activeElement).toBe(await badge('Plans need your OK'));
    // And Space, a button's other key.
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog', { name: 'Level 0 · Unverified' })).toBeTruthy();
  });

  it('says nothing is known to be missing for a project discovery has not evaluated', async () => {
    render(createApp({ fetchImpl: fetchFor(0, 'not_evaluated'), realtime: false }).element);
    await userEvent.setup().click(await badge('Plans need your OK'));
    const popover = await screen.findByRole('dialog', { name: 'Level 0 · Unverified' });
    expect(
      await within(popover).findByText(
        'Discovery has not evaluated this project yet, so nothing is known to be missing.',
      ),
    ).toBeTruthy();
    expect(popover.querySelector('[data-readiness-missing]')).toBeNull();
    expect(within(popover).getByRole('link', { name: 'Discovery & readiness' })).toBeTruthy();
  });
});

describe('the words beside the wizard’s level', () => {
  it('names the level once, beside what it means', () => {
    expect(readinessNameAndWord(0)).toBe('Unverified · Plans need your OK');
    expect(readinessSummary(1)).toBe('Big plans need your OK (level 1, Basic)');
    expect(readinessSummary(5)).toBe('Level 5');
  });
});

describe('the client’s readiness tables', () => {
  it('are the domain’s ladder and its criteria', () => {
    expect(READINESS_RUNG_REQUIREMENTS).toEqual(READINESS_LEVEL_REQUIREMENTS);
    expect(READINESS_LEVELS).toHaveLength(READINESS_LEVEL_REQUIREMENTS.length + 1);
    expect(READINESS_LEVEL_MEANINGS).toHaveLength(READINESS_LEVELS.length);
    expect(Object.keys(READINESS_HOW_TO)).toEqual([...READINESS_CRITERION_IDS]);
    expect(Object.keys(READINESS_UNLOCKS)).toEqual([...READINESS_CRITERION_IDS]);
    for (const id of READINESS_CRITERION_IDS) {
      expect(READINESS_HOW_TO[id], id).toMatch(/^[A-Z].*\.$/);
      expect(READINESS_UNLOCKS[id], id).toMatch(/^[A-Z].*\.$/);
      for (const text of [READINESS_HOW_TO[id], READINESS_UNLOCKS[id]]) {
        expect(text, id).not.toMatch(SPEC_REFERENCE);
      }
    }
    for (const meaning of READINESS_LEVEL_MEANINGS) {
      expect(meaning).not.toMatch(SPEC_REFERENCE);
    }
  });
});
