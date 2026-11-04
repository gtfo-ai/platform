/**
 * The robot behind the sign-in form: the hand-edited grids stay drawable, the frames swap without
 * flicker, and the CSS loop that moves it agrees with the sprite it moves.
 *
 * The keyframes are asserted from `styles.css`'s text because happy-dom runs no CSS animation: a
 * loop whose parts have different durations drifts apart silently, and a slide whose distance is
 * not the sprite's height leaves part of the bot showing when it should be hidden.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PeekBot } from './peek-bot.js';
import {
  PEEK_BOT_BLINK,
  PEEK_BOT_COLS,
  PEEK_BOT_INKS,
  PEEK_BOT_PEEK,
  PEEK_BOT_PIXEL_CSS_PX,
  PEEK_BOT_ROWS,
  PEEK_BOT_WAVE_A,
  PEEK_BOT_WAVE_B,
  peekBotRuns,
} from './peek-bot-sprite.js';

const FRAMES = { PEEK_BOT_PEEK, PEEK_BOT_WAVE_A, PEEK_BOT_WAVE_B } as const;
const LAYERS = { ...FRAMES, PEEK_BOT_BLINK } as const;
const CLASSES = [
  'peek-bot-rig',
  'peek-bot-peek',
  'peek-bot-wave-a',
  'peek-bot-wave-b',
  'peek-bot-blink',
];
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

afterEach(cleanup);

describe('the sprite', () => {
  it.each(Object.entries(LAYERS))(
    '%s fits the grid and its runs cover every inked pixel',
    (_, layer) => {
      const runs = peekBotRuns(layer);
      const inked = layer.join('').replaceAll('.', '').length;
      expect(runs.reduce((sum, run) => sum + run.width, 0)).toBe(inked);
      for (const run of runs) {
        expect(run.x + run.width).toBeLessThanOrEqual(PEEK_BOT_COLS);
        expect(run.y).toBeLessThan(PEEK_BOT_ROWS);
      }
    },
  );

  it('every frame is the full height, so the bottom row is always the edge it stands behind', () => {
    for (const frame of Object.values(FRAMES)) {
      expect(frame).toHaveLength(PEEK_BOT_ROWS);
    }
  });

  it('the frames share the head above the arm, so a swap moves only the arm', () => {
    const head = PEEK_BOT_PEEK.slice(0, 21);
    expect(PEEK_BOT_WAVE_A.slice(0, 21)).toEqual(head);
    expect(PEEK_BOT_WAVE_B.slice(0, 21)).toEqual(head);
  });

  it('the eyes are one shape, drawn twice', () => {
    for (const row of PEEK_BOT_PEEK.slice(17, 22)) {
      expect(row.slice(12, 17)).toBe(row.slice(24, 29));
      expect(row.slice(12, 17)).toContain('E');
    }
  });

  it('refuses a typo rather than drawing a hole', () => {
    expect(() => peekBotRuns(['..X'])).toThrow(/"X" at column 2/);
    expect(() => peekBotRuns(['W'.repeat(PEEK_BOT_COLS + 1)])).toThrow(/wide/);
    expect(() => peekBotRuns(Array<string>(PEEK_BOT_ROWS + 1).fill(''))).toThrow(/rows/);
  });
});

describe('the loop in styles.css', () => {
  it('runs every part on one 10 s loop, so the slide and the frames cannot drift apart', () => {
    for (const name of CLASSES) {
      expect(CSS).toMatch(new RegExp(`\\.${name}\\s*\\{\\s*animation: ${name} 10s `));
    }
  });

  it('slides exactly the sprite height, in whole sprite pixels', () => {
    const height = PEEK_BOT_ROWS * PEEK_BOT_PIXEL_CSS_PX;
    const rig = /@keyframes peek-bot-rig \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    const offsets = [...rig.matchAll(/translateY\((\d+)px\)/g)].map((match) => Number(match[1]));
    expect(Math.max(...offsets)).toBe(height);
    for (const offset of offsets) {
      expect(offset % PEEK_BOT_PIXEL_CSS_PX).toBe(0);
    }
  });

  it('turns every part off under reduced motion', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{\s*(\.peek-bot[\s\S]*?)\{/.exec(CSS)?.[1] ?? '';
    for (const name of CLASSES) {
      expect(reduced).toContain(`.${name}`);
    }
  });
});

describe('<PeekBot />', () => {
  it('is decoration: hidden from assistive tech, one group per layer, one rect per run', () => {
    render(<PeekBot />);
    const bot = screen.getByTestId('peek-bot');
    expect(bot.getAttribute('aria-hidden')).toBe('true');
    expect(bot.querySelector('svg')?.getAttribute('viewBox')).toBe(
      `0 0 ${PEEK_BOT_COLS} ${PEEK_BOT_ROWS}`,
    );
    const groups = [...bot.querySelectorAll('g')];
    expect(groups.map((group) => group.getAttribute('class'))).toEqual(CLASSES.slice(1));
    const runs = Object.values(LAYERS).reduce((sum, layer) => sum + peekBotRuns(layer).length, 0);
    expect(bot.querySelectorAll('rect')).toHaveLength(runs);
    const fills = new Set(
      [...bot.querySelectorAll('rect')].map((rect) => rect.getAttribute('class')),
    );
    expect([...fills].every((fill) => Object.values(PEEK_BOT_INKS).includes(fill as never))).toBe(
      true,
    );
  });
});
