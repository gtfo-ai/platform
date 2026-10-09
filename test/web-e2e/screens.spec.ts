/**
 * The screens, asserted positively: named content is present, not "no error appeared".
 *
 * A negative assertion passes on a blank page and on a broken harness alike (standing rule 4), so
 * every test here names the thing it expects to see — this ticket key, this stage, this budget bar
 * — and the ones that exercise a command assert the *server* observed it by reading the state
 * back.
 */
import { expect, test } from '@playwright/test';
import { failedJobs, IDS, PROJECT_KEY } from './support/fixtures.js';
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
  // The stage's outcome word, through the word→sentence table (WP-73, backlog 213).
  await expect(page.getByText('Verdict: approve.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'implementation · developer' })).toBeVisible();
  await expect(page.getByText('Cost so far', { exact: true })).toBeVisible();
  // WP-28: the refinement estimate, what it rests on and product/19 §10's accuracy — three numbers
  // the Checks panel showed as `$0.00` under the label *"Estimate"* before this row, because it read
  // `cost_estimated_usd` (then a column nothing wrote; since WP-47 a projection over the ledger's
  // estimated entries) instead of `estimate_usd`.
  await expect(page.getByText('$12.00')).toBeVisible();
  await expect(page.getByText('From 7 finished tasks in this project.')).toBeVisible();
  await expect(page.getByText('0.35×')).toBeVisible();
  await expect(page.getByText('payments')).toBeVisible();
  /**
   * WP-39's Checks item, in a browser against the built bundle: the **signed** delta and the base
   * it was measured against. product/18:38's *"coverage delta shown in Checks"* is this line, and
   * the base is named on the screen rather than assumed (standing rule 63).
   */
  await expect(page.getByText('Coverage delta', { exact: true })).toBeVisible();
  await expect(page.getByText('+2.5 pp')).toBeVisible();
  await expect(page.getByText(/81\.5 % on bbbbbbb, against 79\.0 % on main/)).toBeVisible();
  /**
   * WP-38's two Checks items, in the browser: the dependency the gate found with the licence a
   * **registry** published, and the reviewers the routing asked for — including the handle it could
   * not resolve, which is the fact the `set_reviewers` audit row cannot record.
   */
  await expect(page.getByText('Dependencies', { exact: true })).toBeVisible();
  await expect(page.getByText('1 added · waiting')).toBeVisible();
  // Strict-mode exact: the same package is named twice on this panel — once in the sentence with
  // its licence, and once as the registry link `safeHref` refused (`xss.spec.ts` counts that one).
  await expect(page.getByText('npm:left-pad', { exact: true })).toBeVisible();
  await expect(page.getByText('Required reviewers', { exact: true })).toBeVisible();
  await expect(page.getByText('1 of 2 assigned, 1 unresolved')).toBeVisible();
  /**
   * WP-46's five items, in the browser: the review window's counts off `tasks.review_threads`, a
   * gate this fixture's task has not reached said as such rather than ticked, and no Acceptance
   * Verdict said as such rather than drawn as approved.
   */
  await expect(page.getByText('Review threads', { exact: true })).toBeVisible();
  await expect(page.getByText('2 open · 1 resolved')).toBeVisible();
  await expect(page.getByText('CI status', { exact: true })).toBeVisible();
  await expect(page.getByText('This task has not entered ci_gate.')).toBeVisible();
  await expect(page.getByText('Business verdict', { exact: true })).toBeVisible();
  await expect(page.getByText('no verdict', { exact: true })).toBeVisible();
  // …and since WP-81 the eleventh, the tamper check, is answered too — off the CI gate's row, so on
  // this fixture it says *not reached* like CI status — and the panel carries no apology for an
  // absent item (`checks-panel.test.tsx` holds the whole census both ways).
  await expect(page.getByText('Tamper check', { exact: true })).toBeVisible();
  await expect(page.getByText(/Not on this panel/)).toHaveCount(0);
});

test('a task whose gate has not run says so, rather than saying nothing was added', async ({
  page,
}) => {
  // The dependency half of the rule above (WP-38): *"not checked"* is the gate not having run and
  // *"none added"* is it having run and found nothing — and a blank would be neither (rule 18).
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  await expect(page.getByText('Dependencies', { exact: true })).toBeVisible();
  await expect(page.getByText('not checked', { exact: true })).toBeVisible();
  await expect(page.getByText('Required reviewers', { exact: true })).toBeVisible();
  // `exact`, because the sentence beneath the metric also contains the words (strict mode).
  await expect(page.getByText('not routed', { exact: true })).toBeVisible();
});

test('a task nothing has measured says so, rather than showing a zero coverage delta', async ({
  page,
}) => {
  // The failure mode WP-39 exists to avoid, asserted in the browser: `0.0 pp` under "Coverage
  // delta" reads as *"the agent added no coverage"* (standing rule 16), so the absent case has its
  // own words and its own test rather than sharing the measured one's rendering.
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  await expect(page.getByText('Coverage delta', { exact: true })).toBeVisible();
  await expect(page.getByText('not measured')).toBeVisible();
  await expect(page.getByText('0.0 pp')).toHaveCount(0);
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

test('org settings lists the provider identities and offers the mapping form (WP-43)', async ({
  page,
}) => {
  // PROGRESS backlog 79: `POST /api/org/identities` was served and no screen called it, so every
  // decision from Slack, Jira or GitLab stayed `unmapped_identity`.
  await page.goto('/settings');
  await expect(page.getByText('Provider identities', { exact: true })).toBeVisible();
  await expect(page.getByText('U0FAKEOPERATOR')).toBeVisible();
  // The display name is provider text: its markup is on the screen as characters, not an element.
  await expect(page.getByText('<img src=x onerror=alert(1)>operator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeVisible();
});

test('org settings shows the organisation document and saves a section through PATCH /api/org (WP-93)', async ({
  page,
  request,
}) => {
  // PROGRESS backlogs 146 (2) and 223: the organisation layer had no writer but SQL.
  await page.goto('/settings');
  await expect(page.getByText('Organisation settings', { exact: true })).toBeVisible();
  // The stored list is administrator text: held as a value, never parsed into an element.
  await expect(page.getByLabel('Organisation command block list')).toHaveValue(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.getByLabel('Organisation autonomy maximum')).toHaveValue('supervised');

  await page.getByLabel('Organisation autonomy maximum').selectOption('assist');
  await page.getByRole('button', { name: 'Save autonomy maximum' }).click();
  await expect
    .poll(async () => (await commandLog(request)).filter((entry) => entry.path === '/api/org'))
    .toEqual([{ path: '/api/org', body: { autonomy: { maximum: 'assist' } } }]);
});

test('org settings lists a dead letter with its re-queue control (WP-96, backlog 326)', async ({
  page,
}) => {
  // Until WP-96 the fake answered this read with its 404, so the bundle drew only the error notice.
  await page.goto('/settings');
  const letter = page.locator('[data-dead-letter="4242"]');
  await expect(letter).toBeVisible();
  await expect(letter.getByText('pipeline.saga')).toBeVisible();
  // Handler text is untrusted: its markup is on the screen as characters.
  await expect(letter.getByText('boom <script>window.__pwned = true;</script>')).toBeVisible();
  await expect(letter.getByRole('button', { name: 'Re-queue' })).toBeVisible();
  await expect(page.getByText('The dead letters could not be loaded.')).toHaveCount(0);
});

test('org settings lists a failed job beside the dead letters, with no re-queue (WP-108, backlog 325)', async ({
  page,
}) => {
  await page.goto('/settings');
  const job = page.locator(`[data-failed-job="${failedJobs.items[0]?.id ?? 'missing'}"]`);
  await expect(job).toBeVisible();
  await expect(job.getByText('pipeline.outbound')).toBeVisible();
  // Handler text is untrusted: its markup is on the screen as characters.
  await expect(job.getByText('outbound <script>window.__pwned = true;</script>')).toBeVisible();
  // WP-124: the census row's shape decides the sentence; the outbound queue's differs per duty.
  await expect(
    job.getByText('What recovers it depends on the duty it carried', { exact: false }),
  ).toBeVisible();
  await expect(job.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('The failed jobs could not be loaded.')).toHaveCount(0);
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
   * endpoint). Since **WP-45** every row of product/19 §14 is proposed, and the `payments`
   * checklist the offer selects is asked for by name — the accept button waits for its items,
   * because the configuration schema refuses a class naming a list nobody wrote. Standing rule 83:
   * the *"Not proposed, and why"* panel this assertion used to pin described the gap WP-45 closed.
   */
  const accept = page.getByRole('button', { name: 'Accept these classes' });
  await expect(accept).toBeVisible();
  await expect(accept).toBeDisabled();
  const items = page.getByRole('textbox', { name: 'Items for checklist payments' });
  await expect(items).toBeVisible();
  await items.fill('Amounts are integer minor units');
  await expect(accept).toBeEnabled();
  await expect(page.getByText(/Not proposed, and why/)).toHaveCount(0);
});

test('the project settings page re-evaluates readiness with its ceiling on the button (WP-94)', async ({
  page,
  request,
}) => {
  // PROGRESS backlog 230, Q107 (a): discovery again on a maintainer's click. The ceiling is the
  // server's figure, and pressing the button sends one keyed command the fake backend logged.
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  const button = page.getByRole('button', { name: /Re-evaluate readiness — up to \$2\.00/ });
  await expect(button).toBeVisible();
  await expect(page.getByText(/the last discovery cost \$0\.84/)).toBeVisible();
  await button.click();
  await expect(page.getByText('the Discovery agent is queued again')).toBeVisible();
  await expect
    .poll(async () =>
      (await commandLog(request)).filter((entry) => entry.path.endsWith('/rediscovery')),
    )
    .toHaveLength(1);
});

test('the integrations screen carries the create and test controls', async ({ page }) => {
  // PROGRESS backlog 55: `POST /api/integrations` was served and no component called it, so the
  // product's front door had a step that could only be taken with `curl`.
  await page.goto('/integrations');
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add integration' })).toBeVisible();
  // WP-100 (backlog 328): the chosen provider's own required fields, from the server's catalogue,
  // and its credential as an environment-variable name.
  await page.getByLabel('Provider').selectOption('jira-cloud');
  await expect(page.getByLabel('site_url')).toBeVisible();
  await expect(page.getByLabel('user_email')).toBeVisible();
  await expect(page.getByLabel('Environment variable for api_token')).toBeVisible();
});

test('the wizard’s Test connection shows a failed result beside the integration (WP-155)', async ({
  page,
  request,
}) => {
  // PROGRESS backlog 451: the press sent the probe and the step rendered nothing. The answer is
  // the Integrations card's own component, beside the integration that was tested.
  await page.goto('/onboarding');
  const row = page.locator(`[data-integration-row="${IDS.integration}"]`);
  await expect(row.getByText('Jira (fake)', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Test connection' }).click();
  // Waited on the last thing the page writes — the rendered verdict — then the log asserted as
  // what it implies (rule 87): exactly one probe reached the server.
  await expect(row.getByText('Last test: failed')).toBeVisible();
  await expect(row.getByText('authenticated', { exact: true })).toBeVisible();
  // The provider's words, as text (BD-022).
  await expect(row.getByText('401 <b>Unauthorized</b>: the API token was refused')).toBeVisible();
  await expect(row.locator('b')).toHaveCount(0);
  expect((await commandLog(request)).filter((entry) => entry.path.endsWith('/test'))).toHaveLength(
    1,
  );
});

test('the wizard’s step 1 maps the ticket lifecycle from the tracker’s own statuses (WP-182)', async ({
  page,
  request,
}) => {
  // BD-031 ruling 7: the slots are pick lists loaded from the tracker. Against the built bundle, so
  // this is the tier that shows the selects, the multi-select and the save work in a browser.
  await page.goto('/onboarding');
  const card = page.locator(`[data-ticket-lifecycle="${IDS.integration}"]`);
  const qa = card.getByLabel('QA', { exact: true });
  await expect(qa).toBeVisible();
  // Only the loaded names, each with its category, after the empty choice.
  await expect(qa.locator('option')).toHaveText([
    'Not mapped',
    'Doing (in progress)',
    'Waiting for review (in progress)',
    'Testing (in progress)',
    'Sent back (to do)',
  ]);
  await card.getByLabel('In review', { exact: true }).selectOption('Waiting for review');
  await qa.selectOption('Testing');
  await card.getByLabel('Returned', { exact: true }).selectOption(['Sent back']);
  await card.getByRole('button', { name: 'Save the ticket lifecycle' }).click();
  // Waited on what the page writes last, then the log read as what it implies (rule 87).
  await expect(card.getByText('The ticket lifecycle was saved.')).toBeVisible();
  const puts = (await commandLog(request)).filter((entry) => entry.path.endsWith('/bindings'));
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body).toEqual({
    items: [
      {
        integration_id: IDS.integration,
        // Every slot left empty is absent; the two switches are the form's.
        config: {
          lifecycle: {
            in_review: 'Waiting for review',
            qa: 'Testing',
            returned: ['Sent back'],
            claim: true,
            take_assigned_tickets: false,
          },
        },
      },
    ],
  });
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
  // WP-96 (backlog 326): the health panel's success branch, which the fake's 404 used to hide.
  await expect(page.locator('[data-kb-health="findings"]')).toBeVisible();
  await expect(page.getByText('links to runbooks/missing.md')).toBeVisible();
  await expect(page.getByText('The health report could not be loaded.')).toHaveCount(0);

  await page.goto(`/projects/${PROJECT_KEY}/budgets`);
  await expect(page.getByLabel('Budget used')).toBeVisible();
  await expect(page.getByText('$100.00')).toBeVisible();

  await page.goto(`/projects/${PROJECT_KEY}/pipeline`);
  await expect(page.getByText('fakehash1')).toBeVisible();
});

/**
 * The statistics screen (WP-41). It used to say plainly that it had no data source; it has one now,
 * and what this case keeps is the *reason* that sentence existed: **a number the platform cannot
 * compute must not appear as a zero.**
 */
test('statistics renders a number, a null ratio and an absence as three different things', async ({
  page,
}) => {
  await page.goto('/stats');
  // `.first()` and exact matches throughout: every definition is also rendered into a hidden
  // `aria-describedby` node, which is the point of `Metric` — a tooltip that reaches a screen
  // reader — and makes a loose text match ambiguous by design.
  await expect(page.getByText('Tasks delivered', { exact: true })).toBeVisible();
  await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
  // The ratio with nothing to divide — not "0.0%".
  await expect(page.getByText('no data in this range').first()).toBeVisible();
  // The absence, in the section that exists for it, with the owner beside the reason.
  await expect(page.getByText('Not measured, and why')).toBeVisible();
  await expect(page.getByText('Queue wait', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Nobody yet — a row that folds task.queued against task.dequeued owns it.'),
  ).toBeVisible();
  // The error direction of a figure that has one is on the screen rather than in a docblock.
  await expect(page.getByText(/Over-counts: a bot that is not this platform/)).toBeVisible();
  // The CSV export points at the endpoint that serves it.
  await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
    'href',
    /\/api\/org\/stats\.csv\?range=30d&bucket=day$/,
  );
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
  // Backlog 494: the control says what the retry did, rather than nothing at all.
  await expect(
    page.getByRole('status').filter({ hasText: 'Attempt 2 of refinement' }),
  ).toBeVisible();

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

  // WP-85: what became of each steer, read from the command log and said in words.
  const sent = page.getByRole('region', { name: 'Commands sent to this run' });
  await expect(sent.getByText(/delivered to the live session/)).toBeVisible();
  await expect(sent.getByText(/the run ended before this message could be applied/)).toBeVisible();
  await page.getByLabel('Steer the agent').fill('also check the rounding');
  await page.getByRole('button', { name: 'Steer' }).click();
  await expect(page.getByText(/Accepted\. The agent runs in another process/)).toBeVisible();

  // WP-159: a select over `GET /api/org/models`, starting on the run's own model. Wait for a
  // listed option the run is not on first, so the value is asserted over the loaded list (rule 87).
  await expect(
    page.getByLabel('Retry with model').locator('option', { hasText: 'claude-sonnet-5' }),
  ).toHaveCount(1);
  await expect(page.getByLabel('Retry with model')).toHaveValue('claude-opus-5');
  await page.getByLabel('Retry with model').selectOption('claude-sonnet-5');
  await page.getByLabel('Retry with effort').selectOption('low');
  await page.getByRole('button', { name: 'Retry run' }).click();
  await expect(page.getByText('A new run was requested')).toBeVisible();

  await page.getByLabel('Feedback on the implementation stage').fill('too many retries');
  await page.getByRole('button', { name: 'Good' }).click();
  await page.getByRole('button', { name: 'Send feedback' }).click();

  await expect.poll(async () => (await commandLog(request)).length).toBeGreaterThanOrEqual(2);
  const log = await commandLog(request);

  expect(log.find((entry) => entry.path === `/api/runs/${IDS.run}/steer`)?.body).toEqual({
    message: 'also check the rounding',
  });
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

test('the task screen takes a task over and renders what the response carries (WP-44)', async ({
  page,
  request,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  await page.getByLabel('Why you are taking it over').fill('the agent is looping');
  await page.getByRole('checkbox', { name: /archive the workspace/ }).check();
  await page.getByRole('button', { name: 'Take over', exact: true }).click();

  await expect(page.getByText('git fetch && git checkout agentic/demo-1')).toBeVisible();
  await expect(
    page.getByText(/is being committed as a work-in-progress hand-over commit/),
  ).toBeVisible();
  const log = await commandLog(request);
  expect(log.find((entry) => entry.path.endsWith('/take-over'))).toEqual({
    path: `/api/tasks/${IDS.taskFeature}/take-over`,
    body: { tarball: true, reason: 'the agent is looping' },
  });
});

test('a taken-over task that escalated still shows the branch, the downloads and the hand-back (WP-44)', async ({
  page,
  request,
}) => {
  await page.goto(`/tasks/${IDS.taskTaken}`);
  await expect(page.getByRole('heading', { name: 'DEMO-3' })).toBeVisible();
  await expect(page.getByText('Taken over by a human')).toBeVisible();
  await expect(page.getByText('escalated — still held')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download the transcript (JSONL)' })).toHaveAttribute(
    'href',
    `/api/runs/${IDS.run}/transcript.jsonl`,
  );
  await expect(page.getByRole('link', { name: 'Download the workspace tarball' })).toHaveAttribute(
    'href',
    `/api/runs/${IDS.run}/export.tar`,
  );

  const picker = page.getByLabel('Resume at');
  await expect(picker.locator('option')).toHaveText([
    'refinement',
    'implementation',
    'code_review',
  ]);
  await picker.selectOption('code_review');
  await page.getByLabel('What you did').fill('fixed it by hand');
  await page.getByRole('button', { name: 'Hand back' }).click();
  await expect
    .poll(async () => (await commandLog(request)).map((entry) => entry.path))
    .toContain(`/api/tasks/${IDS.taskTaken}/hand-back`);
  const log = await commandLog(request);
  expect(log.find((entry) => entry.path.endsWith('/hand-back'))?.body).toEqual({
    stage: 'code_review',
    summary: 'fixed it by hand',
  });
});

test('the epic split’s breakdown panel accepts a chosen child with one request (WP-44)', async ({
  page,
  request,
}) => {
  await page.goto(`/tasks/${IDS.taskEpic}`);
  await expect(page.getByText('Proposed breakdown')).toBeVisible();
  await expect(page.getByText('Child A', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select child 2' }).check();
  await page.getByRole('button', { name: /Accept 1 — creates a ticket in your tracker/ }).click();
  await expect
    .poll(async () => (await commandLog(request)).map((entry) => entry.path))
    .toContain(`/api/tasks/${IDS.taskEpic}/breakdown/decide`);
  const log = await commandLog(request);
  expect(log.find((entry) => entry.path.endsWith('/breakdown/decide'))?.body).toEqual({
    decision: 'accept',
    item_ids: [IDS.childB],
  });
});

test('the run screen counts only admitted documents and marks the one that was not (WP-44)', async ({
  page,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByRole('heading', { name: 'implementation · developer' })).toBeVisible();
  await page.getByRole('tab', { name: 'Context pack' }).click();
  // Tier 0 and the one validated tier-1 page: two, not three (PROGRESS backlog 168).
  await expect(
    page.getByText('Documents', { exact: true }).locator('xpath=following-sibling::*[1]'),
  ).toHaveText('2');
  await expect(page.locator('[data-not-admitted]')).toHaveCount(1);
  // …and what the text step did, in words (backlog 172).
  await expect(
    page.getByText(/Searched for retries \(dropped as too common: demo\)/),
  ).toBeVisible();
});
