/**
 * Which layers draw each of the office bot's poses, where, and under which CSS class — the data
 * `bot.tsx` renders and `bot.css` animates. Pure data, no dependency (`sprite.ts` says why).
 *
 * A pose is its body frame(s), an optional blink and its effects (the `Z`s, the thought trail, a
 * bubble, steam), each a layer at a position on the **stage**: the bot's own 34 × 36 grid with
 * {@link BOT_STAGE_COLS} − 34 columns added on the right, where the effects go so that none covers
 * the bot. Every layer's class is a `bot-*` class; an animated one is listed in `bot.css`, whose
 * base styles show each animation's **first** frame, so `prefers-reduced-motion` and a still bot
 * draw that frame.
 *
 * Which activity shows which pose is TD-033 decision 6's table and belongs to the activity
 * vocabulary (`activity.ts`), not here.
 */
import {
  BOT_BLINK,
  BOT_CHEER,
  BOT_COLS,
  BOT_CONFUSED,
  BOT_RAISE_HAND,
  BOT_ROWS,
  BOT_SIPPING,
  BOT_SLEEPING,
  BOT_SLUMPED,
  BOT_THINKING,
  BOT_TYPING,
  BOT_TYPING_B,
} from './bot-sprites.js';
import {
  PROP_BUBBLE_EXCLAIM,
  PROP_BUBBLE_EXCLAIM_COLS,
  PROP_BUBBLE_EXCLAIM_ROWS,
  PROP_BUBBLE_QUESTION,
  PROP_BUBBLE_QUESTION_COLS,
  PROP_BUBBLE_QUESTION_ROWS,
  PROP_STEAM_A,
  PROP_STEAM_B,
  PROP_STEAM_COLS,
  PROP_STEAM_ROWS,
  PROP_THOUGHT_1,
  PROP_THOUGHT_2,
  PROP_THOUGHT_3,
  PROP_THOUGHT_COLS,
  PROP_THOUGHT_ROWS,
  PROP_Z_BIG,
  PROP_Z_BIG_COLS,
  PROP_Z_BIG_ROWS,
  PROP_Z_SMALL,
  PROP_Z_SMALL_COLS,
  PROP_Z_SMALL_ROWS,
} from './props-sprites.js';

/** The poses; TD-033 decision 6's table says which activity shows which. */
export const BOT_POSES = [
  'typing',
  'thinking',
  'sleeping',
  'raise_hand',
  'cheer',
  'confused',
  'slumped',
  'sipping',
] as const;

export type BotPose = (typeof BOT_POSES)[number];

/** The stage: the bot's grid plus six columns on the right for the bubbles, `Z`s and thoughts. */
export const BOT_STAGE_COLS = 40;
export const BOT_STAGE_ROWS = BOT_ROWS;

/** One grid drawn at (`x`, `y`) on the stage, under one `bot-*` class. */
export interface BotLayer {
  readonly className: string;
  readonly grid: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly x: number;
  readonly y: number;
}

const body = (className: string, grid: readonly string[]): BotLayer => ({
  className,
  grid,
  cols: BOT_COLS,
  rows: BOT_ROWS,
  x: 0,
  y: 0,
});

/**
 * {@link BOT_BLINK} with its eye box moved to start at `top`. The box is always columns 12–14 and
 * 19–21; the four front-facing poses have it at row 12, cheer one row higher and thinking's eyes,
 * looking up, at rows 9–11 (box from row 8).
 */
export const blinkAt = (top: number): readonly string[] => {
  const lines = BOT_BLINK.filter((row) => row !== '');
  return [...Array<string>(top).fill(''), ...lines];
};

const blink = (top: number): BotLayer => body('bot-blink', blinkAt(top));

const prop = (
  className: string,
  grid: readonly string[],
  cols: number,
  rows: number,
  x: number,
  y: number,
): BotLayer => ({ className, grid, cols, rows, x, y });

const thought = (frame: 1 | 2 | 3, grid: readonly string[]): BotLayer =>
  prop(`bot-thought-${frame}`, grid, PROP_THOUGHT_COLS, PROP_THOUGHT_ROWS, 26, 0);

const steam = (frame: 'a' | 'b', grid: readonly string[]): BotLayer =>
  prop(`bot-steam-${frame}`, grid, PROP_STEAM_COLS, PROP_STEAM_ROWS, 15, 13);

/**
 * Every pose's layers, back to front. The blink is listed only where the pose's eyes are open on
 * the blink's columns (confused's tilted eyes are not; sleeping's and slumped's are not open).
 * Sipping's steam rises from the mug in front of the visor, so it is the one effect drawn over the
 * bot — over visor and eye cells only, which `sprites.test.ts` holds.
 */
export const BOT_POSE_LAYERS: Readonly<Record<BotPose, readonly BotLayer[]>> = {
  typing: [body('bot-typing-a', BOT_TYPING), body('bot-typing-b', BOT_TYPING_B), blink(12)],
  thinking: [
    body('bot-body', BOT_THINKING),
    blink(8),
    thought(1, PROP_THOUGHT_1),
    thought(2, PROP_THOUGHT_2),
    thought(3, PROP_THOUGHT_3),
  ],
  sleeping: [
    body('bot-body', BOT_SLEEPING),
    prop('bot-z-small', PROP_Z_SMALL, PROP_Z_SMALL_COLS, PROP_Z_SMALL_ROWS, 27, 6),
    prop('bot-z-big', PROP_Z_BIG, PROP_Z_BIG_COLS, PROP_Z_BIG_ROWS, 31, 0),
  ],
  raise_hand: [
    body('bot-body', BOT_RAISE_HAND),
    blink(12),
    prop(
      'bot-exclaim',
      PROP_BUBBLE_EXCLAIM,
      PROP_BUBBLE_EXCLAIM_COLS,
      PROP_BUBBLE_EXCLAIM_ROWS,
      31,
      0,
    ),
  ],
  cheer: [body('bot-body', BOT_CHEER), blink(11)],
  confused: [
    body('bot-body', BOT_CONFUSED),
    prop(
      'bot-question',
      PROP_BUBBLE_QUESTION,
      PROP_BUBBLE_QUESTION_COLS,
      PROP_BUBBLE_QUESTION_ROWS,
      28,
      0,
    ),
  ],
  slumped: [body('bot-body', BOT_SLUMPED)],
  sipping: [
    body('bot-body', BOT_SIPPING),
    blink(12),
    steam('a', PROP_STEAM_A),
    steam('b', PROP_STEAM_B),
  ],
};
