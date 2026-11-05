/**
 * The built bundle runs under the Content-Security-Policy the server ships (WP-15j round 3).
 *
 * Round 2 shipped `frame-ancestors 'none'` alone and justified it with an inline theme script that
 * `apps/web/index.html` does not have. Round 3 measured the bundle and shipped the policy the
 * measurement allows (`apps/server/src/web/csp.ts`), which raises the question no unit test can
 * answer: **does the application still work under it?** A policy that blocks the product's only
 * screen is worse than no policy, and the only instrument that can tell is a browser.
 *
 * ## How this suite obtains that proof
 *
 * The Playwright harness serves the built bundle itself (`support/fake-backend.ts`), not through
 * `apps/server`'s fallback, so the header had to be added there — **imported** from the server's
 * own module rather than copied, because a fake that is kinder than the adapter proves nothing
 * (standing rule 1). Every spec in this directory therefore now drives the application under the
 * real policy; this file is the one that asserts it.
 *
 * Two halves, because either alone would be worthless:
 *
 *  1. **No violation while the application is used.** A listener registered before any page script
 *     collects `securitypolicyviolation` events through sign-in, a screen change and the
 *     lazily-imported route chunk; the suite fails on the first one, naming the directive.
 *  2. **The policy is actually being enforced** (standing rule 21: calibrate the instrument). An
 *     inline `<script>` and a `<style>` element are injected into the same page and must both be
 *     refused — without which "zero violations" would also be the reading for a browser that
 *     received no header at all.
 *
 * And two proofs TD-033 asked for before any screen depends on them: **Base UI opens under the
 * policy** — its menus and tooltips are positioned by Floating UI through CSSOM writes, which
 * `script-src 'self'` governs and `style-src 'self'` does not, so the top bar's account menu and a
 * `Metric` tooltip are opened in the built bundle and must appear, positioned, with no violation —
 * and **Inter is served by `'self'`**, so `font-src 'self'` stayed unchanged and the sign-in
 * headline is Inter Black. Since S-23.13a the woff2 is also **preloaded** (one request, in CORS
 * mode) and the font's OFL-1.1 text is served beside the bundle.
 *
 * Since S-23.5, the **flow canvas** (`@xyflow/react`, a lazy chunk with its own stylesheet) and the
 * first screen **Dialog** (Base UI, the stage dialog): the Pipeline tab's canvas is drawn, laid out
 * and opened in the built bundle, the task page's live canvas follows a `run:<id>` frame into its
 * stage dialog's log, both with no violation — and the live edge's dash animation stops under
 * reduced motion, which React Flow's own stylesheet does not do.
 *
 * Since S-23.6, the **Agents page's three views**: the fleet map (a second lazy canvas chunk), the
 * pixel office (a lazy chunk of SVG text grids, always the dark room) and the list, each over the
 * fixtures' three runs, two workers and hostile titles — drawn, opened and switched under the
 * policy, the tracker's text as text, and the office's bots still under reduced motion.
 *
 * Since S-23.13b, the **command palette** (a lazy chunk on a Base UI Dialog) and the **shortcuts
 * sheet**: opened with Ctrl+K, `/` and `?`, a ticket found by its key and taken with Enter, its
 * hostile title drawn as text, and a `g p` jump — with no violation.
 */
import type { SseFrame } from '@platform/contracts';
import { expect, type Page, test } from '@playwright/test';
import { HOSTILE, IDS, liveTranscriptEvent, PROJECT_KEY } from './support/fixtures.js';
import { publishFrame, resetBackend, signIn, waitForStreamCarrying } from './support/harness.js';

interface CollectedViolation {
  readonly directive: string;
  readonly blocked: string;
  readonly sample: string;
  readonly source: string;
}

declare global {
  interface Window {
    __cspViolations?: CollectedViolation[];
  }
}

/** Registers the collector before the first byte of application script runs. */
const collectViolations = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const collected: CollectedViolation[] = [];
    window.__cspViolations = collected;
    document.addEventListener('securitypolicyviolation', (event) => {
      collected.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        sample: event.sample,
        source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
      });
    });
  });
};

const violations = async (page: Page): Promise<CollectedViolation[]> =>
  await page.evaluate(() => window.__cspViolations ?? []);

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await collectViolations(page);
});

test('the shell is served under the policy and the application runs without a violation', async ({
  page,
}) => {
  const response = await page.goto('/');
  // The two directives this proof is about. The exact serialisation is asserted where it is
  // produced (`apps/server/src/web/web-serving.test.ts`, `test/e2e/server/web-bundle.e2e.test.ts`);
  // a third copy here would be a third thing to drift.
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("style-src 'self'");
  expect(policy).not.toContain('unsafe-inline');

  // Sign in, land on a screen, then take a route whose chunk is imported dynamically: a policy
  // that allowed the entry module and nothing else would fail here rather than on the first paint.
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();

  // Tailwind's stylesheet is what makes the theme visible at all: a `style-src` that blocked it
  // would leave a readable but unstyled page, which no assertion above would notice.
  const styling = await page.evaluate(() => ({
    stylesheets: document.styleSheets.length,
    rules: [...document.styleSheets].reduce((total, sheet) => total + sheet.cssRules.length, 0),
    lazyChunks: performance
      .getEntriesByType('resource')
      .filter((entry) => /\/assets\/run-route-[^/]+\.js$/.test(entry.name)).length,
  }));
  expect(styling.stylesheets).toBeGreaterThan(0);
  expect(styling.rules).toBeGreaterThan(0);
  expect(styling.lazyChunks).toBeGreaterThan(0);

  expect(await violations(page)).toEqual([]);
});

test('the policy is enforced: an inline script and a <style> element are both refused', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Tickets in, merge requests out.' }),
  ).toBeVisible();

  const probe = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__cspProbeRan = true;';
    document.head.append(script);
    const style = document.createElement('style');
    style.textContent = ':root { --csp-probe: applied }';
    document.head.append(style);
    return getComputedStyle(document.documentElement).getPropertyValue('--csp-probe').trim();
  });
  // Neither probe took effect: the custom property the `<style>` would have defined is absent, and
  // the global the inline script would have set is undefined.
  expect(probe).toBe('');
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>)['__cspProbeRan']),
  ).toBeUndefined();

  // The events are queued as tasks, so they are polled rather than waited for on a clock
  // (standing rule 2).
  await expect
    .poll(async () => (await violations(page)).map((violation) => violation.directive).sort(), {
      message: 'the browser recorded no policy violation for either probe',
    })
    .toEqual([expect.stringMatching(/^script-src/), expect.stringMatching(/^style-src/)]);
});

test('Base UI opens a menu and a tooltip under the policy without a violation (TD-033)', async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();

  // The account menu: a Base UI Menu, positioned by CSSOM writes.
  const trigger = page.getByRole('button', { name: 'Account menu' });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // One dark theme (TD-033's 2026-11-05 amendment): no theme group, nothing on `<html>`, and the
  // layers the owner asked for — the page on the top bar's deep night, the menu one step lighter.
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(15, 13, 34)',
  );
  expect(
    await page.getByRole('banner').evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(15, 13, 34)');
  expect(await menu.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(21, 19, 43)',
  );
  // Positioned against its trigger rather than left at the top of the document: the CSSOM write
  // took effect, which is what the policy question was.
  const [menuBox, triggerBox] = await Promise.all([menu.boundingBox(), trigger.boundingBox()]);
  expect(menuBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  if (menuBox !== null && triggerBox !== null) {
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);
    expect(Math.abs(menuBox.x + menuBox.width - (triggerBox.x + triggerBox.width))).toBeLessThan(
      40,
    );
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A Metric's definition: a Base UI Tooltip, opened from the keyboard.
  await page.goto('/stats');
  const label = page.getByText('Tasks delivered', { exact: true });
  await expect(label).toBeVisible();
  await label.focus();
  const tooltip = page.locator('[data-tooltip]');
  await expect(tooltip).toBeVisible();
  // The fixture's definition of `tasks_delivered` (`support/fixtures.ts`).
  await expect(tooltip).toHaveText(
    'Tasks whose merge request merged, counted at merge time (product/19 §10).',
  );
  const [tipBox, labelBox] = await Promise.all([tooltip.boundingBox(), label.boundingBox()]);
  if (tipBox !== null && labelBox !== null) {
    expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(labelBox.y + 1);
  }

  expect(await violations(page)).toEqual([]);
});

test('Inter is served from this origin and the sign-in headline is Inter Black (TD-033)', async ({
  page,
}) => {
  await page.goto('/');
  const headline = page.getByRole('heading', { name: 'Tickets in, merge requests out.' });
  await expect(headline).toBeVisible();
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const heading = document.querySelector('h1');
    const style = heading === null ? null : getComputedStyle(heading);
    return {
      family: style?.fontFamily ?? '',
      weight: style?.fontWeight ?? '',
      black: document.fonts.check('900 16px "Inter Variable"'),
      loaded: [...document.fonts].filter(
        (face) => face.family.replaceAll('"', '') === 'Inter Variable' && face.status === 'loaded',
      ).length,
      files: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.woff2')),
    };
  });
  expect(font.family).toMatch(/^"?Inter Variable"?,/);
  expect(font.weight).toBe('900');
  expect(font.black).toBe(true);
  expect(font.loaded).toBeGreaterThan(0);
  expect(font.files.length).toBeGreaterThan(0);
  for (const file of font.files) {
    expect(new URL(file).origin).toBe(new URL(page.url()).origin);
  }
  expect(await violations(page)).toEqual([]);
});

test('the woff2 is preloaded from this origin and Inter’s OFL text ships beside it (S-23.13a)', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Tickets in, merge requests out.' }),
  ).toBeVisible();
  // BACKLOG 801: one preload, for the very file the stylesheet's @font-face loads — in CORS mode,
  // or the browser fetches the font a second time.
  const preloads = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) => ({
      href: (link as HTMLLinkElement).href,
      type: link.getAttribute('type'),
      crossorigin: link.getAttribute('crossorigin'),
    })),
  );
  expect(preloads).toHaveLength(1);
  expect(preloads[0]?.type).toBe('font/woff2');
  expect(preloads[0]?.crossorigin).toBe('');
  expect(new URL(preloads[0]?.href ?? '').origin).toBe(new URL(page.url()).origin);
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.woff2'));
  });
  // Fetched once: the preload is the request the @font-face then uses.
  expect(loaded).toEqual([preloads[0]?.href]);
  // BACKLOG 803: OFL-1.1 condition 2 — the licence travels with the font.
  const licence = await request.get('/inter-OFL.txt');
  expect(licence.ok()).toBe(true);
  expect(licence.headers()['content-type']).toMatch(/^text\/plain/);
  const text = await licence.text();
  expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  expect(text).toContain('Copyright 2016 The Inter Project Authors');
  expect(await violations(page)).toEqual([]);
});

test('the flow canvas and its stage dialog open under the policy without a violation (S-23.5)', async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();

  // The Pipeline tab: a template, drawn by the lazy chunk, laid out left to right. It opens on the
  // start of its row at a zoom the names read at (S-23.13a: the whole thirteen-stage row fitted at
  // 0.26, which no name survives), and *Fit all* shows every stage.
  await page.setViewportSize({ width: 1190, height: 900 });
  await page.goto(`/projects/${PROJECT_KEY}/pipeline`);
  const template = page.locator('[data-flow-canvas="template"]');
  await expect(template).toBeVisible();
  const canvasBox = await page.getByTestId('flow-canvas-frame').first().boundingBox();
  // The template's canvas is the tall one (≈ 600 px), not a task's 380.
  expect(canvasBox?.height ?? 0).toBeGreaterThanOrEqual(560);
  const cards = template.locator('[data-stage-card]');
  await expect(cards).toHaveCount(15);
  const outside = async (): Promise<number> => {
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect),
    );
    return boxes.filter(
      (box) =>
        canvasBox === null ||
        box.left < canvasBox.x ||
        box.top < canvasBox.y ||
        box.right > canvasBox.x + canvasBox.width ||
        box.bottom > canvasBox.y + canvasBox.height,
    ).length;
  };
  /** React Flow's zoom: the scale of the viewport's transform. */
  const zoom = async (): Promise<number> =>
    await template
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  await expect
    .poll(zoom, { message: 'the template’s first view zooms out below 0.5' })
    .toBeGreaterThanOrEqual(0.5);
  // The first stage is in view on the first paint; some of the row is not, and is panned to.
  const firstBox = await template.locator('[data-stage-card]').first().boundingBox();
  expect(firstBox).not.toBeNull();
  if (firstBox !== null && canvasBox !== null) {
    expect(firstBox.x).toBeGreaterThanOrEqual(canvasBox.x);
    expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
  }
  expect(await outside()).toBeGreaterThan(0);
  await template.getByRole('button', { name: 'Fit all' }).click();
  await expect
    .poll(outside, { message: 'a stage card of the template is outside the canvas after Fit all' })
    .toBe(0);
  expect(await zoom()).toBeLessThan(0.5);
  const refinement = template.locator('[data-stage-card="refinement"]');
  const implementation = template.locator('[data-stage-card="implementation"]');
  await expect(implementation).toBeVisible();
  const [left, right] = await Promise.all([refinement.boundingBox(), implementation.boundingBox()]);
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  if (left !== null && right !== null) {
    // Positioned by CSSOM writes, which the policy does not govern: one row, in pipeline order.
    expect(right.x).toBeGreaterThan(left.x + left.width);
    expect(Math.abs(right.y + right.height / 2 - (left.y + left.height / 2))).toBeLessThan(2);
  }
  await expect(template.locator('[data-loop-pill="code_review"]')).toHaveText('Review ≤3');
  const lazyChunks = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        // The canvas's own chunk, and the library's with its stylesheet (`vite.config.ts`'s
        // `xyflow` group, shared with the fleet map since S-23.6).
        .filter((entry) => /\/assets\/(flow-canvas|xyflow)-[^/]+\.(js|css)$/.test(entry.name))
        .length,
  );
  expect(lazyChunks).toBe(3);

  // The stage dialog: a Base UI Dialog, opened from the card, closed by Escape, focus returned.
  await implementation.click();
  const configuration = page.getByRole('dialog', { name: 'Implementation' });
  await expect(configuration).toBeVisible();
  await expect(configuration).toContainText('Implementation notes');
  const box = await configuration.boundingBox();
  const viewport = page.viewportSize();
  if (box !== null && viewport !== null) {
    // Centred by its own classes: the stylesheet applied, the popup is not at the document's top.
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4);
    expect(box.y).toBeGreaterThan(0);
  }
  await page.keyboard.press('Escape');
  await expect(configuration).toBeHidden();
  await expect(implementation).toBeFocused();

  // The task page: the live graph, its live edge, and a run's dialog following the stream.
  await page.goto(`/tasks/${IDS.taskFeature}`);
  const live = page.locator('[data-flow-canvas="task"]');
  const current = live.locator('[data-stage-card="implementation"]');
  await expect(current).toHaveAttribute('data-stage-state', 'current');
  // DEMO-1 has an open question and a pending approval: what needs a person comes first.
  await expect(current).toContainText('Needs you');
  await expect(live.locator('.react-flow__edge.animated')).toHaveCount(1);
  await current.click();
  const dialog = page.getByRole('dialog', { name: 'Implementation' });
  await expect(dialog.getByRole('heading', { name: 'Live activity' })).toBeVisible();
  await expect(dialog.getByText('Running a command')).toBeVisible();
  const log = dialog.getByTestId('stage-log');
  await expect(log).toContainText('$ pnpm test');
  await expect(log).toContainText('12 passed');

  const runTopic = `run:${IDS.run}`;
  const probe: SseFrame = { frame: 'control', topic: runTopic, type: 'ping', detail: null };
  await waitForStreamCarrying(request, runTopic, probe, 'ping');
  const frame: SseFrame = {
    frame: 'transcript',
    topic: runTopic,
    seq: 6,
    data: liveTranscriptEvent,
  };
  expect(await publishFrame(request, runTopic, 'assistant', frame)).toBeGreaterThan(0);
  await expect(log).toContainText('Streamed after the page was fetched.');

  expect(await violations(page)).toEqual([]);
});

test('a live edge stops its dash animation under reduced motion (S-23.5)', async ({ page }) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  const animation = async (): Promise<string> =>
    await page
      .locator('[data-flow-canvas="task"] .react-flow__edge.animated path')
      .first()
      .evaluate((path) => getComputedStyle(path).animationName);

  await page.goto(`/tasks/${IDS.taskFeature}`);
  await expect(page.locator('[data-flow-canvas="task"] .react-flow__edge.animated')).toHaveCount(1);
  // Calibrated first: without the preference, React Flow's own animation runs.
  expect(await animation()).toBe('dashdraw');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(animation).toBe('none');
  expect(await violations(page)).toEqual([]);
});

test('the Agents page draws its map, office and list under the policy, titles as text (S-23.6)', async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });

  // The map: the default view, its own lazy chunk; a card per live run, the working one animated.
  await page.goto('/agents');
  const map = page.locator('[data-fleet-canvas]');
  await expect(map).toBeVisible();
  await expect(page.locator('[data-fleet-counts]')).toHaveText(
    '1 working · 2 need you · 1 waiting · 2 free seats',
  );
  const cards = map.locator('[data-fleet-run]');
  await expect(cards).toHaveCount(3);
  await expect(map.locator('[data-fleet-run]').filter({ hasText: 'DEMO-5' })).toContainText(
    `Flaky retries ${HOSTILE.image}`,
  );
  await expect(map.locator('.react-flow__edge.animated')).not.toHaveCount(0);
  await expect(map.locator('[data-fleet-node="seat"]')).toHaveCount(3);
  await page
    .getByRole('button', {
      name: /^DEMO-5 · Flaky retries .+ · Investigation · thinking · worker jan-mbp$/,
    })
    .click();
  const dialog = page.getByRole('dialog', { name: 'DEMO-5 · Investigation' });
  await expect(dialog.getByText(/Watch-only — the agent runs on/)).toContainText('jan-mbp');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The office: its own lazy chunk, the dark brand room on deep night, a desk per run.
  await page.getByRole('button', { name: 'Office' }).click();
  await expect(page).toHaveURL(/\?view=office$/);
  const office = page.locator('[data-office]');
  await expect(office).toBeVisible();
  expect(await office.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(15, 13, 34)',
  );
  await expect(
    office.getByRole('button', {
      name: /^DEMO-1 · Checkout .+ · Implementation · needs you · the platform server$/,
    }),
  ).toBeVisible();
  await expect(
    office.getByRole('button', {
      name: /^DEMO-6 · Export the invoice as CSV · Refinement · waiting: Starting · no seat yet$/,
    }),
  ).toBeVisible();
  await expect(office.locator('[data-door-plate]').filter({ hasText: 'night-owl' })).toHaveText(
    `night-owl ${HOSTILE.image}`,
  );
  // Calibrated first: the blink runs, then stops under reduced motion.
  const blink = office.locator('[data-desk] g.bot-blink').first();
  expect(await blink.evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'bot-blink',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () => await blink.evaluate((element) => getComputedStyle(element).animationName))
    .toBe('none');
  await expect(office).toHaveAttribute('data-motion', 'reduced');

  // The list: every run as a row.
  await page.getByRole('button', { name: 'List' }).click();
  // The rows themselves: each row's phase strip is a list of its own.
  await expect(page.getByRole('list', { name: 'Runs' }).locator(':scope > li')).toHaveCount(3);

  const loaded = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /\/assets\/(fleet-canvas|office|xyflow)-[^/]+\.(js|css)$/.test(name))
        .length,
  );
  // The map's chunk and the canvas library's, the office's — each a script and a stylesheet.
  expect(loaded).toBe(6);
  // No hostile string became an element.
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await expect(page.locator('img')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test('the command palette and the shortcuts sheet open under the policy, names as text (S-23.13b)', async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  // The board's tasks read is what the palette finds a ticket key in.
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText('DEMO-1').first()).toBeVisible();

  // Ctrl+K from the page: the palette's own lazy chunk, a Base UI Dialog, the field focused.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to' });
  await expect(palette).toBeVisible();
  const field = palette.getByRole('combobox', { name: 'Search or jump to' });
  await expect(field).toBeFocused();
  await field.fill('demo-1');
  const option = palette.getByRole('option').filter({ hasText: 'DEMO-1' });
  await expect(option).toHaveCount(1);
  // The ticket's title is the fixtures' hostile script, drawn as its characters.
  await expect(option).toContainText(`Checkout ${HOSTILE.script}`);
  await expect(palette.locator('script, img')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}$`));
  await expect(palette).toBeHidden();

  // `/` opens it too, and `g p` jumps once it is closed; `?` opens the sheet.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('/');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/projects$/);
  await page.keyboard.press('Shift+?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('The board, inside a project')).toBeVisible();

  const chunks = await page.evaluate(
    () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => /\/assets\/command-palette-[^/]+\.js$/.test(entry.name)).length,
  );
  expect(chunks).toBe(1);
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(await violations(page)).toEqual([]);
});
