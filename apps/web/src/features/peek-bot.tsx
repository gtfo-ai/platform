/**
 * The robot behind the sign-in form (`peek-bot-sprite.ts` has the pixels and where they came from).
 *
 * An inline SVG, one `<rect>` per run of same-colour pixels, filled from the `--signin-*` tokens and
 * drawn `crispEdges`. It stands in a box exactly its own size whose bottom is the form block's top
 * edge and which clips it, so sliding the rig down hides it *behind* the block. Every frame is
 * drawn and the `peek-bot-*` keyframes in `styles.css` show one at a time, on one 10 s loop shared
 * by the rig and the frames so they cannot drift: hidden, rise, wave, blink, duck, a half-peek,
 * duck again. CSS only — no timer, nothing to stop on unmount, and the browser throttles it in a
 * hidden tab.
 *
 * `prefers-reduced-motion: reduce` turns the animations off rather than shortening them, and the
 * base styles are the waving frame standing up, so a reduced-motion visitor gets a still wave.
 *
 * Decorative: `aria-hidden`, no pointer events, nothing focusable.
 */
import type { ReactElement } from 'react';
import {
  PEEK_BOT_BLINK,
  PEEK_BOT_COLS,
  PEEK_BOT_INKS,
  PEEK_BOT_PEEK,
  PEEK_BOT_PIXEL_CSS_PX,
  PEEK_BOT_ROWS,
  PEEK_BOT_WAVE_A,
  PEEK_BOT_WAVE_B,
  type PeekBotRun,
  peekBotRuns,
} from './peek-bot-sprite.js';

const LAYERS: readonly { readonly className: string; readonly runs: readonly PeekBotRun[] }[] = [
  { className: 'peek-bot-peek', runs: peekBotRuns(PEEK_BOT_PEEK) },
  { className: 'peek-bot-wave-a', runs: peekBotRuns(PEEK_BOT_WAVE_A) },
  { className: 'peek-bot-wave-b', runs: peekBotRuns(PEEK_BOT_WAVE_B) },
  { className: 'peek-bot-blink', runs: peekBotRuns(PEEK_BOT_BLINK) },
];

const WIDTH = PEEK_BOT_COLS * PEEK_BOT_PIXEL_CSS_PX;
const HEIGHT = PEEK_BOT_ROWS * PEEK_BOT_PIXEL_CSS_PX;

export const PeekBot = (): ReactElement => (
  <div
    aria-hidden="true"
    data-testid="peek-bot"
    className="pointer-events-none flex justify-end pr-6 sm:pr-10"
  >
    <div className="overflow-hidden" style={{ width: WIDTH, height: HEIGHT }}>
      <svg
        aria-hidden="true"
        className="peek-bot-rig block"
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${PEEK_BOT_COLS} ${PEEK_BOT_ROWS}`}
        shapeRendering="crispEdges"
      >
        {LAYERS.map((layer) => (
          <g key={layer.className} className={layer.className}>
            {layer.runs.map((run) => (
              <rect
                key={`${run.x}:${run.y}`}
                x={run.x}
                y={run.y}
                width={run.width}
                height={1}
                className={PEEK_BOT_INKS[run.ink]}
              />
            ))}
          </g>
        ))}
      </svg>
    </div>
  </div>
);
