/**
 * The card-ground scan the browser tier holds the screens to (S-25.10b, TD-033's 2026-11-05
 * amendment): the page is `--bg-canvas`, and a form, a field, a list of facts or a document is a box
 * on the card ground (`--bg-default`, or a notice's tint, or a control's own fill).
 *
 * `apps/web/src/card-ground-census.test.ts` reads the sources and finds a *bordered* element with
 * no ground; a block drawn with no box at all has neither, which is how Settings → Policies drew its
 * form on the canvas while Budgets drew its in a card. This reads the rendered page instead: every
 * visible text node under `root` must have an ancestor, up to `root`, whose **computed** background
 * is neither transparent nor the canvas.
 *
 * ### What may stand on the canvas (`CHROME`)
 *
 * A heading, a link or a button on its own, a disclosure's summary, a select's own text, and the
 * page's chrome — the page header and the project's header band, a navigation, a stepper, a toolbar
 * row above a box (`data-toolbar`, GitHub's filter bars), a timeline (`data-timeline`, GitHub's
 * issue timeline), the flow and fleet canvases and the office, which paint their own grounds
 * (technical/09), and visually hidden text. And a paragraph of prose (`<p>`: an introduction, a
 * count, a note under a list) — **unless it is part of a content block**: a `<p>` with a `form`,
 * `fieldset`, `label`, `li`, `dl` or `table` between it and the root is that block's text, and is
 * held like any other (the review of #87: a form's hint on the canvas is the form on the canvas).
 *
 * ### No card inside a card (`nestedCards`)
 *
 * A bordered box on the card ground inside another one draws a second border on the same colour:
 * a Blankslate in a card, a section of boxes wrapped in one more. `nestedCards` reports every
 * visible element whose computed ground is the card's and whose border is drawn, under an ancestor
 * of the same kind. A disclosure's revealed panel (`details`), a dialog and the canvases are not
 * read: a panel opened in place is not a card placed in one.
 */
import type { Locator } from '@playwright/test';

/** The page colour, `--bg-canvas` (deep night): no box's ground. */
export const CANVAS = 'rgb(15, 13, 34)';

/** The card ground, `--bg-default` (night). */
export const CARD = 'rgb(21, 19, 43)';

const CHROME = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'button',
  'summary',
  'select',
  'option',
  'nav',
  '[role="tablist"]',
  '[data-page-header]',
  '[data-project-frame]',
  '[data-toolbar]',
  '[data-stepper]',
  '[data-timeline]',
  '[data-office]',
  '[data-testid="flow-canvas-frame"]',
  '[data-testid="fleet-canvas-frame"]',
  '.sr-only',
].join(', ');

/** Every visible text in `root` that no ground stands under, as `<tag> text`. */
export const textOnTheCanvas = (root: Locator): Promise<string[]> =>
  root.evaluate(
    (section, { canvas, chrome }) => {
      const grounded = (element: Element): boolean => {
        for (let at: Element | null = element; at !== null; at = at.parentElement) {
          const ground = getComputedStyle(at).backgroundColor;
          if (ground !== 'rgba(0, 0, 0, 0)' && ground !== 'transparent' && ground !== canvas) {
            return true;
          }
          if (at === section) {
            return false;
          }
        }
        return false;
      };
      const found: string[] = [];
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        const parent = node.parentElement;
        if (text === '' || parent === null || parent.closest(chrome) !== null) {
          continue;
        }
        // Prose on the canvas, unless it is a content block's own text (see the module note).
        const paragraph = parent.closest('p');
        if (paragraph !== null && section.contains(paragraph)) {
          let block: Element | null = null;
          for (
            let at = paragraph.parentElement;
            at !== null && at !== section;
            at = at.parentElement
          ) {
            if (at.matches('form, fieldset, label, li, dl, table')) {
              block = at;
              break;
            }
          }
          if (block === null) {
            continue;
          }
        }
        if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          continue;
        }
        if (!grounded(parent)) {
          found.push(`<${parent.tagName.toLowerCase()}> ${text.slice(0, 60)}`);
        }
      }
      return found;
    },
    { canvas: CANVAS, chrome: CHROME },
  );

const NOT_A_CARD = [
  'details',
  'dialog',
  '[role="dialog"]',
  '[data-office]',
  '[data-testid="flow-canvas-frame"]',
  '[data-testid="fleet-canvas-frame"]',
].join(', ');

/** Every bordered card-ground box in `root` that sits inside another, as `<tag> text`. */
export const nestedCards = (root: Locator): Promise<string[]> =>
  root.evaluate(
    (section, { card, exempt }) => {
      const isCard = (element: Element): boolean => {
        const style = getComputedStyle(element);
        return (
          style.backgroundColor === card &&
          style.borderTopStyle !== 'none' &&
          Number.parseFloat(style.borderTopWidth) > 0
        );
      };
      const found: string[] = [];
      for (const element of section.querySelectorAll('*')) {
        if (element.closest(exempt) !== null || !element.checkVisibility() || !isCard(element)) {
          continue;
        }
        for (let at = element.parentElement; at !== null; at = at.parentElement) {
          if (isCard(at)) {
            const text = (element.textContent ?? '').trim().slice(0, 60);
            found.push(`<${element.tagName.toLowerCase()}> ${text}`);
            break;
          }
          if (at === section) {
            break;
          }
        }
      }
      return found;
    },
    { card: CARD, exempt: NOT_A_CARD },
  );
