/**
 * One seat of the pixel office (TD-033 decision 8(c)): the bot behind a desk, a laptop on it, an
 * optional mug and plant, with a speech-bubble slot above ("Now: Reading files") and a nameplate
 * slot below. Presentational only — the room, what a seat shows and where it sits are the Agents
 * page's (S-23.6) and the worker's local page's.
 *
 * The scene is one SVG on the bot's pixel grid: the bot's stage at column {@link SEAT_BOT_X}, the
 * desk's top edge from row {@link SEAT_DESK_ROW} to the bottom, which hides the bot's lap and legs
 * (the scene is cut there). The laptop shows its **lit screen**, in front of the bot, while it types
 * or thinks, and its dark **lid**, pushed to the left of the desk, otherwise — so a working seat
 * reads from across the room and an idle bot's hands (the mug, the cheer) stay in view. The desk mug
 * is left out while the bot sips from its own.
 *
 * The slots take React nodes and are rendered as React children, so untrusted text (a ticket
 * title, a progress line) reaches them as text through `ui/untrusted.tsx` (BD-022); nothing here
 * turns a string into markup. The drawing is `aria-hidden`; the slots are what a screen reader
 * reads.
 */
import type { ReactElement, ReactNode } from 'react';
import { BotLayers, type BotPhase, type BotScale, botRootClass } from './bot.js';
import type { BotPose } from './poses.js';
import {
  PROP_DESK_EDGE,
  PROP_DESK_EDGE_ROWS,
  PROP_LAPTOP_BACK,
  PROP_LAPTOP_BACK_COLS,
  PROP_LAPTOP_BACK_ROWS,
  PROP_LAPTOP_FRONT,
  PROP_LAPTOP_FRONT_COLS,
  PROP_LAPTOP_FRONT_ROWS,
  PROP_MUG,
  PROP_MUG_COLS,
  PROP_MUG_ROWS,
  PROP_PLANT,
  PROP_PLANT_COLS,
  PROP_PLANT_ROWS,
} from './props-sprites.js';
import { SPRITE_INKS, type SpriteRun, spriteRuns } from './sprite.js';

/** The scene, in sprite pixels: the desk's width and the bot down to the desk's bottom edge. */
export const SEAT_COLS = 60;
export const SEAT_DESK_ROW = 28;
export const SEAT_ROWS = SEAT_DESK_ROW + PROP_DESK_EDGE_ROWS;
/** Where the bot's stage starts; its body is then columns 21–40, centred on the desk. */
export const SEAT_BOT_X = 14;

/** The poses in which the bot is at its laptop. */
export const LAPTOP_IN_USE: Readonly<Record<BotPose, boolean>> = {
  typing: true,
  thinking: true,
  sleeping: false,
  raise_hand: false,
  cheer: false,
  confused: false,
  slumped: false,
  sipping: false,
};

interface Placed {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly runs: readonly SpriteRun[];
}

const place = (
  key: string,
  grid: readonly string[],
  cols: number,
  rows: number,
  x: number,
  y: number,
): Placed => ({ key, x, y, runs: spriteRuns(grid, cols, rows, `seat ${key}`) });

const DESK = place(
  'desk',
  PROP_DESK_EDGE.map((row) => row.repeat(Math.ceil(SEAT_COLS / row.length)).slice(0, SEAT_COLS)),
  SEAT_COLS,
  PROP_DESK_EDGE_ROWS,
  0,
  SEAT_DESK_ROW,
);

const LAPTOP_OPEN = place(
  'laptop-front',
  PROP_LAPTOP_FRONT,
  PROP_LAPTOP_FRONT_COLS,
  PROP_LAPTOP_FRONT_ROWS,
  SEAT_BOT_X + 9,
  SEAT_DESK_ROW - PROP_LAPTOP_FRONT_ROWS,
);

const LAPTOP_SHUT = place(
  'laptop-back',
  PROP_LAPTOP_BACK,
  PROP_LAPTOP_BACK_COLS,
  PROP_LAPTOP_BACK_ROWS,
  2,
  SEAT_DESK_ROW - PROP_LAPTOP_BACK_ROWS,
);

const MUG = place('mug', PROP_MUG, PROP_MUG_COLS, PROP_MUG_ROWS, 42, SEAT_DESK_ROW - PROP_MUG_ROWS);

const PLANT = place(
  'plant',
  PROP_PLANT,
  PROP_PLANT_COLS,
  PROP_PLANT_ROWS,
  51,
  SEAT_DESK_ROW - PROP_PLANT_ROWS,
);

const Prop = ({ placed }: { readonly placed: Placed }): ReactElement => (
  <g className={`seat-${placed.key}`} transform={`translate(${placed.x} ${placed.y})`}>
    {placed.runs.map((run) => (
      <rect
        key={`${run.x}:${run.y}`}
        x={run.x}
        y={run.y}
        width={run.width}
        height={1}
        className={SPRITE_INKS[run.ink]}
      />
    ))}
  </g>
);

export interface SeatProps {
  readonly pose: BotPose;
  /** CSS px per sprite pixel. */
  readonly scale?: BotScale;
  readonly phase?: BotPhase;
  /** Off: each animation's first frame, still. */
  readonly animated?: boolean;
  readonly mug?: boolean;
  readonly plant?: boolean;
  /** The speech bubble's content, e.g. "Now: Reading files". Nothing is drawn without it. */
  readonly bubble?: ReactNode;
  /** The nameplate's content, e.g. worker · project · ticket. Nothing is drawn without it. */
  readonly nameplate?: ReactNode;
  readonly className?: string;
}

export const Seat = ({
  pose,
  scale = 3,
  phase = 0,
  animated = true,
  mug = false,
  plant = false,
  bubble,
  nameplate,
  className = '',
}: SeatProps): ReactElement => {
  const width = SEAT_COLS * scale;
  return (
    <figure
      data-testid="seat"
      data-pose={pose}
      className={`m-0 flex flex-col items-center gap-1 ${className}`.trim()}
      style={{ width }}
    >
      {bubble === undefined ? null : (
        <div
          data-testid="seat-bubble"
          className="max-w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg"
        >
          {bubble}
        </div>
      )}
      <svg
        aria-hidden="true"
        className={`block ${botRootClass(phase, animated)}`}
        width={width}
        height={SEAT_ROWS * scale}
        viewBox={`0 0 ${SEAT_COLS} ${SEAT_ROWS}`}
        shapeRendering="crispEdges"
      >
        <g transform={`translate(${SEAT_BOT_X} 0)`}>
          <BotLayers pose={pose} />
        </g>
        <Prop placed={DESK} />
        <Prop placed={LAPTOP_IN_USE[pose] ? LAPTOP_OPEN : LAPTOP_SHUT} />
        {mug && pose !== 'sipping' ? <Prop placed={MUG} /> : null}
        {plant ? <Prop placed={PLANT} /> : null}
      </svg>
      {nameplate === undefined ? null : (
        <figcaption
          data-testid="seat-nameplate"
          className="max-w-full truncate text-xs text-fg-muted"
        >
          {nameplate}
        </figcaption>
      )}
    </figure>
  );
};
