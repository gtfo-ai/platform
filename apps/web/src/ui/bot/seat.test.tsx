/**
 * `<Seat>`: the bot behind a desk with its slots. The slots are text (BD-022: whatever a caller
 * passes is rendered as React children, never as markup), the drawing is decoration, and the
 * laptop says from across the room whether the bot is at work.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BOT_POSES } from './bot.js';
import { LAPTOP_IN_USE, SEAT_COLS, SEAT_ROWS, Seat } from './seat.js';

afterEach(cleanup);

const groupClasses = (): string[] =>
  [...screen.getByTestId('seat').querySelectorAll('g')].map(
    (group) => group.getAttribute('class') ?? '',
  );

describe('<Seat />', () => {
  it('renders the bubble and the nameplate as text, markup included', () => {
    render(
      <Seat
        pose="typing"
        bubble="Now: Reading files"
        nameplate={'<img src=x onerror=alert(1)> worker-1 · ABC-12'}
      />,
    );
    expect(screen.getByTestId('seat-bubble').textContent).toBe('Now: Reading files');
    const nameplate = screen.getByTestId('seat-nameplate');
    expect(nameplate.textContent).toBe('<img src=x onerror=alert(1)> worker-1 · ABC-12');
    expect(nameplate.tagName).toBe('FIGCAPTION');
    expect(screen.getByTestId('seat').querySelector('img')).toBeNull();
  });

  it('draws no slot it was not given', () => {
    render(<Seat pose="sleeping" />);
    expect(screen.queryByTestId('seat-bubble')).toBeNull();
    expect(screen.queryByTestId('seat-nameplate')).toBeNull();
  });

  it.each(BOT_POSES)(
    '%s: the bot, the desk and the right laptop, hidden from assistive tech',
    (pose) => {
      render(<Seat pose={pose} scale={2} phase={3} />);
      const svg = screen.getByTestId('seat').querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${SEAT_COLS} ${SEAT_ROWS}`);
      expect(svg?.getAttribute('width')).toBe(String(SEAT_COLS * 2));
      expect(svg?.getAttribute('class')).toContain('bot-phase-3');
      const classes = groupClasses();
      expect(classes).toContain('seat-desk');
      expect(classes).toContain(LAPTOP_IN_USE[pose] ? 'seat-laptop-front' : 'seat-laptop-back');
      expect(classes).not.toContain(LAPTOP_IN_USE[pose] ? 'seat-laptop-back' : 'seat-laptop-front');
    },
  );

  it('puts the lit screen in front only while the bot types or thinks', () => {
    expect(BOT_POSES.filter((pose) => LAPTOP_IN_USE[pose])).toEqual(['typing', 'thinking']);
  });

  it('draws the mug and plant on request, and no desk mug while the bot holds its own', () => {
    render(<Seat pose="typing" mug plant />);
    expect(groupClasses()).toEqual(expect.arrayContaining(['seat-mug', 'seat-plant']));
    cleanup();
    render(<Seat pose="sipping" mug />);
    expect(groupClasses()).not.toContain('seat-mug');
    expect(groupClasses()).toContain('bot-steam-a');
  });

  it('carries no URL attribute and sets only its own width as a style', () => {
    render(<Seat pose="cheer" mug plant bubble="Done" nameplate="worker-1" scale={4} />);
    const seat = screen.getByTestId('seat');
    expect(seat.getAttribute('style')).toMatch(new RegExp(`^width: ${SEAT_COLS * 4}px;?$`));
    for (const element of seat.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute).not.toMatch(/href|src|style|action/i);
      }
    }
  });
});
