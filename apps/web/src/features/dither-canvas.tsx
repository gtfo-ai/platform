/**
 * The `<canvas>` the sign-in page's dither field is drawn on, and the effect that drives it
 * (WP-291). The drawing itself is `dither-field.ts`, pure; this file is the browser plumbing.
 *
 * The canvas holds **one pixel per cell** and is scaled up by CSS with `image-rendering:
 * pixelated`, so a 1440×900 viewport draws about 290×180 pixels a frame rather than two million.
 * Its CSS box is `cols × cell` wide — slightly larger than its container, which clips it — so the
 * scale is exactly the snapped cell and every cell is the same number of device pixels.
 *
 * The field goes quiet behind every sibling marked `data-dither-quiet` (the headline column and
 * the form block), measured in cells on every resize of the box or of those elements.
 *
 * Decorative: the canvas sits inside an `aria-hidden` box (on the box rather than the canvas,
 * which biome's `noAriaHiddenOnFocusable` reads as focusable), with no pointer events.
 */
import { type ReactElement, useEffect, useRef } from 'react';
import {
  type DitherLayout,
  type DitherRect,
  ditherLayout,
  driveDitherField,
  renderDitherFrame,
} from './dither-field.js';

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const DitherCanvas = (): ReactElement => {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = box.current;
    const surface = canvas.current;
    if (container === null || surface === null) {
      return;
    }
    // happy-dom has no 2D context; a browser that refuses one gets the plain ground colour.
    const context = surface.getContext('2d');
    let layout: DitherLayout | null = null;
    let buffer: Uint8ClampedArray<ArrayBuffer> | null = null;
    let quiet: DitherRect[] = [];
    // The text blocks the field goes quiet behind: siblings marked `data-dither-quiet`.
    const quietElements = (): HTMLElement[] => [
      ...(container.parentElement?.querySelectorAll<HTMLElement>('[data-dither-quiet]') ?? []),
    ];

    const measureQuiet = (): void => {
      if (layout === null) {
        return;
      }
      const origin = container.getBoundingClientRect();
      const cell = layout.cellCssPx;
      quiet = quietElements().map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: (rect.left - origin.left) / cell,
          y: (rect.top - origin.top) / cell,
          width: rect.width / cell,
          height: rect.height / cell,
        };
      });
    };

    const measure = (): void => {
      const next = ditherLayout(
        container.clientWidth,
        container.clientHeight,
        window.devicePixelRatio,
      );
      if (
        layout !== null &&
        layout.cols === next.cols &&
        layout.rows === next.rows &&
        layout.cellCssPx === next.cellCssPx
      ) {
        return;
      }
      layout = next;
      buffer = new Uint8ClampedArray(next.cols * next.rows * 4);
      surface.width = next.cols;
      surface.height = next.rows;
      surface.style.width = `${next.cols * next.cellCssPx}px`;
      surface.style.height = `${next.rows * next.cellCssPx}px`;
    };

    const paint = (t: number): void => {
      if (context === null || layout === null || buffer === null) {
        return;
      }
      const frame = renderDitherFrame({ ...layout, quiet }, t, buffer);
      context.putImageData(new ImageData(frame, layout.cols, layout.rows), 0, 0);
    };

    measure();
    measureQuiet();
    const driver = driveDitherField({
      reducedMotion: prefersReducedMotion(),
      paint,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        window.cancelAnimationFrame(handle);
      },
      isHidden: () => document.visibilityState === 'hidden',
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => {
          document.removeEventListener('visibilitychange', listener);
        };
      },
    });

    const resized = (): void => {
      measure();
      measureQuiet();
      driver.repaint();
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resized);
      observer.observe(container);
      // A text block that changes size (the bootstrap hint arriving, an error notice) moves its
      // quiet zone with it.
      for (const element of quietElements()) {
        observer.observe(element);
      }
    } else {
      window.addEventListener('resize', resized);
    }

    return () => {
      driver.stop();
      observer?.disconnect();
      window.removeEventListener('resize', resized);
    };
  }, []);

  return (
    <div
      ref={box}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-signin-night"
    >
      <canvas ref={canvas} className="block [image-rendering:pixelated]" />
    </div>
  );
};
