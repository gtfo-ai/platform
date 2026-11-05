/**
 * Blankslate (research/19 § 3.5): title and hint always, and an action unless the state is
 * `informational`. The type is the guard — the `@ts-expect-error` lines below fail `typecheck` the
 * day a blankslate without a next step compiles.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Blankslate } from './blankslate.js';
import { Button } from './button.js';
import { EmptyState } from './kit.js';

afterEach(() => {
  cleanup();
});

describe('Blankslate', () => {
  it('says what is missing, what will appear, and offers the next step', () => {
    const { container } = render(
      <Blankslate
        title="No tasks yet"
        hint="A ticket that matches the project's rule appears here within a minute."
        action={<Button tone="primary">Start a ticket</Button>}
        secondary={<span>Learn more</span>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No tasks yet' })).toBeTruthy();
    expect(screen.getByText(/appears here within a minute/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start a ticket' })).toBeTruthy();
    expect(screen.getByText('Learn more')).toBeTruthy();
    expect(container.querySelector('[data-blankslate]')?.getAttribute('data-blankslate')).toBe(
      'actionable',
    );
  });

  it('may go without an action only when it is informational', () => {
    const { container } = render(
      <Blankslate informational title="Nothing audited" hint="Every command lands here." />,
    );
    expect(container.querySelector('[data-blankslate]')?.getAttribute('data-blankslate')).toBe(
      'informational',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refuses, at the type, a blankslate with neither an action nor `informational`', () => {
    // @ts-expect-error — `action` is required unless `informational` is set.
    const missing = <Blankslate title="t" hint="h" />;
    // @ts-expect-error — `hint` is required.
    const noHint = <Blankslate informational title="t" />;
    expect([missing, noHint]).toHaveLength(2);
  });

  it('is what the kit’s EmptyState draws, informational when it has no action', () => {
    const { container } = render(
      <>
        <EmptyState title="Inbox is empty" hint="Questions from agents appear here." />
        <EmptyState title="No projects" hint="Onboard one." action={<Button>Onboard</Button>} />
      </>,
    );
    expect(
      [...container.querySelectorAll('[data-blankslate]')].map((node) =>
        node.getAttribute('data-blankslate'),
      ),
    ).toEqual(['informational', 'actionable']);
  });
});
