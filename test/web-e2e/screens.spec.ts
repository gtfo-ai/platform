/**
 * The screens, asserted positively: named content is present, not "no error appeared".
 *
 * A negative assertion passes on a blank page and on a broken harness alike (standing rule 4), so
 * every test here names the thing it expects to see — this ticket key, this stage, this budget bar
 * — and the ones that exercise a command assert the *server* observed it by reading the state
 * back.
 */
import { expect, test } from '@playwright/test';
import { IDS, PROJECT_KEY } from './support/fixtures.js';
import { commandLog, resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
});

test('the dashboard shows the organisation metrics and the project', async ({ page }) => {
  await expect(page.getByText('Spend, 30 days')).toBeVisible();
  // Twice on this screen: the organisation total and the project's own 30-day spend.
  await expect(page.getByText('$12.50')).toHaveCount(2);
  await expect(page.getByRole('link', { name: /Demo service/ })).toBeVisible();
});

test('the board puts each task in the column its state belongs to', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);

  const active = page.getByRole('region', { name: 'Active' });
  const waiting = page.getByRole('region', { name: 'Needs human' });
  await expect(active.getByRole('link', { name: 'DEMO-1' })).toBeVisible();
  await expect(waiting.getByRole('link', { name: 'DEMO-2' })).toBeVisible();
  await expect(active.getByText('implementation')).toBeVisible();
  // The iteration counter product/10 asks for ("review 2/3" in its example).
  await expect(active.getByText('review 1')).toBeVisible();
});

test('the task detail shows the stage timeline, the runs and the checks panel', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);

  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  // Scoped to the timeline: `refinement` is also an option of the stage-command select.
  await expect(page.locator('ol').getByText('refinement')).toBeVisible();
  await expect(page.getByText('spec accepted')).toBeVisible();
  await expect(page.getByRole('link', { name: 'implementation · developer' })).toBeVisible();
  await expect(page.getByText('Cost so far', { exact: true })).toBeVisible();
  // WP-28: the refinement estimate, what it rests on and product/19 §10's accuracy — three numbers
  // the Checks panel showed as `$0.00` under the label *"Estimate"* before this row, because it read
  // `cost_estimated_usd` (a column nothing writes) instead of `estimate_usd`.
  await expect(page.getByText('$12.00')).toBeVisible();
  await expect(page.getByText('From 7 finished tasks in this project.')).toBeVisible();
  await expect(page.getByText('0.35×')).toBeVisible();
  await expect(page.getByText('payments')).toBeVisible();
});

test('answering a question sends the command and the question leaves the inbox', async ({
  page,
}) => {
  await page.goto('/inbox');
  const answerBox = page.getByLabel(`Answer question ${IDS.question}`);
  await expect(answerBox).toBeVisible();

  await answerBox.fill('three');
  await page.getByRole('button', { name: 'Answer' }).first().click();

  // The fake backend removes an answered question from `GET /api/org/inbox`, so the box
  // disappearing is evidence the POST arrived — with its CSRF header, which the fake enforces.
  await expect(answerBox).toHaveCount(0);
  // The pending approval is untouched, so the screen did not simply empty itself.
  await expect(page.getByRole('link', { name: 'Decide on the task' })).toBeVisible();
});

test('the agents view lists the running run and links to it', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.getByRole('link', { name: 'implementation · developer' })).toBeVisible();
  await expect(page.getByText('claude-opus-5')).toBeVisible();
});

test('the audit log renders an entry with its diff', async ({ page }) => {
  await page.goto('/audit');
  await expect(page.getByText('project', { exact: true })).toBeVisible();
  await expect(page.getByText('autonomy_level')).toBeVisible();
});

test('settings shows the session, the user list and the instance version', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('operator@example.invalid').first()).toBeVisible();
  await expect(page.getByText('0.0.0-fake')).toBeVisible();
  await expect(page.getByLabel('Theme preference')).toHaveValue('system');
});

test('org settings carries the organisation budgets WP-30 gave it a writer for', async ({
  page,
}) => {
  // The sentence this file's own screen used to carry — *"global budgets … need `GET/PATCH /api/org`,
  // which no work package has built"* — is false since WP-30, and the control is what makes it so.
  await page.goto('/settings');
  await expect(page.getByText('Organisation budgets')).toBeVisible();
  await expect(page.getByText('spent $3.25 of $40.00 this window')).toBeVisible();
});

test('the project settings page mirrors every wizard step', async ({ page }) => {
  // product/18:55 — *"nothing is only reachable during onboarding"*. Driven against the built
  // bundle, so this is the one tier that shows the route exists and the page renders in a browser.
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  for (const heading of [
    'Connections',
    'Technical discovery and readiness',
    'Business context',
    'Autonomy dial',
    'Features',
    'Risk classes',
    'Project budgets',
    'Notifications',
    'Who changed what',
  ]) {
    await expect(page.getByText(heading, { exact: true })).toBeVisible();
  }
  // BD-027's *Custom* with the differences listed, and the audit row that says who moved the dial.
  await expect(page.getByText('Custom', { exact: true })).toBeVisible();
  await expect(page.getByText('preset 5, in force 2')).toBeVisible();
  await expect(page.getByText('project.autonomy.write')).toBeVisible();
  /**
   * …and the risk-class step, which stopped being a named gap at **WP-37**: the offer is a control
   * that does something (accepting it writes `policies.risk_classes` through the configuration
   * endpoint), and the one row of product/19 §14 this build still cannot express is rendered with
   * its reason instead. Standing rule 83 — the sentence this assertion used to pin described the
   * gap that work package closed.
   */
  await expect(page.getByRole('button', { name: 'Accept these classes' })).toBeVisible();
  await expect(page.getByText(/Not proposed, and why/)).toBeVisible();
});

test('the integrations screen carries the create and test controls', async ({ page }) => {
  // PROGRESS backlog 55: `POST /api/integrations` was served and no component called it, so the
  // product's front door had a step that could only be taken with `curl`.
  await page.goto('/integrations');
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add integration' })).toBeVisible();
  await expect(page.getByLabel('Environment variable')).toBeVisible();
});

test('the theme control switches the document theme', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Theme preference').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme preference').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('the project panels render the vault, the proposals and the budget meter', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/knowledge`);
  await expect(page.getByRole('button', { name: 'technical/architecture.md' })).toBeVisible();
  await expect(page.getByText('lessons/retries.md').first()).toBeVisible();
  await expect(page.getByText('significance 0.72')).toBeVisible();

  await page.goto(`/projects/${PROJECT_KEY}/budgets`);
  await expect(page.getByLabel('Budget used')).toBeVisible();
  await expect(page.getByText('$100.00')).toBeVisible();

  await page.goto(`/projects/${PROJECT_KEY}/pipeline`);
  await expect(page.getByText('fakehash1')).toBeVisible();
});

test('statistics says plainly that it has no data source yet', async ({ page }) => {
  await page.goto('/stats');
  await expect(page.getByText('Statistics are not available on this instance yet')).toBeVisible();
  await expect(page.getByText('Clean first-MR rate')).toBeVisible();
});

test('the integrations screen loads a provider setup guide on demand', async ({ page }) => {
  await page.goto('/integrations');
  await expect(page.getByText('Jira (fake)')).toBeVisible();
  await page.getByRole('button', { name: 'Setup guide' }).click();
  await expect(page.getByText('Create an API token.')).toBeVisible();
});

/**
 * The stage commands of technical/09's screens table, proved by what the **server** received.
 *
 * The fixtures are static, so the screen looks the same whether the POST arrived or not; every
 * assertion here therefore reads the fake backend's command log, which parses each body with the
 * schema `packages/contracts` publishes for that command and 400s a body that does not match.
 */
test('the task screen sends retry-stage, return-to-stage, rework and feedback', async ({
  page,
  request,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  expect(await commandLog(request), 'the log was not empty before the first click').toEqual([]);

  await page.getByLabel('Stage').selectOption('refinement');
  await page.getByRole('button', { name: 'Retry stage' }).click();
  await expect
    .poll(async () => (await commandLog(request)).map((entry) => entry.path))
    .toContain(`/api/tasks/${IDS.taskFeature}/retry-stage`);

  // `returnToStageRequestSchema` requires a reason, so the button stays disabled without one —
  // the client refuses a request the server would reject rather than sending it.
  const returnButton = page.getByRole('button', { name: 'Return to stage' });
  await expect(returnButton).toBeDisabled();
  await page.getByLabel('Reason').fill('the spec missed the retry budget');
  await expect(returnButton).toBeEnabled();
  await returnButton.click();

  await page.getByLabel('Rework instructions').fill('split the helper out');
  await page.getByRole('button', { name: 'Rework' }).click();

  await page.getByLabel('Feedback on this task').fill('the plan was good');
  await page.getByRole('button', { name: 'Send feedback' }).click();

  await expect.poll(async () => (await commandLog(request)).length).toBeGreaterThanOrEqual(4);

  const log = await commandLog(request);
  const bodyOf = (suffix: string): Record<string, unknown> =>
    log.find((entry) => entry.path.endsWith(suffix))?.body ?? {};

  expect(bodyOf('/retry-stage')).toEqual({ stage: 'refinement' });
  expect(bodyOf('/return-to-stage')).toEqual({
    stage: 'refinement',
    reason: 'the spec missed the retry budget',
  });
  expect(bodyOf('/rework')).toEqual({ stage: 'refinement', instructions: 'split the helper out' });
  expect(bodyOf('/feedback')).toEqual({ scope: 'task', text: 'the plan was good' });
});

test('the run screen retries with a model and an effort, and sends stage-scoped feedback', async ({
  page,
  request,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByRole('heading', { name: 'implementation · developer' })).toBeVisible();

  await page.getByLabel('Retry with model').fill('claude-sonnet-5');
  await page.getByLabel('Retry with effort').selectOption('low');
  await page.getByRole('button', { name: 'Retry run' }).click();
  await expect(page.getByText('A new run was requested')).toBeVisible();

  await page.getByLabel('Feedback on the implementation stage').fill('too many retries');
  await page.getByRole('button', { name: 'Good' }).click();
  await page.getByRole('button', { name: 'Send feedback' }).click();

  await expect.poll(async () => (await commandLog(request)).length).toBeGreaterThanOrEqual(2);
  const log = await commandLog(request);

  expect(log.find((entry) => entry.path === `/api/runs/${IDS.run}/retry`)?.body).toEqual({
    model: 'claude-sonnet-5',
    effort: 'low',
  });
  // Feedback goes to the **task's** route, scoped to the run's stage.
  expect(log.find((entry) => entry.path.endsWith('/feedback'))).toEqual({
    path: `/api/tasks/${IDS.taskFeature}/feedback`,
    body: { scope: 'stage', stage: 'implementation', text: 'too many retries', rating: 5 },
  });
});

test('the fake backend refuses a command body the published schema rejects', async ({ page }) => {
  // The fake must be **stricter** than the real server, never kinder (standing rule 1): it parses
  // every command body with the schema `packages/contracts` publishes, so a client that forgets a
  // required field cannot pass a Playwright test that the real server would 400. Asserted through
  // the page's own request context, so the session cookie and the CSRF headers are the real ones.
  const origin = new URL(page.url()).origin;
  const headers = { origin, 'x-requested-with': 'XMLHttpRequest' };

  const missingReason = await page.request.post(`/api/tasks/${IDS.taskFeature}/return-to-stage`, {
    data: { stage: 'refinement' },
    headers,
  });
  expect(missingReason.status(), 'a body missing a required field was accepted').toBe(400);

  // And the same body with the field is accepted, so the 400 is about the field.
  const complete = await page.request.post(`/api/tasks/${IDS.taskFeature}/return-to-stage`, {
    data: { stage: 'refinement', reason: 'because' },
    headers,
  });
  expect(complete.status()).toBe(200);
});

test('a queued task says there is no stage to act on rather than offering a broken control', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  await expect(page.getByRole('heading', { name: 'DEMO-2' })).toBeVisible();
  await expect(page.getByText('No stage to act on yet')).toBeVisible();
  await expect(page.getByLabel('Stage')).toHaveCount(0);
});
