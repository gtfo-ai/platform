/**
 * Keyboard shortcuts, as data and pure functions (research/19 § 3 rule 10, technical/09
 * § "Accessibility, theming, i18n") — GitHub's set: `/` or ⌘K / Ctrl+K opens the command palette,
 * `g` then a letter jumps to a screen, `?` opens the sheet that lists them all, and `j`/`k` move
 * between the rows of a focused list.
 *
 * Everything that decides is here and has no React in it, so it is asserted directly
 * (`shortcuts.test.ts`); `keyboard.tsx` is the one listener that applies it.
 *
 * **Never inside something you type into.** A single-character shortcut is refused when the key's
 * target is an `<input>`, a `<textarea>`, a `<select>` or anything `contenteditable`
 * ({@link isTypingTarget}) — otherwise a `g` in the steer box would wait for the next letter and a
 * `?` in a comment would open a dialog — and while a dialog or a menu holds the focus, which has its
 * own keys. **⌘K / Ctrl+K is the exception**: a modifier chord cannot be typed by accident, so it
 * opens the palette from a field too, as GitHub's does.
 *
 * **They can be turned off** (Settings → Keyboard shortcuts; WCAG 2.1.4 *Character Key Shortcuts*): a person
 * using speech input, or who simply types into the page, may not want a bare letter to do anything.
 * Turning them off stops every single-character shortcut; ⌘K / Ctrl+K stays, for the reason above.
 * The choice is this browser's, kept under {@link SHORTCUTS_STORAGE_KEY}.
 */
import { useSyncExternalStore } from 'react';
import { ROW_LINK_ATTRIBUTE } from '../ui/row-link.js';

/** Where a `g` chord goes. `board` needs a project; the listener ignores it outside one. */
export type JumpTarget = 'home' | 'projects' | 'inbox' | 'agents' | 'settings' | 'board';

/** The second key of a `g` chord → where it goes. */
export const JUMPS: Readonly<Record<string, JumpTarget>> = {
  h: 'home',
  p: 'projects',
  i: 'inbox',
  a: 'agents',
  // S-25.6: Settings left the top row, and its Admin screens with it — one chord away.
  s: 'settings',
  b: 'board',
};

/** How long a `g` waits for its second key. */
export const CHORD_TIMEOUT_MS = 1500;

/** One row of the shortcuts sheet: the keys, pressed in order, and what they do. */
export interface ShortcutRow {
  readonly keys: readonly string[];
  readonly does: string;
}

export interface ShortcutGroup {
  readonly label: string;
  readonly rows: readonly ShortcutRow[];
}

/**
 * The sheet, in the order it is drawn — and the user guide's list (`docs/user-guide.md`
 * § "Keyboard shortcuts", held to this table by `features/user-guide-census.test.ts`).
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    label: 'Anywhere',
    rows: [
      { keys: ['⌘ K'], does: 'Search or jump to (Ctrl K on Windows and Linux)' },
      { keys: ['/'], does: 'Search or jump to' },
      { keys: ['?'], does: 'Show these shortcuts' },
    ],
  },
  {
    label: 'Go to',
    rows: [
      { keys: ['g', 'h'], does: 'Home' },
      { keys: ['g', 'p'], does: 'Projects' },
      { keys: ['g', 'i'], does: 'Inbox' },
      { keys: ['g', 'a'], does: 'Agents' },
      { keys: ['g', 's'], does: 'Settings' },
      { keys: ['g', 'b'], does: 'The board, inside a project' },
    ],
  },
  {
    label: 'In a list',
    rows: [
      { keys: ['j'], does: 'Next row' },
      { keys: ['k'], does: 'Previous row' },
    ],
  },
];

/** What a key press means, once the guards have let it through. */
export type ShortcutAction =
  | { readonly kind: 'palette' }
  | { readonly kind: 'sheet' }
  | { readonly kind: 'jump'; readonly to: JumpTarget }
  | { readonly kind: 'row'; readonly step: 1 | -1 };

/** The pending half of a chord: when its `g` was pressed, or nothing pending. */
export interface ChordState {
  readonly pendingSince: number | null;
}

export const IDLE: ChordState = { pendingSince: null };

/** The parts of a `KeyboardEvent` the decision reads. */
export interface KeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
}

/** ⌘K or Ctrl+K, with nothing else held. */
export const isPaletteChord = (press: KeyPress): boolean =>
  (press.metaKey || press.ctrlKey) && !press.altKey && press.key.toLowerCase() === 'k';

/**
 * A single-character key press → its action and the next chord state. `null` is "not a shortcut":
 * the press is left to the page. Modifiers other than Shift (which `?` needs) make it not one, and so
 * does an auto-repeat, so holding `j` does not race down a list.
 */
export const decideKey = (
  state: ChordState,
  press: KeyPress,
  now: number,
): { readonly state: ChordState; readonly action: ShortcutAction | null } => {
  if (press.metaKey || press.ctrlKey || press.altKey || press.repeat === true) {
    return { state: IDLE, action: null };
  }
  // `/` and `?` open what they open whatever came before them: a `g` followed by `/` is somebody
  // who changed their mind, and the palette is what they asked for.
  switch (press.key) {
    case '/':
      return { state: IDLE, action: { kind: 'palette' } };
    case '?':
      return { state: IDLE, action: { kind: 'sheet' } };
  }
  const pending = state.pendingSince !== null && now - state.pendingSince <= CHORD_TIMEOUT_MS;
  if (pending) {
    const to = Object.hasOwn(JUMPS, press.key) ? JUMPS[press.key] : undefined;
    return { state: IDLE, action: to === undefined ? null : { kind: 'jump', to } };
  }
  switch (press.key) {
    case 'g':
      return { state: { pendingSince: now }, action: null };
    case 'j':
      return { state: IDLE, action: { kind: 'row', step: 1 } };
    case 'k':
      return { state: IDLE, action: { kind: 'row', step: -1 } };
    default:
      return { state: IDLE, action: null };
  }
};

/** Whether a key press aimed at `target` is somebody typing — never a shortcut. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest('input, textarea, select') !== null) {
    return true;
  }
  // `isContentEditable` is the browser's own answer, inheritance included; the attribute walk is
  // for a DOM (happy-dom) that does not compute it.
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
};

/** Whether `target` sits in a dialog or a menu, whose own keys come first. */
export const isInsideOverlay = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;

/** The marker `ui/list-box.tsx` puts on a list's `<ul>`: the lists `j`/`k` move in. */
export const LIST_BOX_ATTRIBUTE = 'data-list-box';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * `j`/`k` inside a list: the row after (or before) the one holding the focus gets it, on its row
 * link when it has one (S-23.26, `ui/row-link.ts` — the control a click anywhere on the row
 * presses, which need not be its first: a *Needs you* row's is its action, after the title's own
 * links), else on its first focusable element — a row with nothing to focus is skipped. `false`
 * when the focus is not inside a list, or there is no row that way, so the press is left alone.
 */
export const moveInList = (active: Element | null, step: 1 | -1): boolean => {
  const list = active?.closest(`[${LIST_BOX_ATTRIBUTE}]`) ?? null;
  if (active === null || list === null) {
    return false;
  }
  const rows = [...list.children].filter((row) => row.tagName === 'LI');
  const current = rows.findIndex((row) => row.contains(active));
  if (current === -1) {
    return false;
  }
  for (let index = current + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];
    const target =
      row?.querySelector<HTMLElement>(`[${ROW_LINK_ATTRIBUTE}]`) ??
      row?.querySelector<HTMLElement>(FOCUSABLE);
    if (target !== null && target !== undefined) {
      target.focus();
      return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------------------------

export const SHORTCUTS_STORAGE_KEY = 'agentic.shortcuts';

const listeners = new Set<() => void>();

/** This page's choice when storage refuses to keep it (`null`: none made here). */
let unstoredChoice: boolean | null = null;

/** On unless this browser stored `off`; storage that throws reads this page's choice, else on. */
export const readShortcutsEnabled = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(SHORTCUTS_STORAGE_KEY) !== 'off';
  } catch {
    return unstoredChoice ?? true;
  }
};

export const setShortcutsEnabled = (enabled: boolean): void => {
  try {
    if (enabled) {
      globalThis.localStorage?.removeItem(SHORTCUTS_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(SHORTCUTS_STORAGE_KEY, 'off');
    }
  } catch {
    // Storage refused: the choice still holds for this page.
    unstoredChoice = enabled;
  }
  for (const listener of listeners) {
    listener();
  }
};

/** For `useSyncExternalStore`: this tab's own changes, and another tab's through `storage`. */
const subscribeShortcutsEnabled = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === SHORTCUTS_STORAGE_KEY) {
      listener();
    }
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
};

/** Whether single-key shortcuts are on in this browser, following the setting as it changes. */
export const useShortcutsEnabled = (): boolean =>
  useSyncExternalStore(subscribeShortcutsEnabled, readShortcutsEnabled, readShortcutsEnabled);
