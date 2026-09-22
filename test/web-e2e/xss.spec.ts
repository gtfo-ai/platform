/**
 * Untrusted text, asserted against the **rendered DOM** in a real browser (BD-022).
 *
 * WP-10 shipped a Slack escape that its own link converter undid one function later, and the tests
 * that passed were asserting on the intermediate *string*. So nothing here inspects a string the
 * app produced: every assertion asks the live document what it contains — is there a `<script>`
 * inside the transcript, is there an `<img>`, does any anchor have a `javascript:` href, and did a
 * global set by an injected handler appear.
 *
 * The corpus is in `support/fixtures.ts` and it is deliberately hostile in the fields an attacker
 * controls: a ticket-derived question, a model's own text, a tool result, a provider setup guide, a
 * knowledge document, a project name — and the three **DTO url fields** a screen turns into a link
 * (`ticket.url`, `mr_ref.url`, `artifacts[].url`), which `urlSchema` accepts with any scheme at
 * all.
 */
import { expect, test } from '@playwright/test';
import { HOSTILE, IDS, PROJECT_KEY } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

/** Set by any of the payloads if one of them ever executes. */
const PWNED = 'window.__pwned';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
});

test('an injected project name renders as text, not as an element', async ({ page }) => {
  // Positive first: the harmless part of the name is on screen, so a blank page cannot pass.
  await expect(page.getByRole('link', { name: /Demo service/ })).toBeVisible();
  // And the payload is on screen too — as characters.
  await expect(page.getByText(HOSTILE.image, { exact: false })).toBeVisible();

  expect(await page.locator('main img').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();
});

test('an agent question renders script tags and markdown links as literal characters', async ({
  page,
}) => {
  await page.goto('/inbox');

  const card = page.locator('article, div').filter({ hasText: 'Should the retry budget be' });
  await expect(card.first()).toBeVisible();

  // The literal characters are present…
  await expect(
    page.getByText('<script>window.__pwned = true;</script>', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('[click me](javascript:', { exact: false })).toBeVisible();

  // …and no element was created from them.
  expect(await page.locator('main script').count()).toBe(0);
  expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();
});

test('the transcript renders model text, tool output and links safely', async ({ page }) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();

  // A fenced block became a code block, and its contents are text.
  await expect(page.locator('pre code').filter({ hasText: 'const limit = 3;' })).toBeVisible();

  // The safe URL became an anchor — so "no anchors at all" cannot be why the next assertion holds.
  const safeLink = page.locator(`main a[href="${HOSTILE.safeUrl}"]`).first();
  await expect(safeLink).toBeVisible();
  await expect(safeLink).toHaveAttribute('rel', 'noopener noreferrer nofollow');

  // The `javascript:` URL did not.
  expect(await page.locator('main a[href^="javascript:"]').count()).toBe(0);
  await expect(page.getByText(HOSTILE.javascriptUrl, { exact: false }).first()).toBeVisible();

  // No element was created from any payload anywhere in the transcript.
  expect(await page.locator('main script').count()).toBe(0);
  expect(await page.locator('main img').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();
});

test('a bidi override in tool output is replaced rather than allowed to reorder the line', async ({
  page,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  const output = page.locator('pre code').filter({ hasText: 'export const retries = 3;' });
  await expect(output).toBeVisible();

  const text = (await output.first().textContent()) ?? '';
  expect(text).toContain('export const retries = 3;');
  // U+202E is what makes a reviewer read a line backwards (CVE-2021-42574).
  expect(text).not.toContain('\u202E');
  expect(text).toContain('�');
});

test('ANSI sequences in shell output are stripped, not rendered as characters', async ({
  page,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  const terminal = page.getByTestId('terminal-block').first();
  await expect(terminal).toBeVisible();

  const text = (await terminal.textContent()) ?? '';
  expect(text).toContain('12 passed');
  expect(text).not.toContain('\u001B');
  expect(text).not.toContain('[32m');
});

test('a provider setup guide and a knowledge document are text as well', async ({ page }) => {
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Setup guide' }).click();
  await expect(page.getByText('Create an API token.')).toBeVisible();
  await expect(page.locator('pre code').filter({ hasText: 'JIRA_API_TOKEN' })).toBeVisible();
  expect(await page.locator('main script').count()).toBe(0);

  await page.goto(`/projects/${PROJECT_KEY}/knowledge`);
  await page.getByRole('button', { name: 'technical/architecture.md' }).click();
  await expect(page.getByText('# Architecture', { exact: false })).toBeVisible();
  expect(await page.locator('main script').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();
});

/**
 * The DTO half of the rule, and the one this suite was blind to until round 2.
 *
 * Five call sites put `task.ticket.url`, `task.mr_ref.url` and `artifact.url` straight into `href`.
 * The fixture named the field `safeUrl`, so no tier ever fed a hostile scheme there — and the DTO
 * is no defence either: `urlSchema` is `z.url()`, which accepts all four schemes below.
 *
 * **Every one of the four is carried by a DTO field this app renders**, which is not a detail: a
 * scheme that appears only in this list is an assertion with nothing behind it. `javascript:` is
 * the bug task's ticket, `data:` the feature task's merge request, `vbscript:` and `file:` its
 * second and third artifacts.
 *
 * **Why this is an assertion about the application and not about React.** React 19.3 rewrites a
 * `javascript:` href and *nothing else*: the same probe renders `data:text/html,<script>…</script>`,
 * `vbscript:` and `file:` verbatim. So three of the four counts below cannot be satisfied by the
 * framework — only by `safeHref`.
 */
const SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'] as const;

const assertNoHostileHref = async (page: import('@playwright/test').Page): Promise<void> => {
  for (const scheme of SCHEMES) {
    expect(await page.locator(`a[href^="${scheme}"]`).count(), scheme).toBe(0);
  }
  expect(await page.evaluate(PWNED)).toBeUndefined();
};

test('a hostile scheme in a DTO url never reaches an href on the board', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);

  // Positive control: the ticket URL that *is* http(s) is a working link with the full rel, so
  // "no hostile href" is not true because the board renders no links at all (standing rule 4).
  const safe = page.locator(`main a[href="${HOSTILE.safeUrl}"]`).first();
  await expect(safe).toBeVisible();
  await expect(safe).toHaveAttribute('rel', 'noopener noreferrer nofollow');

  // The assertion the fix exists for, before the ones about how a refusal *looks*: with the
  // `safeHref` call removed, this is the line that fails.
  await assertNoHostileHref(page);

  // The `javascript:` ticket and the `data:` merge request are on this screen as refused labels,
  // and they are the only two: a link that quietly disappeared would fail this too (rule 42).
  await expect(page.getByText('Open MR')).toBeVisible();
  expect(await page.locator('[data-link-refused]').count()).toBe(2);
});

/**
 * WP-41's two new rendering paths, both of which print text that did not come from this repository:
 * the board's conflict badge (a **peer's ticket key**, which is provider text — PROGRESS backlog
 * 63) and the statistics screen's *"not measured, and why"* prose.
 *
 * The badge is the more interesting of the two because it puts the same string in **two** places:
 * a text node and a `title` attribute. The attribute cannot become markup, but it can carry a bidi
 * override into a tooltip, which is why it goes through `sanitiseUntrusted` rather than straight in.
 */
test('a peer ticket key on the board and a stated absence are text, not markup', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  // Positive first (standing rule 4): the badge is on screen at all, so "no script" is not true
  // because the board rendered nothing.
  await expect(page.getByText(/touches/).first()).toBeVisible();
  await expect(page.getByText(HOSTILE.script, { exact: false }).first()).toBeVisible();
  expect(await page.locator('main script').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();

  await page.goto('/stats');
  await expect(page.getByText('Not measured, and why')).toBeVisible();
  // The reason carries an `<img onerror=…>`; it is on screen as characters and there is no image.
  await expect(page.getByText(HOSTILE.image, { exact: false })).toBeVisible();
  expect(await page.locator('main img').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();
});

test('a hostile scheme in a DTO url never reaches an href on the task screen', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();

  /**
   * **The artifact list stopped rendering `artifact.url` as an href at WP-52**, so the three
   * fixture artifacts below (one safe URL, a `vbscript:` and a `file:`) reach no attribute at all.
   *
   * That is a *narrowing* of the sink rather than a loss of coverage, and it is asserted as one:
   * the artifact row is now a router `Link` to `?artifact=<id>` — the panel that renders the body —
   * because the body is shown on this screen instead of downloaded, and `url` on the DTO is the
   * **API** path (`apiPathSchema`), which is what an OpenAPI consumer needs and what a browser must
   * not be sent to. The hostile-scheme property is still asserted for the whole screen below.
   */
  // The positive control stays the **ticket** link, which is still a rendered DTO URL on this
  // screen (`HOSTILE.safeUrl`), so "no hostile href" is not true because nothing links at all.
  await expect(page.locator(`main a[href="${HOSTILE.safeUrl}"]`).first()).toBeVisible();
  // The artifact rows are links this app built — `?artifact=<id>` — and carry no DTO URL.
  await expect(page.locator('main a[href*="artifact="]').first()).toBeVisible();
  // …and the `vbscript:` and `file:` artifacts and the `data:` merge request reach no href.
  await assertNoHostileHref(page);
  // Each refused URL still shows its label, so nothing simply vanished. `exact` because
  // `getByText` with a string matches a **substring**, case-insensitively: WP-29 put the words
  // "merge request" into the human-time metric's definition text, two elements matched, and
  // Playwright's strict mode failed the locator rather than the assertion. The label is what this
  // line is about, so the locator now says so.
  await expect(page.getByText('Merge request', { exact: true })).toBeVisible();
  await expect(page.getByText('ReviewVerdict')).toBeVisible();
  // Exactly two: the `data:` merge request and — since WP-38 — the dependency whose registry page
  // the fixture gives a `data:` URL. It was **four** until WP-52: the `vbscript:` and `file:`
  // artifacts were refused *by `safeHref` at render time*, and now they are not rendered as URLs at
  // all, so there is nothing to refuse. Counted rather than bounded below, so a link that quietly
  // disappears fails here too (rule 42).
  await expect(page.getByText('npm:left-pad', { exact: true })).toBeVisible();
  expect(await page.locator('[data-link-refused]').count()).toBe(2);

  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  await expect(page.getByRole('heading', { name: 'DEMO-2' })).toBeVisible();
  await expect(page.getByText('Ticket', { exact: true })).toBeVisible();
  await assertNoHostileHref(page);
});

/**
 * WP-29 put a **provider account id** on the task screen — the per-user breakdown of product/18:32
 * — and a provider account id is somebody else's text (BD-022).
 *
 * The fixture's second row is `gitlab:<script>…</script>`, so this asserts the two things the rule
 * is made of: the characters are there as text, and no element was created from them.
 */
test('a provider account in the human-time breakdown is text, not markup', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();

  await expect(page.getByText('gitlab:<script>window.__pwned', { exact: false })).toBeVisible();
  expect(await page.locator('main script').count()).toBe(0);
  expect(await page.evaluate(PWNED)).toBeUndefined();

  // And the two numbers product/09:29 keeps apart are both on the screen, unsummed.
  await expect(page.getByText('tokens ·', { exact: false })).toBeVisible();
  await expect(page.getByText('2 h 23 m human', { exact: false })).toBeVisible();
});
