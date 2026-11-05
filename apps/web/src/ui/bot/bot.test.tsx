/**
 * `<Bot>` draws every pose as decoration, and `bot.css` animates it by class alone.
 *
 * The keyframes are asserted from the stylesheet's text because happy-dom runs no CSS animation
 * (the same reason as `features/peek-bot.test.tsx`): a layer whose class has no reduced-motion
 * rule keeps moving for a visitor who asked it not to, and a non-first frame that is not hidden by
 * default is drawn over the first one when nothing moves.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BOT_POSES, Bot } from './bot.js';
import { BOT_POSE_LAYERS, BOT_STAGE_COLS, BOT_STAGE_ROWS } from './poses.js';
import { SPRITE_INKS, spriteRuns } from './sprite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'bot.css'), 'utf8');
const STYLES = readFileSync(join(HERE, '..', '..', 'styles.css'), 'utf8');

/** Every class a pose draws a layer under. */
const LAYER_CLASSES = [
  ...new Set(BOT_POSES.flatMap((pose) => BOT_POSE_LAYERS[pose].map((layer) => layer.className))),
];

/** A body with one frame, and confused's `?`, which simply stays. */
const STILL_LAYERS = ['bot-body', 'bot-question'];

/** Rules outside the media query: selector list → declarations. */
const RULES = [
  ...CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[\s\S]*$/, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
]
  .map((match) => ({ selectors: (match[1] ?? '').trim(), body: match[2] ?? '' }))
  .filter((rule) => !rule.selectors.includes('%') && !rule.selectors.startsWith('@'));

const classesWith = (declaration: RegExp): string[] =>
  RULES.filter((rule) => declaration.test(rule.body)).flatMap((rule) =>
    rule.selectors
      .split(',')
      .map((selector) => selector.trim())
      .filter((selector) => /^\.bot-[a-z0-9-]+$/.test(selector))
      .map((selector) => selector.slice(1)),
  );

const REDUCED =
  /@media \(prefers-reduced-motion: reduce\) \{\s*([\s\S]*?)\{\s*animation: none;/.exec(CSS)?.[1] ??
  '';

afterEach(cleanup);

describe('bot.css', () => {
  it('is imported by styles.css, so the app and the worker page load one stylesheet', () => {
    expect(STYLES).toContain('@import "./ui/bot/bot.css";');
  });

  it('animates every layer class but the still ones, each with keyframes of its own name', () => {
    const animated = classesWith(/animation: bot-/);
    expect(new Set(animated)).toEqual(
      new Set(LAYER_CLASSES.filter((name) => !STILL_LAYERS.includes(name))),
    );
    for (const name of animated) {
      expect(CSS).toMatch(
        new RegExp(`\\.${name} \\{\\s*animation: ${name} [\\d.]+s step-end infinite;`),
      );
      expect(CSS).toContain(`@keyframes ${name} {`);
    }
  });

  it('turns every animated class off under reduced motion', () => {
    const reduced = new Set([...REDUCED.matchAll(/\.(bot-[a-z0-9-]+)/g)].map((match) => match[1]));
    expect(reduced).toEqual(new Set(classesWith(/animation: bot-/)));
  });

  it('hides exactly the frames that are not first, so a still bot shows each loop’s first frame', () => {
    const hidden = classesWith(/opacity: 0;/);
    expect(new Set(hidden)).toEqual(
      new Set([
        'bot-typing-b',
        'bot-blink',
        'bot-z-big',
        'bot-thought-2',
        'bot-thought-3',
        'bot-steam-b',
      ]),
    );
    for (const name of hidden) {
      expect(CSS, name).toMatch(new RegExp(`@keyframes ${name} \\{\\s*0% \\{\\s*opacity: 0;`));
    }
    for (const name of classesWith(/animation: bot-/).filter((name) => !hidden.includes(name))) {
      expect(CSS, name).toMatch(new RegExp(`@keyframes ${name} \\{\\s*0% \\{\\s*opacity: 1;`));
    }
  });

  it('offsets phases 1–3 by a delay class, and a still bot drops every animation', () => {
    for (const phase of [1, 2, 3]) {
      expect(CSS).toMatch(new RegExp(`\\.bot-phase-${phase} g \\{\\s*animation-delay: -[\\d.]+s;`));
    }
    expect(CSS).toMatch(/\.bot-static g \{\s*animation: none;/);
  });
});

describe('<Bot />', () => {
  it.each(BOT_POSES)('%s is decoration: one group per layer, one rect per run', (pose) => {
    render(<Bot pose={pose} scale={2} />);
    const svg = screen.getByTestId('bot');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${BOT_STAGE_COLS} ${BOT_STAGE_ROWS}`);
    expect(svg.getAttribute('width')).toBe(String(BOT_STAGE_COLS * 2));
    expect(svg.getAttribute('height')).toBe(String(BOT_STAGE_ROWS * 2));
    const layers = BOT_POSE_LAYERS[pose];
    expect([...svg.querySelectorAll('g')].map((group) => group.getAttribute('class'))).toEqual(
      layers.map((layer) => layer.className),
    );
    const runs = layers.reduce(
      (sum, layer) => sum + spriteRuns(layer.grid, layer.cols, layer.rows, pose).length,
      0,
    );
    expect(svg.querySelectorAll('rect')).toHaveLength(runs);
    for (const rect of svg.querySelectorAll('rect')) {
      expect(Object.values(SPRITE_INKS)).toContain(rect.getAttribute('class'));
    }
  });

  it('carries no URL, no style attribute and nothing focusable', () => {
    render(
      <div>
        {BOT_POSES.map((pose) => (
          <Bot key={pose} pose={pose} />
        ))}
      </div>,
    );
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute).not.toMatch(/href|src|style|tabindex|action|data$/i);
      }
    }
  });

  it('maps phase to a delay class and animated={false} to the still class', () => {
    render(<Bot pose="typing" phase={2} animated={false} />);
    const classes = screen.getByTestId('bot').getAttribute('class')?.split(' ') ?? [];
    expect(classes).toContain('bot-phase-2');
    expect(classes).toContain('bot-static');
    cleanup();
    render(<Bot pose="typing" />);
    expect(screen.getByTestId('bot').getAttribute('class')?.split(' ')).toEqual([
      'block',
      'bot-phase-0',
    ]);
  });
});
