/**
 * Whole-row click targets (S-23.26, `row-link.ts`): the row is one real link, and nothing else.
 *
 * happy-dom lays nothing out, so it cannot prove that a click on the row's meta text lands on the
 * link's `::after` — that is the browser's hit-testing, and `test/web-e2e/row-click.spec.ts` holds
 * it with a real mouse. What this file holds is the half a layout engine is not needed for:
 *
 * - the row's primary control carries the marker and the row the host class, which is all the
 *   stylesheet's rules select on (and the rules themselves are read out of `styles.css`, so a
 *   rename on one side is a failure, not a dead selector);
 * - the row has **no click handler**: a click dispatched on the meta text itself — which bubbles
 *   through the `<li>` — navigates nowhere, so a row-level `onClick` that navigated would fail here;
 * - a nested action keeps its own click and does not navigate;
 * - a row with no row link is a host with nothing to stretch (no marker anywhere in it).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListBox, ListRow } from './list-box.js';
import { ROW_LINK_ATTRIBUTE, ROW_LINK_HOST, ROW_LINK_LIFT, rowLink } from './row-link.js';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

afterEach(() => {
  cleanup();
});

const mount = (onAction: () => void) => {
  const root = createRootRoute({ component: () => <Outlet /> });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <ListBox label="Projects">
        <ListRow
          title={
            <Link to="/projects" {...rowLink('hover:underline')}>
              Demo service
            </Link>
          }
          meta={<span>DEMO · 3 open</span>}
          actions={
            <button type="button" onClick={onAction}>
              Approve
            </button>
          }
        />
        <ListRow title="A row with nowhere to go" meta={<span>no destination</span>} />
      </ListBox>
    ),
  });
  const target = createRoute({
    getParentRoute: () => root,
    path: '/projects',
    component: () => <h1>The projects page</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([list, target]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  return router;
};

describe('rowLink', () => {
  it('marks the control and keeps the caller’s classes', () => {
    expect(rowLink('font-semibold hover:underline')).toEqual({
      [ROW_LINK_ATTRIBUTE]: '',
      className: 'font-semibold hover:underline',
    });
    expect(rowLink()).toEqual({ [ROW_LINK_ATTRIBUTE]: '', className: '' });
  });

  it('is what the stylesheet selects on: the stretch, the lift above it and the ring', () => {
    const rule = (selector: string): string => {
      const at = CSS.indexOf(`${selector} {`);
      expect(at, `styles.css has no rule for ${selector}`).toBeGreaterThan(-1);
      return CSS.slice(at, CSS.indexOf('}', at));
    };
    const stretch = rule(`.${ROW_LINK_HOST} [${ROW_LINK_ATTRIBUTE}]::after`);
    expect(stretch).toContain('position: absolute');
    expect(stretch).toContain('inset: 0');
    expect(rule(`.${ROW_LINK_HOST}`)).toContain('position: relative');
    expect(rule(`.${ROW_LINK_HOST}:has([${ROW_LINK_ATTRIBUTE}]):hover`)).toContain(
      'background-color',
    );
    expect(rule(`.${ROW_LINK_HOST} [${ROW_LINK_ATTRIBUTE}]:focus-visible::after`)).toContain(
      'outline',
    );
    // The lift: every other control in the row above the stretched one, in the components layer
    // (so `sr-only` still wins over its `relative`).
    const lift =
      /@layer components \{\s*\.row-link-host\s*:is\(([^)]*\([^)]*\)[^)]*)\):not\(\[data-row-link\]\) \{\s*position: relative;\s*z-index: 1;/.exec(
        CSS,
      );
    expect(lift, 'the lift rule is missing or out of the components layer').not.toBeNull();
    // Every control, anything with a native tooltip (a count's or a cost's `title=`, product/10:
    // every number shown has one) and the explicit lift class.
    for (const lifted of [
      'a[href]',
      'button',
      'input',
      'select',
      'summary',
      'label',
      '[title]',
      `.${ROW_LINK_LIFT}`,
    ]) {
      expect(lift?.[1]).toContain(lifted);
    }
    // A pulsing beacon after the link is painted above its `::after`, so it lets the press through.
    expect(rule(`.${ROW_LINK_HOST} .status-running`)).toContain('pointer-events: none');
  });
});

describe('a row with a row link', () => {
  it('is one link: the row is the host, and the title is the marked link', async () => {
    mount(() => undefined);
    const list = await screen.findByRole('list', { name: 'Projects' });
    const [linked, plain] = within(list).getAllByRole('listitem');
    expect(linked?.classList.contains(ROW_LINK_HOST)).toBe(true);
    const link = within(linked as HTMLElement).getByRole('link', { name: 'Demo service' });
    expect(link.hasAttribute(ROW_LINK_ATTRIBUTE)).toBe(true);
    expect(link.getAttribute('href')).toBe('/projects');
    // One stretched control per row.
    expect((linked as HTMLElement).querySelectorAll(`[${ROW_LINK_ATTRIBUTE}]`)).toHaveLength(1);
    // A row with nowhere to go has nothing to stretch, so the hover (`:has(...)`) never applies.
    expect((plain as HTMLElement).querySelector(`[${ROW_LINK_ATTRIBUTE}]`)).toBeNull();
    expect(within(plain as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('has no handler of its own: a click on the meta text navigates nowhere', async () => {
    // The guard against a row `onClick`: happy-dom has no layout, so this click is not under the
    // link's `::after` — it lands on the meta span and bubbles through the `<li>`. Only a handler on
    // the row (or on the box) could navigate from here, and the primitive forbids one.
    const router = mount(() => undefined);
    const meta = await screen.findByText('DEMO · 3 open');
    await act(async () => {
      fireEvent.click(meta);
    });
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('heading', { name: 'The projects page' })).toBeNull();
  });

  it('keeps a nested action’s own click, which does not navigate', async () => {
    const onAction = vi.fn();
    const router = mount(onAction);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/');
  });

  it('navigates when the link itself is clicked (the calibration of the two cases above)', async () => {
    const router = mount(() => undefined);
    await act(async () => {
      fireEvent.click(await screen.findByRole('link', { name: 'Demo service' }));
    });
    expect(await screen.findByRole('heading', { name: 'The projects page' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/projects');
  });
});
