/**
 * Props for the agent-office scene, in the mascot's six inks (`N L D S W E` — night, lit, edge,
 * muted, text, beacon; see `sprite.ts`). Hand-drawn on the same pixel grid as the bot
 * sprites in `bot-sprites.ts`, so a prop and the bot share one sprite pixel. Every grid is one
 * character per sprite pixel, written without trailing transparent cells; `.` is transparent.
 */

/** The laptop as the viewer sees it while the bot types behind it: the back of the lid. */
export const PROP_LAPTOP_BACK_COLS = 16;
export const PROP_LAPTOP_BACK_ROWS = 10;
export const PROP_LAPTOP_BACK: readonly string[] = [
  '.NNNNNNNNNNNNNN',
  'NSSSSSSSSSSSSSSN',
  'NDDDDDDDDDDDDDDN',
  'NDDDDDDDDDDDDDDN',
  'NDDDDDDEEDDDDDDN',
  'NDDDDDDEEDDDDDDN',
  'NDDDDDDDDDDDDDDN',
  'NDDDDDDDDDDDDDDN',
  'NLLLLLLLLLLLLLLN',
  'NNNNNNNNNNNNNNNN',
];

/** The laptop facing the viewer: a lit screen with amber code lines, and the keyboard deck. */
export const PROP_LAPTOP_FRONT_COLS = 16;
export const PROP_LAPTOP_FRONT_ROWS = 12;
export const PROP_LAPTOP_FRONT: readonly string[] = [
  '.NNNNNNNNNNNNNN',
  'NDDDDDDDDDDDDDDN',
  'NDNNNNNNNNNNNNDN',
  'NDNEEENLLLNNNNDN',
  'NDNNNLLLLNEENNDN',
  'NDNNNLLNEEEENNDN',
  'NDNEENLLLNNNNNDN',
  'NDNNNNNNNNNNNNDN',
  'NDDDDDDDDDDDDDDN',
  'NNNNNNNNNNNNNNNN',
  'NSSSSSSSSSSSSSSN',
  '.NNNNNNNNNNNNNN',
];

/** A desk's top edge, tileable horizontally: highlight lip, top, front face, shadow. */
export const PROP_DESK_EDGE_COLS = 8;
export const PROP_DESK_EDGE_ROWS = 5;
export const PROP_DESK_EDGE: readonly string[] = [
  'SSSSSSSS',
  'DDDDDDDD',
  'DDDDDDDD',
  'LLLLLLLL',
  'NNNNNNNN',
];

/** A coffee mug on the desk, handle to the right, an amber band. */
export const PROP_MUG_COLS = 9;
export const PROP_MUG_ROWS = 8;
export const PROP_MUG: readonly string[] = [
  'NNNNNNN',
  'NLLLLLN',
  'NWWWWWNNN',
  'NEEEEENWN',
  'NWWWWWNWN',
  'NWWWWWNNN',
  'NSWWWSN',
  '.NNNNN',
];

/** Steam over the mug, drawn above {@link PROP_MUG} (two frames: sway left, sway right). */
export const PROP_STEAM_COLS = 5;
export const PROP_STEAM_ROWS = 4;
// biome-ignore format: a sprite grid reads as one row per line
export const PROP_STEAM_A: readonly string[] = [
  '.S..S',
  'S..S',
  '.S..S',
  'S..S',
];
// biome-ignore format: a sprite grid reads as one row per line
export const PROP_STEAM_B: readonly string[] = [
  'S..S',
  '.S..S',
  'S..S',
  '.S..S',
];

/** "Z", small: the first of the rising sleep letters. */
export const PROP_Z_SMALL_COLS = 4;
export const PROP_Z_SMALL_ROWS = 4;
// biome-ignore format: a sprite grid reads as one row per line
export const PROP_Z_SMALL: readonly string[] = [
  'WWWW',
  '..W',
  '.W',
  'WWWW',
];

/** "Z", big. */
export const PROP_Z_BIG_COLS = 6;
export const PROP_Z_BIG_ROWS = 6;
// biome-ignore format: a sprite grid reads as one row per line
export const PROP_Z_BIG: readonly string[] = [
  'WWWWWW',
  '....WS',
  '...WS',
  '..WS',
  '.WS',
  'WWWWWW',
];

/**
 * The thought trail: three dots growing up and to the right (bottom-left nearest the head). The
 * three frames reveal one dot more each, for a "thinking…" loop; the last is the whole trail.
 */
export const PROP_THOUGHT_COLS = 12;
export const PROP_THOUGHT_ROWS = 9;
// biome-ignore format: a sprite grid reads as one row per line
export const PROP_THOUGHT_1: readonly string[] = [
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  'WW',
  'WS',
];
export const PROP_THOUGHT_2: readonly string[] = [
  '',
  '',
  '',
  '....WW',
  '...WWWS',
  '....SS',
  '',
  'WW',
  'WS',
];
export const PROP_THOUGHT_3: readonly string[] = [
  '........WWW',
  '.......WWWWW',
  '.......WWWWS',
  '....WW..SSS',
  '...WWWS',
  '....SS',
  '',
  'WW',
  'WS',
];

/** A speech bubble with an amber "!", tail bottom-left: needs a human. */
export const PROP_BUBBLE_EXCLAIM_COLS = 9;
export const PROP_BUBBLE_EXCLAIM_ROWS = 11;
export const PROP_BUBBLE_EXCLAIM: readonly string[] = [
  '.NNNNNNN',
  'NWWWWWWWN',
  'NWWWEWWWN',
  'NWWWEWWWN',
  'NWWWEWWWN',
  'NWWWEWWWN',
  'NWWWWWWWN',
  'NWWWEWWWN',
  'NWWWWWWWN',
  '.NWNNNNN',
  '.NN',
];

/** A speech bubble with an amber "?", tail bottom-left: stuck. */
export const PROP_BUBBLE_QUESTION_COLS = 9;
export const PROP_BUBBLE_QUESTION_ROWS = 11;
export const PROP_BUBBLE_QUESTION: readonly string[] = [
  '.NNNNNNN',
  'NWWWWWWWN',
  'NWWEEEWWN',
  'NWWWWWEWN',
  'NWWWWEEWN',
  'NWWWEWWWN',
  'NWWWWWWWN',
  'NWWWEWWWN',
  'NWWWWWWWN',
  '.NWNNNNN',
  '.NN',
];

/** A small potted plant: lavender leaves (the palette has no green), an amber pot. */
export const PROP_PLANT_COLS = 9;
export const PROP_PLANT_ROWS = 12;
export const PROP_PLANT: readonly string[] = [
  '....N',
  '...NSN',
  '.N.NSN.N',
  'NSNNWNNSN',
  'NSSNDNSSN',
  '.NSSDSSN',
  '..NNDNN',
  'NNNNNNNNN',
  'NWEEEEEEN',
  '.NEEEEEN',
  '.NEEEEEN',
  '..NNNNN',
];
