/**
 * The kit's API on the new look (TD-033): `Metric`'s definition is a Tooltip that opens on keyboard
 * focus and is still tied to the label by `aria-describedby`; `Card` takes an optional Box header.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Card, Metric } from './kit.js';

afterEach(() => {
  cleanup();
});

describe('Metric', () => {
  it('describes its label with the definition, and shows it as a tooltip on focus', async () => {
    render(
      <Metric label="Spend" value="$4.20" definition="Reported cost in the current window." />,
    );
    const label = screen.getByText('Spend');
    // Reachable by Tab, and not a button: it opens a definition rather than performing anything.
    expect(label.tabIndex).toBe(0);
    expect(screen.queryByRole('button')).toBeNull();
    const describedBy = label.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Reported cost in the current window.',
    );
    expect(label.hasAttribute('title')).toBe(false);
    expect(screen.getByText('$4.20')).toBeTruthy();

    await userEvent.setup().tab();
    expect(document.activeElement).toBe(label);
    const shown = await screen.findAllByText('Reported cost in the current window.');
    // The hidden description and the open tooltip.
    expect(shown).toHaveLength(2);
  });
});

describe('Card', () => {
  it('is a plain bordered box, or a Box with a subtle header row', () => {
    const { container } = render(
      <>
        <Card>plain</Card>
        <Card header="Budgets">with header</Card>
      </>,
    );
    expect(screen.getByText('plain').className).toContain('border-line');
    expect(screen.getByText('Budgets').className).toContain('bg-subtle');
    expect(container.textContent).toBe('plainBudgetswith header');
  });
});
