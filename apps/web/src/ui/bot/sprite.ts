/**
 * The mascot's sprite format, shared by the sign-in peek bot (`features/peek-bot-sprite.ts`) and the
 * office bot and props (`bot-sprites.ts`, `props-sprites.ts`).
 *
 * A layer is a grid of text rows, one character per sprite pixel: `.` is transparent and each other
 * character is one of six inks over the `--signin-*` tokens. Rows are written without trailing
 * transparent cells, so a row may be shorter than the grid and a layer may have fewer rows than it
 * (an overlay such as a blink). A layer is drawn as horizontal runs of one ink — one SVG `<rect>`
 * each — so a frame is about a hundred rects rather than a thousand.
 *
 * Pure data and one pure function, with no dependency: `ui/bot/` is imported by the worker's local
 * page, whose entry has a 120 kB budget (TD-033 decision 10).
 */

/**
 * Each character's Tailwind fill class, over the `--signin-*` tokens. Literal class names, so
 * Tailwind's scanner finds them.
 */
export const SPRITE_INKS = {
  N: 'fill-signin-night',
  L: 'fill-signin-lit',
  D: 'fill-signin-edge',
  S: 'fill-signin-muted',
  W: 'fill-signin-text',
  E: 'fill-signin-beacon',
} as const;

export type SpriteInk = keyof typeof SPRITE_INKS;

/** A horizontal run of same-ink pixels: one `<rect>`. */
export interface SpriteRun {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly ink: SpriteInk;
}

const isInk = (char: string): char is SpriteInk => Object.hasOwn(SPRITE_INKS, char);

/**
 * A layer as horizontal runs. Throws on a row wider than the grid, a layer taller than it, or a
 * character that is neither `.` nor an ink: a typo in a hand-edited grid should fail the test tier
 * rather than draw a hole. `label` names the sprite in the message.
 */
export const spriteRuns = (
  layer: readonly string[],
  cols: number,
  rows: number,
  label: string,
): SpriteRun[] => {
  if (layer.length > rows) {
    throw new Error(`${label} layer has ${layer.length} rows, the grid has ${rows}`);
  }
  const runs: SpriteRun[] = [];
  layer.forEach((row, y) => {
    if (row.length > cols) {
      throw new Error(`${label} row ${y} is ${row.length} wide, the grid is ${cols}`);
    }
    let x = 0;
    while (x < row.length) {
      const char = row[x] ?? '.';
      if (char === '.') {
        x += 1;
        continue;
      }
      if (!isInk(char)) {
        throw new Error(`${label} row ${y} has ${JSON.stringify(char)} at column ${x}`);
      }
      let end = x + 1;
      while (row[end] === char) {
        end += 1;
      }
      runs.push({ x, y, width: end - x, ink: char });
      x = end;
    }
  });
  return runs;
};
