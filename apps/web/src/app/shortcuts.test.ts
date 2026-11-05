/**
 * The keyboard shortcuts' decisions (`shortcuts.ts`), asserted directly: the chord, the keys that
 * are not shortcuts, the guard that keeps them out of anything typed into, the list movement and the
 * setting. The listener that applies them is driven through the whole app in `keyboard.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHORD_TIMEOUT_MS,
  decideKey,
  IDLE,
  isInsideOverlay,
  isPaletteChord,
  isTypingTarget,
  JUMPS,
  type KeyPress,
  moveInList,
  readShortcutsEnabled,
  SHORTCUT_GROUPS,
  SHORTCUTS_STORAGE_KEY,
  setShortcutsEnabled,
} from './shortcuts.js';

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('decideKey', () => {
  it('jumps on g then a letter, for every jump the sheet lists', () => {
    for (const [letter, to] of Object.entries(JUMPS)) {
      const first = decideKey(IDLE, press('g'), 1000);
      expect(first.action).toBeNull();
      expect(first.state.pendingSince).toBe(1000);
      const second = decideKey(first.state, press(letter), 1200);
      expect(second.action).toEqual({ kind: 'jump', to });
      expect(second.state).toEqual(IDLE);
    }
    // The sheet and the table are one set: every `g x` row is a jump and every jump has a row.
    const rows = SHORTCUT_GROUPS.flatMap((group) => group.rows)
      .filter((row) => row.keys[0] === 'g')
      .map((row) => row.keys[1]);
    expect(rows.sort()).toEqual(Object.keys(JUMPS).sort());
  });

  it('forgets a g after the timeout, on both sides of it', () => {
    const pending = decideKey(IDLE, press('g'), 0).state;
    expect(decideKey(pending, press('h'), CHORD_TIMEOUT_MS).action).toEqual({
      kind: 'jump',
      to: 'home',
    });
    // Past it, `h` is a plain key (no action), and `j` is the list's again rather than a lost chord.
    expect(decideKey(pending, press('h'), CHORD_TIMEOUT_MS + 1).action).toBeNull();
    expect(decideKey(pending, press('j'), CHORD_TIMEOUT_MS + 1).action).toEqual({
      kind: 'row',
      step: 1,
    });
  });

  it('ends a chord on a letter that is not a jump, and reads only own keys of the table', () => {
    const pending = decideKey(IDLE, press('g'), 0).state;
    expect(decideKey(pending, press('x'), 10)).toEqual({ state: IDLE, action: null });
    // `in` would find `constructor` on the prototype; `Object.hasOwn` does not.
    expect(decideKey(pending, press('constructor'), 10).action).toBeNull();
    expect(decideKey(pending, press('toString'), 10).action).toBeNull();
  });

  it('maps / ? j k, and nothing else', () => {
    expect(decideKey(IDLE, press('/'), 0).action).toEqual({ kind: 'palette' });
    expect(decideKey(IDLE, press('?', {}), 0).action).toEqual({ kind: 'sheet' });
    expect(decideKey(IDLE, press('j'), 0).action).toEqual({ kind: 'row', step: 1 });
    expect(decideKey(IDLE, press('k'), 0).action).toEqual({ kind: 'row', step: -1 });
    for (const key of ['h', 'a', 'Enter', 'Escape', 'G', ' ']) {
      expect(decideKey(IDLE, press(key), 0).action).toBeNull();
    }
  });

  it('is never a shortcut with ⌘, Ctrl or Alt held, nor on an auto-repeat', () => {
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { repeat: true },
    ] satisfies Partial<KeyPress>[]) {
      expect(decideKey(IDLE, press('j', over), 0).action).toBeNull();
      expect(decideKey(IDLE, press('g', over), 0).state).toEqual(IDLE);
    }
  });
});

describe('isPaletteChord', () => {
  it('is ⌘K or Ctrl+K, in either case, and not K alone or with Alt', () => {
    expect(isPaletteChord(press('k', { metaKey: true }))).toBe(true);
    expect(isPaletteChord(press('K', { ctrlKey: true }))).toBe(true);
    expect(isPaletteChord(press('k'))).toBe(false);
    expect(isPaletteChord(press('k', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteChord(press('j', { metaKey: true }))).toBe(false);
  });
});

describe('isTypingTarget', () => {
  const mount = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    const target = document.querySelector<HTMLElement>('[data-target]');
    if (target === null) {
      throw new Error('no target');
    }
    return target;
  };

  it('is true in an input, a textarea, a select and anything contenteditable', () => {
    expect(isTypingTarget(mount('<input data-target />'))).toBe(true);
    expect(isTypingTarget(mount('<textarea data-target></textarea>'))).toBe(true);
    expect(isTypingTarget(mount('<select data-target><option>a</option></select>'))).toBe(true);
    expect(isTypingTarget(mount('<div contenteditable="true"><p data-target>x</p></div>'))).toBe(
      true,
    );
    expect(isTypingTarget(mount('<div contenteditable=""><span data-target>x</span></div>'))).toBe(
      true,
    );
  });

  it('is false on a button, a link, the body, and inside contenteditable="false"', () => {
    expect(isTypingTarget(mount('<button data-target>b</button>'))).toBe(false);
    expect(isTypingTarget(mount('<a href="/x" data-target>a</a>'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(
      isTypingTarget(mount('<div contenteditable="false"><span data-target>x</span></div>')),
    ).toBe(false);
  });
});

describe('isInsideOverlay', () => {
  it('is true inside a dialog or a menu, false on the page', () => {
    document.body.innerHTML =
      '<div role="dialog"><button id="in">a</button></div><div role="menu"><div id="menu">m</div></div><button id="out">b</button>';
    expect(isInsideOverlay(document.getElementById('in'))).toBe(true);
    expect(isInsideOverlay(document.getElementById('menu'))).toBe(true);
    expect(isInsideOverlay(document.getElementById('out'))).toBe(false);
  });
});

describe('moveInList', () => {
  const list = (): HTMLElement[] => {
    document.body.innerHTML = `
      <ul data-list-box="">
        <li><a href="/one" id="one">One</a></li>
        <li><span>no control</span></li>
        <li><button id="three">Three</button></li>
      </ul>
      <a href="/outside" id="outside">Outside</a>`;
    return ['one', 'three', 'outside'].map((id) => document.getElementById(id) as HTMLElement);
  };

  it('moves to the next and previous row’s first control, skipping a row with none', () => {
    const [one, three] = list();
    one?.focus();
    expect(moveInList(document.activeElement, 1)).toBe(true);
    expect(document.activeElement).toBe(three);
    expect(moveInList(document.activeElement, -1)).toBe(true);
    expect(document.activeElement).toBe(one);
  });

  it('stays put at either end and outside a list, and says so', () => {
    const [one, three, outside] = list();
    one?.focus();
    expect(moveInList(document.activeElement, -1)).toBe(false);
    expect(document.activeElement).toBe(one);
    three?.focus();
    expect(moveInList(document.activeElement, 1)).toBe(false);
    outside?.focus();
    expect(moveInList(document.activeElement, 1)).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});

describe('the setting', () => {
  it('is on by default, off once stored off, and on again', () => {
    expect(readShortcutsEnabled()).toBe(true);
    setShortcutsEnabled(false);
    expect(localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBe('off');
    expect(readShortcutsEnabled()).toBe(false);
    setShortcutsEnabled(true);
    expect(localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull();
    expect(readShortcutsEnabled()).toBe(true);
  });
});
