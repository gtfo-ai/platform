/**
 * The office bot's hand-edited grids stay drawable and stay one character: every grid parses, the
 * poses share one frame and one pair of legs, the blink touches nothing but eyes, and each effect
 * sits beside the bot rather than on it. `docs/research/18-sign-in-mascot/office-poses.md` is where
 * the grids came from; these are the properties its hand edits promised.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as bot from './bot-sprites.js';
import { BOT_BLINK, BOT_COLS, BOT_ROWS, BOT_SLUMPED } from './bot-sprites.js';
import { BOT_POSE_LAYERS, BOT_POSES, BOT_STAGE_COLS, BOT_STAGE_ROWS, blinkAt } from './poses.js';
import * as props from './props-sprites.js';
import { SPRITE_INKS, spriteRuns } from './sprite.js';

const isGrid = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((row) => typeof row === 'string');

const gridsOf = (module: Record<string, unknown>): [string, readonly string[]][] =>
  Object.entries(module).filter((entry): entry is [string, readonly string[]] => isGrid(entry[1]));

/** grids.py's rule: a grid's size is the `_COLS`/`_ROWS` pair of its longest name prefix. */
const dimsOf = (name: string): { cols: number; rows: number } => {
  if (name.startsWith('BOT_')) {
    return { cols: BOT_COLS, rows: BOT_ROWS };
  }
  const sizes = props as unknown as Record<string, number>;
  let base = name;
  while (sizes[`${base}_COLS`] === undefined && base.includes('_')) {
    base = base.slice(0, base.lastIndexOf('_'));
  }
  const cols = sizes[`${base}_COLS`];
  const rows = sizes[`${base}_ROWS`];
  if (cols === undefined || rows === undefined) {
    throw new Error(`${name} has no _COLS/_ROWS pair`);
  }
  return { cols, rows };
};

const GRIDS = [...gridsOf(bot), ...gridsOf(props)];
const OVERLAYS = new Set(['BOT_BLINK']);
const POSE_GRIDS = gridsOf(bot).filter(([name]) => !OVERLAYS.has(name));
const INKS = Object.keys(SPRITE_INKS).join('');

const inked = (grid: readonly string[], x: number, y: number): string => grid[y]?.[x] ?? '.';

/** Every inked cell of a layer placed at (dx, dy), in stage coordinates. */
const cellsOf = (grid: readonly string[], dx = 0, dy = 0): { x: number; y: number }[] =>
  grid.flatMap((row, y) =>
    [...row].flatMap((char, x) => (char === '.' ? [] : [{ x: x + dx, y: y + dy }])),
  );

describe('every grid', () => {
  it('found both modules’ grids', () => {
    expect(GRIDS).toHaveLength(10 + 14);
  });

  it.each(GRIDS)(
    '%s uses only the six inks, fits its size and has no trailing "."',
    (name, grid) => {
      const { cols, rows } = dimsOf(name);
      if (OVERLAYS.has(name)) {
        expect(grid.length).toBeLessThanOrEqual(rows);
      } else {
        expect(grid).toHaveLength(rows);
      }
      for (const row of grid) {
        expect(row).toMatch(new RegExp(`^[.${INKS}]*$`));
        expect(row.length).toBeLessThanOrEqual(cols);
        expect(row.endsWith('.')).toBe(false);
      }
      const runs = spriteRuns(grid, cols, rows, name);
      expect(runs.reduce((sum, run) => sum + run.width, 0)).toBe(
        grid.join('').replaceAll('.', '').length,
      );
    },
  );
});

describe('the poses', () => {
  it('are one frame: every pose is BOT_COLS × BOT_ROWS', () => {
    expect(POSE_GRIDS).toHaveLength(9);
    for (const [, grid] of POSE_GRIDS) {
      expect(grid).toHaveLength(BOT_ROWS);
      expect(Math.max(...grid.map((row) => row.length))).toBeLessThanOrEqual(BOT_COLS);
    }
  });

  it('share the lower legs and boots (rows 29–35; slumped from 31, its hands hang to 30)', () => {
    const legs = bot.BOT_TYPING.slice(29);
    for (const [name, grid] of POSE_GRIDS) {
      const from = grid === BOT_SLUMPED ? 31 : 29;
      expect(grid.slice(from), name).toEqual(legs.slice(from - 29));
    }
  });

  it('the two typing frames differ only below the head', () => {
    expect(bot.BOT_TYPING_B.slice(0, 25)).toEqual(bot.BOT_TYPING.slice(0, 25));
    expect(bot.BOT_TYPING_B).not.toEqual(bot.BOT_TYPING);
  });

  it('every pose has layers, and BOT_POSES names exactly those', () => {
    expect(Object.keys(BOT_POSE_LAYERS).sort()).toEqual([...BOT_POSES].sort());
  });
});

describe('the blink', () => {
  const EYE_COLUMNS = new Set([12, 13, 14, 19, 20, 21]);

  it('inks nothing outside the eye columns', () => {
    for (const cell of cellsOf(BOT_BLINK)) {
      expect(EYE_COLUMNS.has(cell.x), `column ${cell.x}`).toBe(true);
    }
  });

  it.each(
    BOT_POSES.flatMap((pose) => {
      const layers = BOT_POSE_LAYERS[pose];
      const blink = layers.find((layer) => layer.className === 'bot-blink');
      return blink === undefined ? [] : [[pose, blink.grid, layers] as const];
    }),
  )(
    'over %s lies on eye and visor cells only and hides every eye cell in its box',
    (_, blink, layers) => {
      const cells = cellsOf(blink);
      const top = Math.min(...cells.map((cell) => cell.y));
      const frames = layers.filter((layer) => layer.cols === BOT_COLS && layer.grid !== blink);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        for (const cell of cells) {
          expect(['E', 'L']).toContain(inked(frame.grid, cell.x, cell.y));
        }
        for (let y = top; y < top + 4; y += 1) {
          for (const x of EYE_COLUMNS) {
            if (inked(frame.grid, x, y) === 'E') {
              expect(cells.some((cell) => cell.x === x && cell.y === y)).toBe(true);
            }
          }
        }
      }
    },
  );

  it('is the shipped overlay, moved', () => {
    expect(blinkAt(12)).toEqual(BOT_BLINK);
    expect(blinkAt(8)).toHaveLength(12);
  });
});

describe('the effects', () => {
  it.each(BOT_POSES)('%s: every layer stays on the stage', (pose) => {
    for (const layer of BOT_POSE_LAYERS[pose]) {
      for (const cell of cellsOf(layer.grid, layer.x, layer.y)) {
        expect(cell.x).toBeLessThan(BOT_STAGE_COLS);
        expect(cell.y).toBeLessThan(BOT_STAGE_ROWS);
      }
    }
  });

  it.each(BOT_POSES)(
    '%s: a bubble, Z or thought never covers the bot; steam only its visor',
    (pose) => {
      const [frame, ...rest] = BOT_POSE_LAYERS[pose];
      if (frame === undefined) {
        throw new Error(`${pose} has no layers`);
      }
      for (const layer of rest.filter((layer) => layer.cols !== BOT_COLS)) {
        const under = cellsOf(layer.grid, layer.x, layer.y).map((cell) =>
          inked(frame.grid, cell.x, cell.y),
        );
        const allowed = layer.className.startsWith('bot-steam') ? ['.', 'L', 'E'] : ['.'];
        expect(new Set(under), layer.className).toSatisfy((set: Set<string>) =>
          [...set].every((char) => allowed.includes(char)),
        );
      }
    },
  );
});

describe('ui/bot/', () => {
  it('imports nothing but React and its own files, so the worker entry can carry it', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(here).filter((name) => /\.tsx?$/.test(name))) {
      if (file.includes('.test.')) {
        continue;
      }
      const source = readFileSync(join(here, file), 'utf8');
      for (const match of source.matchAll(/^(?:import|export)[^;]*?from '([^']+)'/gms)) {
        expect(match[1], file).toMatch(/^(?:react|\.\/[\w-]+\.js)$/);
      }
    }
  });
});
