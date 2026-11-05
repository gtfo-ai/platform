/**
 * The fleet map's run card (S-23.6): one button for the whole card, named with what the card shows
 * from its first words (WCAG 2.5.3) and described with the rest — the tracker's text as text.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { agentItem, EMPTY_INBOX, facts, NOW, PROJECT, uuid } from './fleet.test-fixture.js';
import { fleetOf } from './model.js';
import { FleetRunCard } from './run-card.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

afterEach(() => {
  cleanup();
});

describe('FleetRunCard', () => {
  it('is named by the key and title it shows, and described by its project, model, time and cost', async () => {
    const fleet = fleetOf({
      agents: [agentItem(1)],
      workers: [],
      inbox: EMPTY_INBOX,
      now: NOW,
      tasks: new Map([[uuid(1001), facts('DEMO-1', { title: `Checkout ${HOSTILE}` })]]),
      projectKeys: new Map([[PROJECT, 'demo']]),
    });
    const run = fleet.runs[0];
    if (run === undefined) {
      throw new Error('no run');
    }
    const opened: string[] = [];
    render(
      <FleetRunCard
        run={run}
        seat={fleet.seats[0] ?? null}
        now={NOW}
        onOpen={(id) => {
          opened.push(id);
        }}
      />,
    );
    const button = screen.getByRole('button', {
      name: `DEMO-1 · Checkout ${HOSTILE} · Implementation · working: Reading files · the platform server`,
    });
    // The visible headline is the start of the name.
    expect(screen.getByText(`DEMO-1 · Checkout ${HOSTILE}`)).toBeDefined();
    const description = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe(
      'Project demo, model claude-test, running for 5m 0s, cost $0.42',
    );
    expect(document.querySelector('img')).toBeNull();
    await userEvent.setup().click(button);
    expect(opened).toEqual([uuid(1)]);
  });
});
