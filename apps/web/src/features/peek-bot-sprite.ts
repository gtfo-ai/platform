/**
 * The sign-in page's mascot: a small robot hiding behind the form block that pops up over its top
 * edge, waves, ducks, and peeks again. Pure data and one pure function; `peek-bot.tsx` draws it and
 * `styles.css` (`peek-bot-*` keyframes) moves it.
 *
 * It is the platform's own character in the page's `--signin-*` palette — a toy-like helmet, a
 * lit visor, beacon-amber eyes and antenna — not any existing game's mascot.
 *
 * ## Where the pixels came from
 *
 * Drawn with local models in ComfyUI: one Z-Image Turbo render of the character (the waving
 * frame), and two Qwen-Image-Edit 2511 edits of it (the other half of the wave; both hands on the
 * ledge), so the three frames are one character. Each was then cut at the ledge, reduced to one
 * sprite pixel per 24 source pixels by majority vote (never an average, which would invent
 * in-between colours), and snapped to the nearest `--signin-*` colour in CIELAB. By hand
 * afterwards: the eyes were redrawn as one symmetric 5 × 5 shape (the grid split them unevenly),
 * and rows 0–20 — above any arm — are the peek frame's in all three, so nothing flickers on a swap.
 * The workflows, the prompts and the scripts are in `docs/research/18-sign-in-mascot/`.
 *
 * Every layer is a grid, one character per sprite pixel, written without trailing transparent
 * cells. A sprite pixel is {@link PEEK_BOT_PIXEL_CSS_PX} CSS px — the dither field's cell — so the
 * bot sits on the same grid as the field behind it. The bottom row is the block's top edge.
 */

/** One sprite pixel, in CSS px: the dither field's `DITHER_CELL_CSS_PX`. */
export const PEEK_BOT_PIXEL_CSS_PX = 5;
export const PEEK_BOT_COLS = 37;
export const PEEK_BOT_ROWS = 35;

/**
 * Each character's Tailwind fill class, over the `--signin-*` tokens. Literal class names, so
 * Tailwind's scanner finds them.
 */
export const PEEK_BOT_INKS = {
  N: 'fill-signin-night',
  L: 'fill-signin-lit',
  D: 'fill-signin-edge',
  S: 'fill-signin-muted',
  W: 'fill-signin-text',
  E: 'fill-signin-beacon',
} as const;

export type PeekBotInk = keyof typeof PEEK_BOT_INKS;

/** Both hands on the edge: rising, looking around, ducking. */
export const PEEK_BOT_PEEK: readonly string[] = [
  '',
  '.......LL',
  '......NEEE',
  '.....LEEEEL',
  '.....LEEEEL',
  '......NEEEL....LLLLLLLLLLL',
  '.......LLLL..LLWWWWWWWWWWSLL',
  '..........LLLWWWWWWWWWWWWWWSLL',
  '..........LWWWWWWWWWWWWWWWWWSSL',
  '.........LWWWWWWWWWWWWWWWWWWWSSL',
  '........LWWWWWWWWWWWWWWWWWWWWWSSL',
  '........WWWWWWLLLLLLLLLLLLWWWWWSSL',
  '.......LWWWWLLSSLLLLLLLLLLLLWWWSSL',
  '.......WWWWLLSLLLLLLLLLLLLLLLLWWSS',
  '......LWWWLLSLLLLLLLLLLLLLLLLLWWSSL',
  '.....LLWWWLLLLLLLLLLLLLLLLLLLLLWSSLL',
  '.....LLLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '.....DDLWWLLLEEELLLLLLLLLEEELLLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLLEEELLLLLLLLLEEELLLWSSLDL',
  '.....LDLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '.....LLWWWLLLLLLLLLLLLLLLLLLLLWWSSLL',
  '......LLWWWLLLLLLLLLLLLLLLLLLLWSSLL',
  '.......LWWWWLLLLLLLLLLLLLLLLLWSSSL',
  '........LWWWWWLLLLLLLLLLLLWWWWSSL',
  '........LSSWWWWWWWWWWWWWWWWWSSSSL',
  '.........LSSSWWWWWWWWWWWWWWSSSSL',
  '..........LLSSSSSWWWWWWSSSSSSLL',
  '...........LLLSSSSSSSSSSSSSLLL',
  '..........LWSLLLLLLLLLLLLLLSSL',
  '........LLLWSWWLSSSSSSSSSLSLSLLL',
  '.......LWWWLLWWWLLEEEELLWWSLLWWWLL',
  '......LWWWWWLWWWWWEEEELWWWSLWWWWWL',
];

/** Waving, hand up beside the visor. */
export const PEEK_BOT_WAVE_A: readonly string[] = [
  '',
  '.......LL',
  '......NEEE',
  '.....LEEEEL',
  '.....LEEEEL',
  '......NEEEL....LLLLLLLLLLL',
  '.......LLLL..LLWWWWWWWWWWSLL',
  '..........LLLWWWWWWWWWWWWWWSLL',
  '..........LWWWWWWWWWWWWWWWWWSSL',
  '.........LWWWWWWWWWWWWWWWWWWWSSL',
  '........LWWWWWWWWWWWWWWWWWWWWWSSL',
  '........WWWWWWLLLLLLLLLLLLWWWWWSSL',
  '.......LWWWWLLSSLLLLLLLLLLLLWWWSSL',
  '.......WWWWLLSLLLLLLLLLLLLLLLLWWSS',
  '......LWWWLLSLLLLLLLLLLLLLLLLLWWSSL',
  '.....LLWWWLLLLLLLLLLLLLLLLLLLLLWSSLL',
  '.....LLLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '.....DDLWWLLLEEELLLLLLLLLEEELLLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '....LLLLWWLLLEEELLLLLLLLLEEELLLWSSDDL',
  '...LWWWLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '...WWWWLWWLLLLLLLLLLLLLLLLLLLLWWSSLL',
  '..LWWWWWWLWLLLLLLLLLLLLLLLLLLLWSSLL',
  '..LWWWWWWLWWLLLLLLLLLLLLLLLLLWSSSL',
  '...LWWWWLLLWWWLLLLLLLLLLLLWWWWSSL',
  '...LLSSLWWLWWWWWWWWWWWWWWWWWSSSSL',
  '.....LLWWWWLSWWWWWWWWWWWWWWSSSSL',
  '......LSWWWWLSSSSWWWWWWSSSSSSLL',
  '.......LSWWWLLSSSSSSSSSSSSSLL',
  '........LSSWSLLLLLLLLLLLLLLLL',
  '.........LLSSWWLSSSSSSSSSLSLSL',
  '...........LLWWWLLLEEELLWWSLSWL',
  '............LWWWWWEEEELWWWSLSWWL',
];

/** Waving, hand out — the other half of the wave. */
export const PEEK_BOT_WAVE_B: readonly string[] = [
  '',
  '.......LL',
  '......NEEE',
  '.....LEEEEL',
  '.....LEEEEL',
  '......NEEEL....LLLLLLLLLLL',
  '.......LLLL..LLWWWWWWWWWWSLL',
  '..........LLLWWWWWWWWWWWWWWSLL',
  '..........LWWWWWWWWWWWWWWWWWSSL',
  '.........LWWWWWWWWWWWWWWWWWWWSSL',
  '........LWWWWWWWWWWWWWWWWWWWWWSSL',
  '........WWWWWWLLLLLLLLLLLLWWWWWSSL',
  '.......LWWWWLLSSLLLLLLLLLLLLWWWSSL',
  '.......WWWWLLSLLLLLLLLLLLLLLLLWWSS',
  '......LWWWLLSLLLLLLLLLLLLLLLLLWWSSL',
  '.....LLWWWLLLLLLLLLLLLLLLLLLLLLWSSLL',
  '.....LLLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '.....DDLWWLLLEEELLLLLLLLLEEELLLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....DDLWWLLEEEEELLLLLLLEEEEELLWSSLDL',
  '.....LLLWWLLLEEELLLLLLLLLEEELLLWSSLDL',
  '....LWLLWWLLLLLLLLLLLLLLLLLLLLLWSSLDL',
  '..LWLWLLWWLLLLLLLLLLLLLLLLLLLLWWSSLL',
  '..LWWWWWWLWLLLLLLLLLLLLLLLLLLLWSSLL',
  '.NWLWWWWWLWWLLLLLLLLLLLLLLLLLWSSSL',
  '.LWWWWWWWLWWWWLLLLLLLLLLLLWWWWSSL',
  '..LSWWWWSLLWWWWWWWWWWWWWWWWWSSSSL',
  '...LSWWSLWLSSWWWWWWWWWWWWWWSSSSL',
  '....LLLLWWWLSSSSSWWWWWWSSSSSSLL',
  '......LSWWWWWLSSSSSSSSSSSSSLL',
  '.......LSSWWWLLLLLLLLLLLLLLLL',
  '........LSSSWWWLSSSSSSSSSSSLSL',
  '..........LLLWWWLLEEEELLWWSLSWL',
  '............LWWWWWEEEELWWWSLSWWL',
];

/** Drawn over any frame: the eyes closed to one line. */
export const PEEK_BOT_BLINK: readonly string[] = [
  ...Array<string>(17).fill(''),
  '............LLLLL.......LLLLL',
  '............LLLLL.......LLLLL',
  '............EEEEE.......EEEEE',
  '............LLLLL.......LLLLL',
  '............LLLLL.......LLLLL',
];

/** A horizontal run of same-ink pixels: one `<rect>`. */
export interface PeekBotRun {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly ink: PeekBotInk;
}

const isInk = (char: string): char is PeekBotInk => Object.hasOwn(PEEK_BOT_INKS, char);

/**
 * A layer as horizontal runs, so a frame is about a hundred rects rather than a thousand. Throws on
 * a row wider than the grid, a layer taller than it, or a character that is neither `.` nor an ink:
 * a typo in a hand-edited grid should fail the unit tier rather than draw a hole.
 */
export const peekBotRuns = (layer: readonly string[]): PeekBotRun[] => {
  if (layer.length > PEEK_BOT_ROWS) {
    throw new Error(`peek-bot layer has ${layer.length} rows, the grid has ${PEEK_BOT_ROWS}`);
  }
  const runs: PeekBotRun[] = [];
  layer.forEach((row, y) => {
    if (row.length > PEEK_BOT_COLS) {
      throw new Error(`peek-bot row ${y} is ${row.length} wide, the grid is ${PEEK_BOT_COLS}`);
    }
    let x = 0;
    while (x < row.length) {
      const char = row[x] ?? '.';
      if (char === '.') {
        x += 1;
        continue;
      }
      if (!isInk(char)) {
        throw new Error(`peek-bot row ${y} has ${JSON.stringify(char)} at column ${x}`);
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
