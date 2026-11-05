/**
 * The office bot (TD-033 decision 8(c)): the sign-in mascot sitting, posed by what an agent is
 * doing. Pixels in `bot-sprites.ts` and `props-sprites.ts`, the layers of each pose in `poses.ts`,
 * the motion in `bot.css`.
 *
 * An inline SVG, one `<rect>` per run of same-ink pixels, filled from the `--signin-*` tokens and
 * drawn `crispEdges` — no image, no URL attribute, no `style` attribute. Every layer of the pose is
 * drawn and CSS classes alone decide which shows when: the typing hands alternate, the eyes blink
 * every few seconds, the `Z`s rise, the thought trail grows, the `!` pulses, the steam sways. No
 * timer, nothing to stop on unmount, and the browser throttles it in a hidden tab.
 *
 * `phase` (0–3) shifts every animation of one bot by a class-chosen delay, so a room of seats does
 * not move in lockstep. `animated={false}` and `prefers-reduced-motion: reduce` both show each
 * animation's first frame and nothing moves.
 *
 * Decorative: `aria-hidden`, nothing focusable. What the bot means is said in text beside it
 * (`seat.tsx`'s bubble and nameplate).
 */
import type { ReactElement } from 'react';
import {
  BOT_POSE_LAYERS,
  BOT_POSES,
  BOT_STAGE_COLS,
  BOT_STAGE_ROWS,
  type BotPose,
} from './poses.js';
import { SPRITE_INKS, type SpriteRun, spriteRuns } from './sprite.js';

export { BOT_POSES, type BotPose } from './poses.js';

/** Which of four animation offsets a bot takes (`bot-phase-0` … `bot-phase-3` in `bot.css`). */
export type BotPhase = 0 | 1 | 2 | 3;

/** CSS px per sprite pixel. */
export type BotScale = 2 | 3 | 4;

interface DrawnLayer {
  readonly className: string;
  readonly x: number;
  readonly y: number;
  readonly runs: readonly SpriteRun[];
}

const drawn = (pose: BotPose): readonly DrawnLayer[] =>
  BOT_POSE_LAYERS[pose].map((layer) => ({
    className: layer.className,
    x: layer.x,
    y: layer.y,
    runs: spriteRuns(layer.grid, layer.cols, layer.rows, `${pose} ${layer.className}`),
  }));

/** Every pose's runs, computed once at import, so a typo in a grid fails as the module loads. */
const DRAWN: ReadonlyMap<BotPose, readonly DrawnLayer[]> = new Map(
  BOT_POSES.map((pose) => [pose, drawn(pose)]),
);

/** The class on the root `<svg>` that carries a bot's phase and stillness. */
export const botRootClass = (phase: BotPhase, animated: boolean): string =>
  `bot-phase-${phase}${animated ? '' : ' bot-static'}`;

/**
 * A pose's layers as SVG groups in stage coordinates (0 … {@link BOT_STAGE_COLS}), for an SVG that
 * draws more than the bot — `seat.tsx` places it behind a desk.
 */
export const BotLayers = ({ pose }: { readonly pose: BotPose }): ReactElement => (
  <>
    {(DRAWN.get(pose) ?? []).map((layer) => (
      <g
        key={layer.className}
        className={layer.className}
        transform={layer.x === 0 && layer.y === 0 ? undefined : `translate(${layer.x} ${layer.y})`}
      >
        {layer.runs.map((run) => (
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
    ))}
  </>
);

export interface BotProps {
  readonly pose: BotPose;
  /** CSS px per sprite pixel; the box is {@link BOT_STAGE_COLS} × {@link BOT_STAGE_ROWS} of them. */
  readonly scale?: BotScale;
  /** Off: each animation's first frame, still. */
  readonly animated?: boolean;
  readonly phase?: BotPhase;
  readonly className?: string;
}

export const Bot = ({
  pose,
  scale = 3,
  animated = true,
  phase = 0,
  className = '',
}: BotProps): ReactElement => (
  <svg
    aria-hidden="true"
    data-testid="bot"
    data-pose={pose}
    className={`block ${botRootClass(phase, animated)} ${className}`.trim()}
    width={BOT_STAGE_COLS * scale}
    height={BOT_STAGE_ROWS * scale}
    viewBox={`0 0 ${BOT_STAGE_COLS} ${BOT_STAGE_ROWS}`}
    shapeRendering="crispEdges"
  >
    <BotLayers pose={pose} />
  </svg>
);
