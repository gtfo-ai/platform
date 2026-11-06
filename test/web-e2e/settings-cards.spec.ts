/**
 * **Every Settings page sits on a card** (S-25.10b, TD-033's 2026-11-05 amendment).
 *
 * Found in a Chrome check against this fake backend: Settings → Policies drew its form straight on
 * the page canvas while Budgets drew its form in a card. The rule is the owner's — cards, boxes,
 * blankslates, dialogs and menus sit on `--bg-default`, the page is `--bg-canvas`, fields are
 * `bg-inset` — and `apps/web/src/card-ground-census.test.ts` could not see this class: it reads a
 * *bordered* element without a ground, and a form with no box at all has neither.
 *
 * ### What is read
 *
 * Every org settings section and every Admin screen the NavList links to — **from the table**
 * (`ORG_SETTINGS_GROUPS`), so a new section is held the moment it exists and must name what it
 * waits for — plus the screens drawn inside the same frame at their own URLs (an integration's
 * page and its setup guide, the machine approval). Each is opened as the fixture backend's
 * administrator, its content is awaited, and then every visible text node inside
 * `[data-settings-section]` must have an ancestor, up to the section itself, whose **computed**
 * background is neither transparent nor the canvas — a card, a list box, a blankslate, a notice's
 * tint or a button's own fill. Computed in a browser, so a class that names a ground and paints
 * none is caught too.
 *
 * ### What may stand on the canvas
 *
 * The section's own header and the page header (`[data-page-header]`), a heading, a navigation
 * (an integration's tabs), visually hidden text, and a paragraph (`<p>`): a line of prose — an
 * introduction, a count, a note under a list — is the page's, not a box's. That last exemption is
 * the residual, stated rather than implied: a `<p>` inside a form on the canvas is not reported,
 * though the form's labels are.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  ORG_SETTINGS_GROUPS,
  type OrgAdminLinkId,
  type OrgSettingsSectionId,
} from '../../apps/web/src/features/settings-sections.js';
import { IDS } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

/** The page colour, `--bg-canvas` (deep night): no box's ground. */
const CANVAS = 'rgb(15, 13, 34)';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

const sectionOf = (page: Page): Locator => page.locator('[data-settings-section]');

/** What each section shows once its reads have answered — what the scan waits for. */
const READY: Readonly<
  Record<OrgSettingsSectionId | OrgAdminLinkId, (section: Locator) => Locator>
> = {
  policies: (section) => section.getByLabel('Organisation autonomy maximum'),
  notifications: (section) => section.getByLabel('Organisation default chat account'),
  budgets: (section) => section.getByText('spent $3.25 of $40.00 this window'),
  users: (section) => section.getByRole('list', { name: 'Users' }).getByText('Fake Operator'),
  identities: (section) => section.getByText('U0FAKEOPERATOR').first(),
  integrations: (section) => section.getByRole('link', { name: 'Jira (fake)' }).first(),
  workers: (section) => section.getByText('jan-mbp').first(),
  audit: (section) => section.getByText('changed the settings of', { exact: false }).first(),
  'dead-letters': (section) => section.locator('[data-dead-letter="4242"]'),
  'failed-jobs': (section) => section.locator('[data-failed-job]').first(),
  instance: (section) => section.getByText('0.0.0-fake'),
  session: (section) => section.getByText('operator@example.invalid'),
  keyboard: (section) => section.getByRole('checkbox'),
};

interface Screen {
  readonly name: string;
  readonly path: string;
  readonly ready: (section: Locator) => Locator;
}

const SCREENS: readonly Screen[] = [
  ...ORG_SETTINGS_GROUPS.flatMap((group) =>
    group.sections.map(
      (section): Screen => ({
        name: section.label,
        path: 'to' in section ? section.to : `/settings/${section.id}`,
        ready: READY[section.id],
      }),
    ),
  ),
  // Drawn inside the same frame at their own URLs (`features/admin-frame.tsx`).
  {
    name: 'an integration',
    path: `/integrations/${IDS.integration}`,
    ready: (section) => section.locator('[data-health-facts]'),
  },
  {
    name: 'an integration’s setup guide',
    path: `/integrations/${IDS.integration}?tab=setup-guide`,
    ready: (section) => section.locator('[data-setup-guide]'),
  },
  {
    name: 'approving a machine',
    path: '/workers/approve',
    ready: (section) => section.getByLabel('Code shown by the machine'),
  },
];

/** Every visible text in `root` that no ground stands under, as `<tag> text`. */
const textOnTheCanvas = (root: Locator): Promise<string[]> =>
  root.evaluate((section, canvas) => {
    const CHROME = 'h1, h2, h3, h4, h5, h6, p, nav, [data-page-header], .sr-only';
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
      if (text === '' || parent === null || parent.closest(CHROME) !== null) {
        continue;
      }
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        continue;
      }
      if (!grounded(parent)) {
        found.push(`<${parent.tagName.toLowerCase()}> ${text.slice(0, 60)}`);
      }
    }
    return found;
  }, CANVAS);

test('the scan finds text on the canvas, and passes it once it is on a card (the canary)', async ({
  page,
}) => {
  await page.goto('/settings/instance');
  const section = sectionOf(page);
  await expect(READY.instance(section)).toBeVisible();
  // The Instance facts as they stood before S-25.10b: a definition list straight on the page.
  await section.evaluate((element) => {
    const bare = document.createElement('dl');
    bare.dataset['canary'] = '';
    const term = document.createElement('dt');
    term.textContent = 'Version';
    const value = document.createElement('dd');
    value.textContent = '0.0.0-canary';
    bare.append(term, value);
    element.append(bare);
  });
  expect(await textOnTheCanvas(section)).toEqual(['<dt> Version', '<dd> 0.0.0-canary']);
  await section.locator('[data-canary]').evaluate((element) => {
    element.setAttribute('class', 'bg-default');
  });
  expect(await textOnTheCanvas(section)).toEqual([]);
});

for (const screen of SCREENS) {
  test(`Settings: ${screen.name} sits on a card (${screen.path})`, async ({ page }) => {
    await page.goto(screen.path);
    const section = sectionOf(page);
    await expect(screen.ready(section)).toBeVisible();
    expect(await textOnTheCanvas(section), screen.path).toEqual([]);
  });
}
