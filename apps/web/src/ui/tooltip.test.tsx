/**
 * Tooltip's contract (TD-033 § 5): closed until asked, opened by **keyboard focus** as well as by a
 * pointer, closed by Escape, and drawn with the caller's own trigger element.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Tooltip } from './tooltip.js';

afterEach(() => {
  cleanup();
});

const renderTooltip = () =>
  render(
    <Tooltip content="Spend in the current budget window." delay={0}>
      <button type="button">Spend</button>
    </Tooltip>,
  );

describe('Tooltip', () => {
  it('renders the caller’s trigger and nothing else until asked', () => {
    renderTooltip();
    expect(screen.getByRole('button', { name: 'Spend' })).toBeTruthy();
    expect(screen.queryByText('Spend in the current budget window.')).toBeNull();
  });

  it('opens on keyboard focus and closes on Escape', async () => {
    const user = userEvent.setup();
    renderTooltip();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Spend' }));
    expect(await screen.findByText('Spend in the current budget window.')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByText('Spend in the current budget window.')).toBeNull();
    });
  });

  it('opens on hover', async () => {
    renderTooltip();
    const trigger = screen.getByRole('button', { name: 'Spend' });
    await act(async () => {
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
      fireEvent.mouseEnter(trigger);
      fireEvent.mouseMove(trigger);
    });
    expect(await screen.findByText('Spend in the current budget window.')).toBeTruthy();
  });
});
