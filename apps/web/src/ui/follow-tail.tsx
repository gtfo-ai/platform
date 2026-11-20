/**
 * Following the newest line of a live log (S-28.22, BACKLOG 1609): one hook for the run page's
 * transcript (`transcript/view.tsx`) and the stage dialog's log (`viz/flow/stage-dialog.tsx`).
 *
 * **Why the log did not stay pinned — the causes, read off the code it replaces.** Both views had
 * their own copy of the same three mistakes:
 *
 * 1. **The platform's own scroll was read back as the reader's.** Setting `scrollTop` queues a
 *    `scroll` event that the browser dispatches on the next frame. On a busy run the next frame
 *    usually carries more rows, so the handler measured the *new* `scrollHeight` against the *old*
 *    `scrollTop`, found itself more than 24/32 px from the end and switched following **off** —
 *    nobody had touched the pane. That is the "does not stay pinned".
 * 2. **The pin ran after paint and only on a guessed trigger.** It was a `useEffect` keyed on a
 *    signature of the tail (the transcript: count, last id, last text's length; the dialog: the
 *    newest line's key). A row that changes height *without* changing that signature — a step that
 *    closes when its result arrives, a tool result folded into an earlier call or a subagent's
 *    child, a streaming line that wraps while the dialog's index-keyed tail lines keep their keys —
 *    was not followed at all until something else moved, and then the pane leapt by the whole
 *    difference. Where it did run, one frame was painted at the old position first. That is the
 *    "jumps".
 * 3. **The browser's scroll anchoring moved the pane under a trimmed list.** The dialog keeps the
 *    newest 400 lines and the task page's live transcript the newest 30 blocks, so rows leave at the
 *    top while rows arrive at the bottom; `overflow-anchor: auto` then shifts `scrollTop` to keep
 *    the anchor row still, which is a scroll event at a position nobody asked for (see 1).
 *
 * Not a cause: the 1 000-entry history page of backlog 828 — it is a gap between the oldest page
 * and the live tail, not a shift under the viewport, and stays open there. The streaming block's id
 * changing with every partial (`transcript/blocks.ts`) remounted the streaming row each frame, which
 * reset a disclosure the reader had opened; it is fixed beside this, though it did not move the pane.
 *
 * **What this does instead.** While following, the pane is pinned in a `useLayoutEffect` after
 * every commit and from a `ResizeObserver` on the content and the pane — both before paint, so a
 * row that grows late is followed in the same frame — and scroll anchoring is off. Every pin
 * records the position it produced; a `scroll` event at that position is the platform's own and is
 * ignored, and a pane found above it at the next pin is the reader's, whose event is still queued —
 * it pauses rather than being pinned back. Only a scroll **upwards** that leaves the end pauses (a reader's first notch of a wheel
 * is a few pixels, so a distance threshold alone would yank them back); reaching the end again —
 * by scrolling, `End`, or *Jump to latest* — resumes. A reader who opens or closes a step while
 * following pauses it too (`pause('disclosure')`, from the step's `<summary>` click, which runs
 * before the browser opens it): pinned, the step they just opened would be scrolled out of view. While paused, anchoring is back on so trimmed
 * rows do not move the reader's place, and the entries that arrived since are counted.
 */
import {
  type CSSProperties,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from './button.js';
import { formatInteger } from './kit.js';

/** How near the end a reader's scroll has to come to resume following. */
export const FOLLOW_RESUME_PX = 24;

export type PausedBy = 'scroll' | 'button' | 'disclosure';

export interface FollowTail {
  /** The scrolling pane. */
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  /** The pane's content, observed for size changes. One element, always rendered. */
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly following: boolean;
  /** Entries that arrived since following paused; 0 while following. */
  readonly unseen: number;
  /** The pane's `onScroll`. */
  readonly onScroll: () => void;
  /** The pane's `style`: scroll anchoring off while following, on while paused. */
  readonly scrollerStyle: CSSProperties;
  /** Stop following without scrolling (a toggle). */
  readonly pause: (by: 'button' | 'disclosure') => void;
  /**
   * Why it is paused — the reader scrolled up, pressed a *Following* toggle, or opened or closed a
   * step (which would otherwise be pinned out of view) — or `null` while following.
   */
  readonly pausedBy: PausedBy | null;
  /** Go to the end and follow again. */
  readonly jumpToLatest: () => void;
}

/**
 * @param total how many entries the log has had so far — monotonic where the view trims, so the
 *   paused count keeps counting past the trim.
 */
export const useFollowTail = (total: number): FollowTail => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** `null` while following; the entry count at the moment it paused otherwise. */
  const [paused, setPaused] = useState<{ readonly at: number; readonly by: PausedBy } | null>(null);
  const following = paused === null;
  const followingRef = useRef(following);
  followingRef.current = following;
  const totalRef = useRef(total);
  totalRef.current = total;
  const pauseAs = useCallback((by: PausedBy): void => {
    setPaused((current) => current ?? { at: totalRef.current, by });
  }, []);
  /** The position the last pin produced: a scroll event there is ours, not the reader's. */
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);

  /**
   * To the end. Unless `force`d, a pane that moved **up** since the last pin and is not at its end
   * is the reader's scroll whose event has not been dispatched yet: pinning would throw their
   * scroll away (on a busy run, every time), so it pauses instead. Content shrinking under the pane
   * also lowers `scrollTop`, but the browser's clamp leaves it at the end, which this tells apart.
   */
  const pin = useCallback(
    (force: boolean): void => {
      const element = scrollerRef.current;
      if (element === null) {
        return;
      }
      const top = element.scrollTop;
      if (
        !force &&
        ownTop.current !== null &&
        top < ownTop.current - 1 &&
        element.scrollHeight - top - element.clientHeight > 1
      ) {
        ownTop.current = null;
        lastTop.current = top;
        pauseAs('scroll');
        return;
      }
      element.scrollTop = element.scrollHeight;
      // Read back: the browser clamps to `scrollHeight - clientHeight`.
      ownTop.current = element.scrollTop;
      lastTop.current = element.scrollTop;
    },
    [pauseAs],
  );

  // Every commit while following, before paint: whatever the render changed, the end stays in view.
  useLayoutEffect(() => {
    if (following) {
      pin(false);
    }
  });

  // A row that changes height after its commit (a disclosure, a font, a wrapped line) — before paint.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || scroller === null || content === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (followingRef.current) {
        pin(false);
      }
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [pin]);

  const pause = useCallback(
    (by: 'button' | 'disclosure'): void => {
      ownTop.current = null;
      pauseAs(by);
    },
    [pauseAs],
  );

  const onScroll = useCallback((): void => {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    const top = element.scrollTop;
    const previous = lastTop.current;
    lastTop.current = top;
    if (ownTop.current !== null && Math.abs(top - ownTop.current) < 1) {
      return;
    }
    ownTop.current = null;
    const distance = element.scrollHeight - top - element.clientHeight;
    if (top < previous && distance > 1) {
      if (followingRef.current) {
        pauseAs('scroll');
      }
      return;
    }
    if (distance <= FOLLOW_RESUME_PX) {
      setPaused(null);
    }
  }, [pauseAs]);

  const jumpToLatest = useCallback((): void => {
    setPaused(null);
    pin(true);
  }, [pin]);

  return {
    scrollerRef,
    contentRef,
    following,
    unseen: paused === null ? 0 : Math.max(0, total - paused.at),
    pausedBy: paused?.by ?? null,
    onScroll,
    scrollerStyle: { overflowAnchor: following ? 'none' : 'auto' },
    pause,
    jumpToLatest,
  };
};

/** What a paused log says before anything new arrived: only a scroll is the reader's scroll. */
const PAUSED_WORDS: Record<PausedBy, string> = {
  scroll: 'Paused — scrolled up from the end',
  button: 'Paused',
  disclosure: 'Paused while a step is open',
};

/**
 * What a paused log says, and the way back: *Paused · 3 new* and *Jump to latest*. Nothing while
 * following — the view says that in its own words. Paused **from a button**, the button that was
 * pressed is gone, so focus moves to *Jump to latest* rather than dropping to the page.
 */
export const FollowPaused = ({
  tail,
  size = 'md',
}: {
  readonly tail: FollowTail;
  readonly size?: 'sm' | 'md';
}): ReactElement | null => {
  const jump = useRef<HTMLSpanElement>(null);
  const focusJump = tail.pausedBy === 'button';
  useEffect(() => {
    if (focusJump) {
      jump.current?.querySelector('button')?.focus();
    }
  }, [focusJump]);
  if (tail.following) {
    return null;
  }
  return (
    <>
      <span
        data-testid="follow-paused"
        role="status"
        aria-live="polite"
        className="text-xs text-fg-muted"
      >
        {tail.unseen > 0
          ? `Paused · ${formatInteger(tail.unseen)} new`
          : PAUSED_WORDS[tail.pausedBy ?? 'scroll']}
      </span>
      <span ref={jump} className="contents">
        <Button size={size} onClick={tail.jumpToLatest}>
          Jump to latest
        </Button>
      </span>
    </>
  );
};
