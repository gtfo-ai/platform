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

test('a hostile scheme in a DTO url never reaches an href on the task screen', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();

  // The safe artifact URL is a link…
  await expect(page.locator(`main a[href="${HOSTILE.safeUrl}"]`).first()).toBeVisible();
  // …and the `vbscript:` and `file:` artifacts and the `data:` merge request are not.
  await assertNoHostileHref(page);
  // Each refused URL still shows its label, so nothing simply vanished.
  await expect(page.getByText('Merge request')).toBeVisible();
  await expect(page.getByText('ReviewVerdict')).toBeVisible();
  // Exactly three: the `data:` merge request and the `vbscript:` and `file:` artifacts. Counted
  // rather than bounded below, so a link that quietly disappears fails here too (rule 42).
  expect(await page.locator('[data-link-refused]').count()).toBe(3);

  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  await expect(page.getByRole('heading', { name: 'DEMO-2' })).toBeVisible();
  await expect(page.getByText('Ticket', { exact: true })).toBeVisible();
  await assertNoHostileHref(page);
});
