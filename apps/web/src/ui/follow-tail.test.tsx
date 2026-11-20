import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowPaused, useFollowTail } from './follow-tail.js';
import {
  bottomOf,
  layOut,
  readerScrolls,
  type ScrollGeometry,
} from './scroll-geometry.test-fixture.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The hook wired the way both views wire it: a pane, one observed content box, the paused line. */
const Harness = ({ total }: { readonly total: number }) => {
  const tail = useFollowTail(total);
  return (
    <div>
      {tail.following ? <span data-testid="following">following</span> : null}
      <FollowPaused tail={tail} />
      <div
        data-testid="pane"
        ref={tail.scrollerRef}
        onScroll={tail.onScroll}
        style={tail.scrollerStyle}
        // happy-dom's style object may not know `overflow-anchor`: read what the hook asked for.
        data-anchor={String(tail.scrollerStyle.overflowAnchor)}
      >
        <div ref={tail.contentRef}>{`${total} entries`}</div>
      </div>
    </div>
  );
};

/** Rendered, laid out, and pinned once by a render with the geometry in place. */
const mount = (initial: ScrollGeometry = { scrollHeight: 1000, clientHeight: 200 }) => {
  const view = render(<Harness total={1} />);
  const pane = screen.getByTestId('pane');
  const geometry = layOut(pane, initial);
  view.rerender(<Harness total={2} />);
  return { view, pane, geometry };
};

const following = (): boolean => screen.queryByTestId('following') !== null;

describe('useFollowTail', () => {
  it('follows: every commit pins the pane to the end, with scroll anchoring off', () => {
    const { view, pane, geometry } = mount();
    expect(pane.scrollTop).toBe(bottomOf(geometry));
    expect(pane.dataset.anchor).toBe('none');

    geometry.scrollHeight = 1300;
    view.rerender(<Harness total={3} />);
    expect(pane.scrollTop).toBe(bottomOf(geometry));
    expect(following()).toBe(true);
  });

  it('does not read its own scroll back as the reader’s, even after the content grew under it', () => {
    const { view, pane, geometry } = mount();
    const pinned = pane.scrollTop;
    // The pin's `scroll` event arrives a frame later, after more rows made the pane taller: the
    // position is the pin's own, 300 px short of the new end. The replaced hook paused here.
    geometry.scrollHeight = 1300;
    fireEvent.scroll(pane);
    expect(pane.scrollTop).toBe(pinned);
    expect(following()).toBe(true);
    expect(screen.queryByTestId('follow-paused')).toBeNull();

    view.rerender(<Harness total={3} />);
    expect(pane.scrollTop).toBe(bottomOf(geometry));
  });

  it('pauses when the reader scrolls up — even a few pixels — keeps their place and counts what arrives', () => {
    const { view, pane, geometry } = mount();
    readerScrolls(pane, bottomOf(geometry) - 5);
    expect(following()).toBe(false);
    expect(screen.getByTestId('follow-paused').textContent).toBe(
      'Paused — scrolled up from the end',
    );
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
    expect(pane.dataset.anchor).toBe('auto');

    readerScrolls(pane, 300);
    geometry.scrollHeight = 1600;
    view.rerender(<Harness total={5} />);
    expect(pane.scrollTop).toBe(300);
    expect(screen.getByTestId('follow-paused').textContent).toBe('Paused · 3 new');
  });

  it('does not pin back a reader’s scroll whose event has not arrived yet', () => {
    const { view, pane, geometry } = mount();
    // The wheel moved the pane; a frame of new rows commits before the browser dispatches `scroll`.
    pane.scrollTop = 500;
    geometry.scrollHeight = 1300;
    view.rerender(<Harness total={3} />);
    expect(pane.scrollTop).toBe(500);
    expect(following()).toBe(false);
    // The event, when it comes, keeps it paused.
    fireEvent.scroll(pane);
    expect(following()).toBe(false);
  });

  it('keeps following when the content shrinks and the browser clamps the pane to its new end', () => {
    const { view, pane, geometry } = mount();
    geometry.scrollHeight = 700;
    pane.scrollTop = bottomOf(geometry); // the clamp a shorter pane makes
    view.rerender(<Harness total={3} />);
    expect(following()).toBe(true);
    expect(pane.scrollTop).toBe(bottomOf(geometry));
  });

  it('resumes when the reader scrolls back to the end', () => {
    const { view, pane, geometry } = mount();
    readerScrolls(pane, 100);
    view.rerender(<Harness total={4} />);
    expect(following()).toBe(false);

    // Near enough to the end, moving down: following again, and the count is gone.
    readerScrolls(pane, bottomOf(geometry) - 10);
    expect(following()).toBe(true);
    expect(screen.queryByTestId('follow-paused')).toBeNull();
    geometry.scrollHeight = 1200;
    view.rerender(<Harness total={5} />);
    expect(pane.scrollTop).toBe(bottomOf(geometry));
  });

  it('does not resume on a scroll down that stops short of the end', () => {
    const { pane, geometry } = mount();
    readerScrolls(pane, 100);
    readerScrolls(pane, bottomOf(geometry) - 200);
    expect(following()).toBe(false);
  });

  it('resumes from *Jump to latest*: at the end, following, nothing counted', () => {
    const { view, pane, geometry } = mount();
    readerScrolls(pane, 0);
    geometry.scrollHeight = 2000;
    view.rerender(<Harness total={9} />);
    expect(screen.getByTestId('follow-paused').textContent).toBe('Paused · 7 new');

    act(() => {
      screen.getByRole('button', { name: 'Jump to latest' }).click();
    });
    expect(pane.scrollTop).toBe(bottomOf(geometry));
    expect(following()).toBe(true);
    expect(screen.queryByTestId('follow-paused')).toBeNull();
  });

  it('follows a row that grows after its commit, and leaves a paused pane where it is', () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { pane, geometry } = mount();
    expect(callbacks).toHaveLength(1);
    const resized = (): void => {
      for (const callback of callbacks) {
        callback();
      }
    };

    // A step's body opened, a line wrapped: no render, no new entry — only a size change.
    geometry.scrollHeight = 1500;
    act(resized);
    expect(pane.scrollTop).toBe(bottomOf(geometry));

    readerScrolls(pane, 400);
    geometry.scrollHeight = 1800;
    act(resized);
    expect(pane.scrollTop).toBe(400);
  });
});
