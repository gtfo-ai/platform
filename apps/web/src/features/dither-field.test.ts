/**
 * The sign-in page's dither field (WP-291): the pure frame, the layout and the frame loop.
 *
 * The loop is driven with fake collaborators — a frame queue, a visibility flag — so "reduced
 * motion paints one frame and schedules nothing", "a hidden tab schedules nothing" and "unmount
 * cancels the frame" are asserted as calls, not inferred from a screenshot.
 */
import { describe, expect, it } from 'vitest';
import {
  DITHER_COLOURS,
  ditherLayout,
  driveDitherField,
  FRAME_INTERVAL_MS,
  LANE_ROWS,
  QUIET_FALLOFF_CELLS,
  quietAt,
  renderDitherFrame,
  STATIC_FRAME_T,
  TRAVELLER_PERIOD_S,
  travellersAt,
} from './dither-field.js';

const STATE = { cols: 120, rows: 72 };

const pixel = (frame: Uint8ClampedArray, x: number, y: number): number[] => {
  const at = (y * STATE.cols + x) * 4;
  return [frame[at] ?? -1, frame[at + 1] ?? -1, frame[at + 2] ?? -1, frame[at + 3] ?? -1];
};

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

describe('renderDitherFrame', () => {
  it('is pure: the same state and time give the same bytes', () => {
    expect(renderDitherFrame(STATE, 3.2)).toEqual(renderDitherFrame(STATE, 3.2));
    expect(renderDitherFrame(STATE, 3.2)).not.toEqual(renderDitherFrame(STATE, 5.7));
  });

  it('is 1-bit outside the travellers: every other pixel is the ground or the lit colour', () => {
    const frame = renderDitherFrame(STATE, 1.5);
    expect(frame).toHaveLength(STATE.cols * STATE.rows * 4);
    const travelled = new Set(
      travellersAt(1.5, STATE).flatMap((t) => [0, 1, 2].map((o) => `${t.x - o},${t.y}`)),
    );
    let lit = 0;
    for (let y = 0; y < STATE.rows; y += 1) {
      for (let x = 0; x < STATE.cols; x += 1) {
        if (travelled.has(`${x},${y}`)) continue;
        const p = pixel(frame, x, y);
        expect(p[3]).toBe(255);
        const isLit = same(p, DITHER_COLOURS.lit);
        expect(isLit || same(p, DITHER_COLOURS.night)).toBe(true);
        if (isLit) lit += 1;
      }
    }
    // Quiet, but not empty: a field that lit nothing or everything would read as a flat colour.
    const share = lit / (STATE.cols * STATE.rows);
    expect(share).toBeGreaterThan(0.03);
    expect(share).toBeLessThan(0.4);
  });

  it('reads as horizontal lanes: a lane’s centre row is denser than the rows between lanes', () => {
    const frame = renderDitherFrame(STATE, 2);
    const litIn = (y: number): number => {
      let n = 0;
      for (let x = 0; x < STATE.cols; x += 1) {
        if (same(pixel(frame, x, y), DITHER_COLOURS.lit)) n += 1;
      }
      return n;
    };
    let centre = 0;
    let edge = 0;
    for (let lane = 0; lane < Math.floor(STATE.rows / LANE_ROWS); lane += 1) {
      centre += litIn(lane * LANE_ROWS + Math.floor(LANE_ROWS / 2));
      edge += litIn(lane * LANE_ROWS);
    }
    expect(centre).toBeGreaterThan(edge * 2);
  });

  it('draws an amber traveller that moves right and fades out at the edge', () => {
    const t = TRAVELLER_PERIOD_S * 4 + 1;
    const [now] = travellersAt(t, STATE);
    const [later] = travellersAt(t + 1, STATE);
    expect(now).toBeDefined();
    expect(later?.y).toBe(now?.y);
    expect(later?.x ?? 0).toBeGreaterThan(now?.x ?? 0);
    expect(now?.alpha).toBe(1);
    const head = pixel(renderDitherFrame(STATE, t), now?.x ?? 0, now?.y ?? 0);
    expect(same(head, DITHER_COLOURS.beacon)).toBe(true);
    // Near the end of its crossing it is fading, and it is gone once it has crossed.
    const fading = travellersAt(TRAVELLER_PERIOD_S * 4 + 8.8, STATE).filter(
      (traveller) => traveller.y === now?.y && traveller.x > STATE.cols * 0.9,
    );
    expect(fading).toHaveLength(1);
    expect(fading[0]?.alpha ?? 1).toBeLessThan(0.2);
    const crossed = travellersAt(TRAVELLER_PERIOD_S * 4 + 9.01, STATE);
    expect(crossed.some((traveller) => traveller.x > STATE.cols * 0.9)).toBe(false);
  });

  it('goes quiet behind a text rectangle and stays itself away from it', () => {
    const rect = { x: 10, y: 9, width: 50, height: 36 };
    const loud = renderDitherFrame(STATE, 2);
    const quiet = renderDitherFrame({ ...STATE, quiet: [rect] }, 2);
    const litInside = (frame: Uint8ClampedArray): number => {
      let n = 0;
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        for (let x = rect.x; x < rect.x + rect.width; x += 1) {
          if (same(pixel(frame, x, y), DITHER_COLOURS.lit)) n += 1;
        }
      }
      return n;
    };
    expect(litInside(loud)).toBeGreaterThan(20);
    expect(litInside(quiet)).toBeLessThan(litInside(loud) / 4);
    // Far outside the falloff the two frames are the same pixels.
    const farX = rect.x + rect.width + QUIET_FALLOFF_CELLS + 1;
    for (let y = 0; y < STATE.rows; y += 1) {
      for (let x = farX; x < STATE.cols; x += 1) {
        expect(pixel(quiet, x, y)).toEqual(pixel(loud, x, y));
      }
    }
  });

  it('reuses the buffer it is given', () => {
    const buffer = new Uint8ClampedArray(STATE.cols * STATE.rows * 4);
    expect(renderDitherFrame(STATE, 1, buffer)).toBe(buffer);
  });
});

describe('quietAt', () => {
  const rect = { x: 10, y: 10, width: 20, height: 10 };
  it('is 1 inside, eases out, and is 0 past the falloff', () => {
    expect(quietAt(15, 15, [rect])).toBe(1);
    const near = quietAt(30 + QUIET_FALLOFF_CELLS / 2, 15, [rect]);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    expect(quietAt(30 + QUIET_FALLOFF_CELLS, 15, [rect])).toBe(0);
    expect(quietAt(15, 15, [])).toBe(0);
  });

  it('takes the quietest of several rectangles', () => {
    const other = { x: 60, y: 10, width: 5, height: 5 };
    expect(quietAt(62, 12, [rect, other])).toBe(1);
  });
});

describe('ditherLayout', () => {
  it('snaps the cell to whole device pixels and covers the box', () => {
    expect(ditherLayout(1440, 900, 1)).toEqual({ cols: 288, rows: 180, cellCssPx: 5 });
    expect(ditherLayout(1440, 900, 2)).toEqual({ cols: 288, rows: 180, cellCssPx: 5 });
    const fractional = ditherLayout(390, 844, 1.25);
    // 5 CSS px × 1.25 = 6.25 device px → 6 device px → 4.8 CSS px.
    expect(fractional.cellCssPx).toBeCloseTo(4.8);
    expect(fractional.cols * fractional.cellCssPx).toBeGreaterThanOrEqual(390);
    expect(fractional.rows * fractional.cellCssPx).toBeGreaterThanOrEqual(844);
  });

  it('never answers an empty or nonsensical layout', () => {
    expect(ditherLayout(0, 0, Number.NaN)).toEqual({ cols: 1, rows: 1, cellCssPx: 5 });
  });
});

const harness = (options: { reducedMotion: boolean; hidden?: boolean }) => {
  const painted: number[] = [];
  const queue = new Map<number, (now: number) => void>();
  const cancelled: number[] = [];
  const listeners = new Set<() => void>();
  let next = 1;
  let hidden = options.hidden ?? false;
  const driver = driveDitherField({
    reducedMotion: options.reducedMotion,
    paint: (t) => {
      painted.push(t);
    },
    requestFrame: (callback) => {
      const handle = next;
      next += 1;
      queue.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      cancelled.push(handle);
      queue.delete(handle);
    },
    isHidden: () => hidden,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    driver,
    painted,
    queue,
    cancelled,
    listeners,
    /** Runs every queued frame at `now` milliseconds. */
    frame: (now: number) => {
      const pending = [...queue];
      queue.clear();
      for (const [, callback] of pending) callback(now);
    },
    setHidden: (value: boolean) => {
      hidden = value;
      for (const listener of listeners) listener();
    },
  };
};

describe('driveDitherField', () => {
  it('paints exactly one static frame under reduced motion and schedules nothing', () => {
    const h = harness({ reducedMotion: true });
    expect(h.painted).toEqual([STATIC_FRAME_T]);
    expect(h.queue.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    // A resize redraws the same still frame rather than starting a loop.
    h.driver.repaint();
    expect(h.painted).toEqual([STATIC_FRAME_T, STATIC_FRAME_T]);
    expect(h.queue.size).toBe(0);
  });

  it('paints at most about thirty frames a second', () => {
    const h = harness({ reducedMotion: false });
    h.frame(1000);
    h.frame(1000 + FRAME_INTERVAL_MS / 2);
    h.frame(1000 + FRAME_INTERVAL_MS);
    expect(h.painted).toEqual([1, (1000 + FRAME_INTERVAL_MS) / 1000]);
    expect(h.queue.size).toBe(1);
  });

  it('stops scheduling while the tab is hidden and resumes when it is shown', () => {
    const h = harness({ reducedMotion: false });
    h.frame(100);
    h.setHidden(true);
    expect(h.queue.size).toBe(0);
    expect(h.cancelled).toHaveLength(1);
    h.setHidden(false);
    expect(h.queue.size).toBe(1);
    h.frame(5000);
    expect(h.painted.at(-1)).toBe(5);
  });

  it('starts nothing in a hidden tab', () => {
    const h = harness({ reducedMotion: false, hidden: true });
    expect(h.queue.size).toBe(0);
    expect(h.painted).toEqual([]);
  });

  it('cancels its frame and its listener when stopped', () => {
    const h = harness({ reducedMotion: false });
    h.driver.stop();
    expect(h.queue.size).toBe(0);
    expect(h.cancelled).toHaveLength(1);
    expect(h.listeners.size).toBe(0);
    h.driver.stop();
    expect(h.cancelled).toHaveLength(1);
  });
});
