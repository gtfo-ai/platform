/**
 * The sign-in page's background: an ordered-dither pixel field (WP-291).
 *
 * Three pieces, so each can be tested without a canvas (happy-dom has no 2D context):
 *
 * - {@link renderDitherFrame} — **pure**. One frame at time `t` as RGBA bytes, one pixel per cell.
 *   A smooth field (value noise advected left → right along horizontal lanes) is thresholded by an
 *   8×8 Bayer matrix, so every cell is either the ground or the one "lit" colour: the 1-bit look
 *   is the threshold, not a palette. About every {@link TRAVELLER_PERIOD_S} seconds a single amber
 *   pixel crosses one lane and fades out near the right edge — a ticket reaching review.
 * - {@link ditherLayout} — how many cells fit a box, with the cell snapped to whole device pixels
 *   so `image-rendering: pixelated` scales every cell to the same size.
 * - {@link driveDitherField} — the frame loop, with every browser collaborator injected: ~30 fps,
 *   paused while the tab is hidden, and **one static frame and no loop** under
 *   `prefers-reduced-motion: reduce`.
 *
 * Quiet by construction: lit cells are `#3A3570` on `#15132B`, the lanes are narrow and only a few
 * are lit at a time, and the field fades to {@link QUIET_FLOOR} of itself inside the rectangles the
 * page marks as text (`DitherState.quiet` — the headline column and the form block), easing back
 * over {@link QUIET_FALLOFF_CELLS} cells, so the headline stays the brightest thing on the page. The
 * page's muted text on a lit cell is 4.52:1, measured, so even text that lands on one stays legible.
 */

/** RGB of the three colours the field draws (styles.css `--signin-*`). */
export const DITHER_COLOURS = {
  night: [0x15, 0x13, 0x2b],
  lit: [0x3a, 0x35, 0x70],
  beacon: [0xf4, 0xb8, 0x60],
} as const;

/** The cell's size in CSS pixels before it is snapped to the device grid. */
export const DITHER_CELL_CSS_PX = 5;

/** How often a traveller sets off, and how long it takes to cross. */
export const TRAVELLER_PERIOD_S = 4.5;
export const TRAVELLER_CROSSING_S = 9;

/** Rows per lane. A lane is the band one traveller rides along. */
export const LANE_ROWS = 9;

/** The time the reduced-motion frame is drawn at: a traveller is part-way across. */
export const STATIC_FRAME_T = TRAVELLER_PERIOD_S * 3 + TRAVELLER_CROSSING_S * 0.42;

/** The frame interval the loop holds to — about 30 frames a second, never more. */
export const FRAME_INTERVAL_MS = 1000 / 30;

/** A rectangle in **cell** coordinates — where text sits, so the field goes quiet there. */
export interface DitherRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DitherState {
  readonly cols: number;
  readonly rows: number;
  /** The text blocks (headline column, form block); absent or empty means no quiet zone. */
  readonly quiet?: readonly DitherRect[];
}

/** How far, in cells, the quiet zone fades out around a rectangle. */
export const QUIET_FALLOFF_CELLS = 14;

/** How much of the field survives at the heart of a quiet zone. */
export const QUIET_FLOOR = 0.08;

/**
 * How quiet the field is at a cell: 1 inside a text rectangle, easing to 0 at
 * {@link QUIET_FALLOFF_CELLS} outside it, the strongest of the rectangles. Pure.
 */
export const quietAt = (x: number, y: number, rects: readonly DitherRect[] = []): number => {
  let quiet = 0;
  for (const rect of rects) {
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
    const distance = Math.hypot(dx, dy);
    const q = 1 - smooth(clamp01(distance / QUIET_FALLOFF_CELLS));
    if (q > quiet) {
      quiet = q;
    }
  }
  return quiet;
};

/** The multiplier the quiet zone applies: 1 far from text, {@link QUIET_FLOOR} under it. */
const quietGain = (x: number, y: number, state: DitherState): number =>
  1 - (1 - QUIET_FLOOR) * quietAt(x, y, state.quiet);

/** 8×8 Bayer matrix, thresholds 0…63. */
const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
] as const;

const bayerThreshold = (x: number, y: number): number =>
  ((BAYER_8[(y & 7) * 8 + (x & 7)] ?? 0) + 0.5) / 64;

/** A deterministic hash of two integers onto [0, 1). */
const hash2 = (x: number, y: number): number => {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const smooth = (v: number): number => v * v * (3 - 2 * v);

/** Value noise on the integer lattice, smoothly interpolated: [0, 1). */
export const valueNoise = (x: number, y: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const top = hash2(xi, yi) + (hash2(xi + 1, yi) - hash2(xi, yi)) * xf;
  const bottom = hash2(xi, yi + 1) + (hash2(xi + 1, yi + 1) - hash2(xi, yi + 1)) * xf;
  return top + (bottom - top) * yf;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How lit the field wants to be at a cell, before the threshold: [0, 1].
 *
 * Each lane drifts right at its own speed; inside a lane the density peaks on the lane's centre
 * line, so the eye reads horizontal bands. The whole field leans denser towards the bottom-right.
 */
export const fieldValue = (x: number, y: number, t: number, state: DitherState): number => {
  const lane = Math.floor(y / LANE_ROWS);
  const inLane = (y % LANE_ROWS) / (LANE_ROWS - 1) - 0.5;
  // A narrow band on the lane's centre line, nearly nothing between lanes.
  const band = Math.exp(-(inLane * inLane) / 0.02);
  // Each lane's brightness drifts slowly, so a few lanes are lit at a time and most are dim.
  const laneWeight =
    0.2 + 0.8 * smooth(clamp01((valueNoise(lane * 1.7 + 5, t * 0.03) - 0.4) / 0.35));
  const speed = 1.6 + hash2(lane, 7) * 2.2;
  const drift = valueNoise((x - t * speed) * 0.07, lane * 3.1 + y * 0.04);
  const slow = valueNoise(x * 0.015 - t * 0.05, y * 0.02 + 11);
  return clamp01((band * laneWeight * (0.08 + drift * 0.5) + slow * 0.03) * quietGain(x, y, state));
};

/** Where the travellers are at `t`: a cell, and how visible it is. */
export const travellersAt = (
  t: number,
  state: DitherState,
): { readonly x: number; readonly y: number; readonly alpha: number }[] => {
  const lanes = Math.max(1, Math.floor(state.rows / LANE_ROWS));
  const found: { x: number; y: number; alpha: number }[] = [];
  const newest = Math.floor(t / TRAVELLER_PERIOD_S);
  const overlap = Math.ceil(TRAVELLER_CROSSING_S / TRAVELLER_PERIOD_S);
  for (let k = newest; k > newest - overlap && k >= 0; k -= 1) {
    const progress = (t - k * TRAVELLER_PERIOD_S) / TRAVELLER_CROSSING_S;
    if (progress < 0 || progress >= 1) {
      continue;
    }
    const lane = Math.floor(hash2(k, 31) * lanes);
    const x = Math.floor(progress * state.cols);
    const y = lane * LANE_ROWS + Math.floor(LANE_ROWS / 2);
    // Full strength until three-quarters across, then fading to nothing at the edge.
    const alpha = 1 - clamp01((progress - 0.72) / 0.28);
    if (y < state.rows) {
      found.push({ x, y, alpha });
    }
  }
  return found;
};

/**
 * One frame, as `cols × rows` RGBA pixels. Pure: the same state and `t` give the same bytes.
 *
 * `into` lets the frame loop reuse one buffer instead of allocating 200 kB thirty times a second;
 * it must be exactly `cols * rows * 4` long.
 */
export const renderDitherFrame = (
  state: DitherState,
  t: number,
  into?: Uint8ClampedArray<ArrayBuffer>,
): Uint8ClampedArray<ArrayBuffer> => {
  const size = state.cols * state.rows * 4;
  const out = into !== undefined && into.length === size ? into : new Uint8ClampedArray(size);
  const { night, lit, beacon } = DITHER_COLOURS;
  for (let y = 0; y < state.rows; y += 1) {
    for (let x = 0; x < state.cols; x += 1) {
      const on = fieldValue(x, y, t, state) > bayerThreshold(x, y);
      const colour = on ? lit : night;
      const at = (y * state.cols + x) * 4;
      out[at] = colour[0];
      out[at + 1] = colour[1];
      out[at + 2] = colour[2];
      out[at + 3] = 255;
    }
  }
  for (const traveller of travellersAt(t, state)) {
    // The pixel itself, and a two-cell trail behind it at a third and a sixth of its strength.
    for (const [offset, strength] of [
      [0, 1],
      [1, 1 / 3],
      [2, 1 / 6],
    ] as const) {
      const x = traveller.x - offset;
      if (x < 0 || x >= state.cols) {
        continue;
      }
      const at = (traveller.y * state.cols + x) * 4;
      const a = traveller.alpha * strength * quietGain(x, traveller.y, state);
      for (let c = 0; c < 3; c += 1) {
        const base = out[at + c] ?? 0;
        out[at + c] = Math.round(base + ((beacon[c] ?? 0) - base) * a);
      }
    }
  }
  return out;
};

export interface DitherLayout extends DitherState {
  /** The cell's size in CSS pixels, snapped so it is a whole number of device pixels. */
  readonly cellCssPx: number;
}

/** How many cells cover a `width × height` CSS-pixel box at this device-pixel ratio. */
export const ditherLayout = (
  width: number,
  height: number,
  devicePixelRatio: number,
): DitherLayout => {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const devicePx = Math.max(1, Math.round(DITHER_CELL_CSS_PX * ratio));
  const cellCssPx = devicePx / ratio;
  return {
    cols: Math.max(1, Math.ceil(Math.max(0, width) / cellCssPx)),
    rows: Math.max(1, Math.ceil(Math.max(0, height) / cellCssPx)),
    cellCssPx,
  };
};

export interface DitherDriver {
  /** Draws again now — after a resize, so a paused or static field is not left stale. */
  readonly repaint: () => void;
  /** Cancels the loop and every listener. Idempotent. */
  readonly stop: () => void;
}

export interface DitherDriverOptions {
  readonly reducedMotion: boolean;
  /** Draws the frame at `t` seconds. */
  readonly paint: (t: number) => void;
  readonly requestFrame: (callback: (now: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly isHidden: () => boolean;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * The frame loop. Under reduced motion it paints {@link STATIC_FRAME_T} once and schedules nothing;
 * otherwise it paints at most every {@link FRAME_INTERVAL_MS} and stops scheduling while the
 * document is hidden, resuming where the clock is when it comes back.
 */
export const driveDitherField = (options: DitherDriverOptions): DitherDriver => {
  if (options.reducedMotion) {
    options.paint(STATIC_FRAME_T);
    return {
      repaint: () => {
        options.paint(STATIC_FRAME_T);
      },
      stop: () => {},
    };
  }

  let handle: number | null = null;
  let lastPaint = Number.NEGATIVE_INFINITY;
  let lastT = 0;
  let stopped = false;

  const tick = (now: number): void => {
    handle = null;
    if (stopped || options.isHidden()) {
      return;
    }
    // Two milliseconds of slack: a 60 Hz display delivers frames 16.7 ms apart with jitter, and
    // without it every other "second frame" would miss by a hair and the field would run at 20 fps.
    if (now - lastPaint >= FRAME_INTERVAL_MS - 2) {
      lastPaint = now;
      lastT = now / 1000;
      options.paint(lastT);
    }
    handle = options.requestFrame(tick);
  };

  const start = (): void => {
    if (handle === null && !stopped && !options.isHidden()) {
      handle = options.requestFrame(tick);
    }
  };

  const unsubscribe = options.onVisibilityChange(() => {
    if (options.isHidden()) {
      if (handle !== null) {
        options.cancelFrame(handle);
        handle = null;
      }
      return;
    }
    start();
  });

  start();

  return {
    repaint: () => {
      options.paint(lastT);
    },
    stop: () => {
      stopped = true;
      if (handle !== null) {
        options.cancelFrame(handle);
        handle = null;
      }
      unsubscribe();
    },
  };
};
