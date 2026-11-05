/**
 * The office's own props (TD-033 decision 8 (c)), hand-drawn in the mascot's six inks (`N L D S W E`,
 * `ui/bot/sprite.ts`) on the bot's pixel grid, so a prop and the bot share one sprite pixel: the
 * **bench** the waiting runs sit on (BACKLOG 806: TD-033's "on the bench" had no prop), the **help
 * desk's counter** the agents that need you stand behind, the **door** of each room, and the help
 * desk's **beacon lamp**. Pure data and pure functions, no dependency, like `ui/bot/`.
 *
 * The bench and the counter are drawn at a given width so a row of bots shares one; both are
 * placed on the bot's stage rows (0 … 35) — the bench behind the bot from the hips down, the counter
 * in front of it from the waist down.
 */
import { BOT_ROWS } from '../../ui/bot/bot-sprites.js';

/** The row the bench's seat starts on: the bot's hips. */
export const BENCH_TOP_ROW = 26;

/**
 * A bench `cols` wide, as a full-height layer on the bot's stage (rows above it empty): an outlined
 * plank — a highlight, the wood, its shadow — and a pair of legs at each end and every 40 columns.
 */
export const benchGrid = (cols: number): readonly string[] => {
  const width = Math.max(8, cols);
  const rows: string[] = Array.from({ length: BENCH_TOP_ROW }, () => '');
  rows.push('N'.repeat(width));
  rows.push(`N${'S'.repeat(width - 2)}N`);
  rows.push(`N${'D'.repeat(width - 2)}N`);
  rows.push(`N${'L'.repeat(width - 2)}N`);
  rows.push('N'.repeat(width));
  const legs = [2, width - 5];
  for (let column = 38; column < width - 10; column += 40) {
    legs.push(column);
  }
  const leg = (fill: string): string => {
    const cells = Array.from({ length: width }, () => '.');
    for (const column of legs) {
      cells[column] = 'N';
      cells[column + 1] = fill;
      cells[column + 2] = 'N';
    }
    return cells.join('').replace(/\.+$/, '');
  };
  while (rows.length < BOT_ROWS - 1) {
    rows.push(leg('D'));
  }
  rows.push(leg('N'));
  return rows;
};

/** The row the help desk's counter starts on: the bot's waist. */
export const COUNTER_TOP_ROW = 22;

/**
 * The help desk's counter `cols` wide, in front of the bots behind it: a lit top with a beacon trim,
 * a front of panels, a base.
 */
export const counterGrid = (cols: number): readonly string[] => {
  const width = Math.max(8, cols);
  const rows: string[] = Array.from({ length: COUNTER_TOP_ROW }, () => '');
  rows.push('N'.repeat(width));
  rows.push(`N${'W'.repeat(width - 2)}N`);
  rows.push(`N${'S'.repeat(width - 2)}N`);
  rows.push(`N${'E'.repeat(width - 2)}N`);
  rows.push('N'.repeat(width));
  const panel = (column: number): string =>
    column === 0 || column === width - 1 ? 'N' : column % 12 === 0 ? 'N' : 'D';
  while (rows.length < BOT_ROWS - 2) {
    rows.push(Array.from({ length: width }, (_, column) => panel(column)).join(''));
  }
  rows.push(`N${'L'.repeat(width - 2)}N`);
  rows.push('N'.repeat(width));
  return rows;
};

/** A room's door, 16 × 28: a frame, two lit panels, a beacon knob and a small window. */
export const DOOR_COLS = 16;
export const DOOR_ROWS = 28;
export const DOOR: readonly string[] = [
  'NNNNNNNNNNNNNNNN',
  'NLLLLLLLLLLLLLLN',
  'NLNNNNNNNNNNNNLN',
  'NLNDDDDDDDDDDNLN',
  'NLNDNNNNNNNNDNLN',
  'NLNDNSSSSSSNDNLN',
  'NLNDNSWWWWSNDNLN',
  'NLNDNSSSSSSNDNLN',
  'NLNDNNNNNNNNDNLN',
  'NLNDDDDDDDDDDNLN',
  'NLNDLLLLLLLLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLLLLLLLLDNLN',
  'NLNDDDDDDDDDDNLN',
  'NLNDDDDDDDDNEELN',
  'NLNDDDDDDDDNEELN',
  'NLNDDDDDDDDDDNLN',
  'NLNDLLLLLLLLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLDDDDDDLDNLN',
  'NLNDLLLLLLLLDNLN',
  'NLNDDDDDDDDDDNLN',
  'NLNNNNNNNNNNNNLN',
  'NLLLLLLLLLLLLLLN',
  'NNNNNNNNNNNNNNNN',
];

/** The help desk's beacon lamp, 9 × 12: a lit globe on a stand. The glow is its own layer. */
export const LAMP_COLS = 9;
export const LAMP_ROWS = 12;
export const LAMP: readonly string[] = [
  '...NNN',
  '..NEEEN',
  '.NEEWEEN',
  '.NEEEEEN',
  '..NEEEN',
  '...NNN',
  '....N',
  '....N',
  '....N',
  '..NNNNN',
  '.NSSSSSN',
  '.NNNNNNN',
];

/** The lamp's glow, around the globe: blinked by `office.css`, lit and still under reduced motion. */
export const LAMP_GLOW: readonly string[] = ['.E.....E', '', '', 'E.......E', '', '.E.....E'];
