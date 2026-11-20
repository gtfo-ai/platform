/**
 * A scroll pane's geometry for the `ui` tier. happy-dom lays nothing out — every element is
 * zero-high — and does not clamp `scrollTop`, so a follow-tail test written against it either
 * measures nothing or measures a position no browser can reach. This gives one element a mutable
 * `scrollHeight`/`clientHeight` and a `scrollTop` clamped to `[0, scrollHeight - clientHeight]` as a
 * browser clamps it; growing the returned geometry is a row arriving or growing, with no render.
 */
import { fireEvent } from '@testing-library/react';

export interface ScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
}

export const layOut = (element: HTMLElement, initial: ScrollGeometry): ScrollGeometry => {
  const geometry = { ...initial };
  let top = 0;
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, geometry.scrollHeight - geometry.clientHeight));
    },
  });
  return geometry;
};

/** The end of the pane: where a pin lands. */
export const bottomOf = (geometry: ScrollGeometry): number =>
  geometry.scrollHeight - geometry.clientHeight;

/** The reader scrolls the pane to `top` (the browser then dispatches `scroll`). */
export const readerScrolls = (element: HTMLElement, top: number): void => {
  element.scrollTop = top;
  fireEvent.scroll(element);
};
