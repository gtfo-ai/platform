/**
 * A project's readiness, said as **what it means for the people using the project** (product/17's
 * 2026-11-06 amendment, Q-UX-2, research/21 F3) — not as the ladder's number.
 *
 * - The badge reads what agents may do: level 0 *Plans need your OK*, levels 1–2 *Big plans need
 *   your OK*, level 3 *Agents plan on their own*, level 4 *Ready for more autonomy*. The words are
 *   the amendment's own.
 * - Level 0 is the normal start of most projects, so it is drawn **neutral** — no ✕, never red.
 *   Levels 1 and 2 are neutral too: a person checking the big plans is the documented default
 *   (product/04), and a level 1 drawn louder than level 0 would read as worse than the start. Levels
 *   3 and 4 are the success tone: the repository proves enough for agents to plan on their own.
 * - The badge is a button that opens a Popover (`ui/popover.tsx`) — by click and by keyboard — the
 *   level's **definition** (product/10): the ladder's name and number, what the level means now
 *   (product/17 § "Levels", "Platform behaviour"), the next level and what it needs, the cheapest
 *   missing criterion with its how-to and what it unlocks (both in `readiness-popover.tsx`'s plain
 *   words), and a link to *Discovery & readiness*. The popover's docblock says how the cheapest
 *   missing criterion is read, and why only once it is open.
 *
 * The contract allows a level 5 that product/17 does not name: it is drawn as "Level 5" and is
 * never given an invented name or meaning.
 *
 * **The popover is a lazy chunk** (S-25.6, BACKLOG 1240): the badge sits on the project frame and
 * on Home, both in the initial graph, and Base UI's Popover with its positioning code is several
 * kB of TD-013's 300 kB budget that a first paint never uses. So the badge is a plain `<button>`
 * with the trigger's own name and attributes, and `readiness-popover.tsx` (Popover, its content and
 * the readiness read) is fetched ahead the first time the pointer rests on it or it takes the focus.
 * **Only a press swaps it**: the popover's own trigger then replaces the button — the same classes
 * and id — the focus is put back on it if the button had it, and the press is handed on to it (a
 * `click()` on the new trigger), so the popover opens, focuses and closes by Base UI's own path. Swapping on hover or focus would replace the element under a press
 * already on its way (CI on #83: the click landed on the detached button and opened nothing). A
 * failed load is forgotten, so the next press tries again, and the button says so in its title.
 */
import { PersonIcon } from '@primer/octicons-react/PersonIcon';
import { RocketIcon } from '@primer/octicons-react/RocketIcon';
import { ShieldCheckIcon } from '@primer/octicons-react/ShieldCheckIcon';
import type { Icon } from '@primer/octicons-react/types';
import {
  type ButtonHTMLAttributes,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { type ReadinessTone, readinessBadgeWord, readinessTone } from './readiness-words.js';

export {
  READINESS_LEVELS,
  type ReadinessLevelLook,
  type ReadinessTone,
  readinessBadgeWord,
  readinessLadderName,
  readinessNameAndWord,
  readinessSummary,
  readinessTone,
} from './readiness-words.js';

const TONE_CLASS: Readonly<Record<ReadinessTone, string>> = {
  neutral: 'bg-subtle border-line text-fg-muted',
  success: 'bg-success-bg border-success/40 text-success',
};

const levelIcon = (level: number): Icon =>
  level >= 4 ? RocketIcon : level === 3 ? ShieldCheckIcon : PersonIcon;

type PopoverModule = typeof import('./readiness-popover.js');

let popoverLoad: Promise<PopoverModule> | null = null;

/** The popover's chunk, imported once; a failed import is forgotten so the next press retries. */
const loadPopover = (): Promise<PopoverModule> => {
  popoverLoad ??= import('./readiness-popover.js').catch((error: unknown) => {
    popoverLoad = null;
    throw error;
  });
  return popoverLoad;
};

export const ReadinessLabel = ({
  level,
  project,
  size = 'sm',
}: {
  readonly level: number;
  /** The project the level is of: the popover reads its evaluation and links to its settings. */
  readonly project: { readonly id: string; readonly key: string };
  readonly size?: 'sm' | 'md';
}): ReactElement => {
  const triggerId = useId();
  // Every badge starts as the plain button, even once the chunk is cached: one shape on first
  // paint, and the swap — immediate then — happens only where somebody presses it.
  const [loaded, setLoaded] = useState<PopoverModule | null>(null);
  // Pressed before the chunk arrived: the popover opens as soon as it does.
  const [pressed, setPressed] = useState(false);
  const [failed, setFailed] = useState(false);
  const refocus = useRef(false);
  // Once the popover's trigger has replaced the button: the focus back on it, and the press that
  // asked for it handed on — Base UI's own click opens it, against that trigger. After mount
  // (`useEffect`), so the trigger's own handlers are attached.
  const handedOn = useRef(false);
  useEffect(() => {
    if (loaded === null || handedOn.current) {
      return;
    }
    handedOn.current = true;
    const trigger = document.getElementById(triggerId);
    if (refocus.current) {
      refocus.current = false;
      trigger?.focus();
    }
    if (pressed) {
      trigger?.click();
    }
  }, [loaded, pressed, triggerId]);
  // Hover and focus fetch the chunk ahead, and nothing else: a failure there is the press's to say,
  // which tries again (`loadPopover` forgets a failed import).
  const warm = (): void => {
    loadPopover().catch(() => undefined);
  };
  const open = (): void => {
    void loadPopover().then(
      (module) => {
        // The popover's own trigger replaces this button: the focus stays on the badge.
        refocus.current = document.activeElement?.id === triggerId;
        setLoaded(module);
      },
      () => {
        setPressed(false);
        setFailed(true);
      },
    );
  };

  const Glyph = levelIcon(level);
  const tone = readinessTone(level);
  const word = readinessBadgeWord(level);
  const badge = (extra: ButtonHTMLAttributes<HTMLButtonElement>): ReactElement => (
    <button
      type="button"
      aria-label={`Readiness: ${word}`}
      data-readiness-level={level}
      data-readiness-tone={tone}
      className={cx(
        'inline-flex cursor-pointer items-center gap-1 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-px text-xs' : 'px-2.5 py-0.5 text-sm',
        TONE_CLASS[tone],
        FOCUS_RING,
      )}
      {...extra}
    >
      <span aria-hidden="true" className="inline-flex shrink-0 items-center">
        <Glyph size={size === 'sm' ? 12 : 16} />
      </span>
      <span>{word}</span>
    </button>
  );

  if (loaded === null) {
    // The popover trigger's own attributes, so nothing a reader or a test sees changes on arrival.
    return badge({
      id: triggerId,
      'aria-haspopup': 'dialog',
      'aria-expanded': pressed,
      onPointerEnter: warm,
      onFocus: warm,
      onClick: () => {
        setFailed(false);
        setPressed((was) => !was);
        open();
      },
      ...(failed
        ? { title: 'The level’s definition could not be loaded. Press again to try once more.' }
        : {}),
    });
  }
  return (
    <loaded.ReadinessPopover
      level={level}
      project={project}
      triggerId={triggerId}
      trigger={badge({})}
    />
  );
};
