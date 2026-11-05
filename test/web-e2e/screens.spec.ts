/**
 * The screens, asserted positively: named content is present, not "no error appeared".
 *
 * A negative assertion passes on a blank page and on a broken harness alike (standing rule 4), so
 * every test here names the thing it expects to see — this ticket key, this stage, this budget bar
 * — and the ones that exercise a command assert the *server* observed it by reading the state
 * back.
 */
import { expect, test } from '@playwright/test';
import { failedJobs, HOSTILE, IDS, PROJECT_KEY } from './support/fixtures.js';
import { commandLog, resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

/**
 * Home (S-23.7): what needs you first, then what is running, then the projects, with the spend and
 * the instance in the rail. The fixture's organisation has a tracker and no git host, so the setup
 * checklist sits in the rail too and its one primary button continues at the first undone step.
 */
test('Home: needs you, running now, the projects, the rail and the unfinished setup', async ({
  page,
}) => {
  const needs = page.getByRole('list', { name: 'Needs you' });
  // The agent's question, first line, as text; its row's action opens the task.
  await expect(needs.getByText(/^Should the retry budget be 3 or 5\?/)).toBeVisible();
  await expect(needs.getByText('Plan approval is waiting for you')).toBeVisible();
  await expect(needs.getByRole('link', { name: /^Answer/ })).toHaveAttribute(
    'href',
    `/tasks/${IDS.taskFeature}`,
  );
  await expect(needs.getByText('DEMO-1').first()).toBeVisible();

  const running = page.getByRole('list', { name: 'Running now' });
  await expect(running.getByRole('link', { name: 'Implementation · Developer' })).toHaveAttribute(
    'href',
    `/runs/${IDS.run}`,
  );

  await expect(
    page.getByRole('list', { name: 'Projects' }).getByRole('link', { name: /Demo service/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Spend' }).getByText('Spend, last 30 days'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Instance' }).getByText('Live')).toBeVisible();

  const setup = page.getByRole('region', { name: 'Set up' });
  await expect(
    setup.getByRole('link', { name: /^Connect your tracker and git host/ }),
  ).toHaveAttribute('href', '/integrations');
  await expect(setup.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
    'href',
    '/integrations',
  );
});

/**
 * The frame (S-23.4), in a browser against the built bundle: the organisation's navigation reaches
 * the new `/projects` page, a row opens the project, and the project's tabs — the board's old text
 * links, moved into the layout route — reach a sub-page whose chunk is loaded on demand, at the
 * URL it always had. `Home` is the renamed *Dashboard*.
 */
test('the frame: Home, the projects list, and a project’s tabs', async ({ page }) => {
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await primary.getByRole('link', { name: /^Projects/ }).click();
  await expect(page).toHaveURL('/projects');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  await page
    .getByRole('list', { name: 'Projects' })
    .getByRole('link', { name: /Demo service/ })
    .click();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}`);
  const tabs = page.getByRole('navigation', { name: 'Project' });
  await expect(tabs.getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
  // Inside a project the switcher names it, and the organisation's row gives way to the tabs.
  await expect(
    page.getByRole('button', { name: /^Demo service.*, switch project$/ }),
  ).toBeVisible();
  await expect(primary).toHaveCount(0);

  await tabs.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}/knowledge`);
  // S-23.11b: the vault's files are a NavList grouped by folder; the item is the file's own name.
  await expect(
    page
      .getByRole('navigation', { name: 'Knowledge files' })
      .getByRole('button', { name: 'architecture.md' }),
  ).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the board puts each task in the column its state belongs to', async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);

  const active = page.getByRole('region', { name: 'Active' });
  // TD-033's word for the waiting column (S-23.2): `needs_human` reads "Needs you".
  const waiting = page.getByRole('region', { name: 'Needs you' });
  // A card is an article named by its ticket key (S-23.9a); the title is its link into the task.
  const demo1 = active.getByRole('article', { name: 'DEMO-1' });
  await expect(demo1).toBeVisible();
  await expect(waiting.getByRole('article', { name: 'DEMO-2' })).toBeVisible();
  // The stage's human name (TD-033), not its id, under the card's phase strip — whose current
  // stage is the one marked as the step.
  await expect(demo1.getByText('Implementation', { exact: true })).toBeVisible();
  await expect(demo1.locator('[data-phase-track] li[aria-current="step"]')).toHaveAttribute(
    'title',
    'Implementation: current',
  );
  // The iteration counter product/10 asks for ("review 2/3" in its example; this fixture's loop
  // has no frozen limit, so the count alone).
  await expect(demo1.getByText('Review 1', { exact: true })).toBeVisible();
  // DEMO-1 has an open question and a pending approval: the needs-you ◆ and their count.
  await expect(demo1.locator('[data-needs-you] [data-asks="2"]')).toBeVisible();
  // The columns scroll sideways below `xl` rather than wrapping.
  await page.setViewportSize({ width: 900, height: 800 });
  const columns = page.locator('[data-board-columns]');
  expect(await columns.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // The list view: the same tasks as rows, filtered over the same page.
  await page
    .getByRole('navigation', { name: 'Board view' })
    .getByRole('link', { name: 'List' })
    .click();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}?view=list`);
  const list = page.getByRole('list', { name: 'Tasks' });
  await expect(list.locator('[data-board-row]')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Needs you' }).check();
  await expect(list.locator('[data-board-row]')).toHaveCount(2);
  await page.getByLabel('Template').selectOption('bug');
  await expect(list.locator('[data-board-row]')).toHaveCount(1);
});

test('the task detail shows the stage timeline, the runs and the checks panel', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);

  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  // Scoped to the timeline: the flow's cards and the phase strip name the stage too. The timeline
  // names the stage in words (TD-033), on the Overview tab the page opens on (S-23.9b).
  // S-23.5: the flow's list of stages is an `<ol>` too, so the timeline is named.
  await expect(
    page
      .getByRole('list', { name: 'Timeline, newest first' })
      .getByText('Refinement', { exact: true }),
  ).toBeVisible();
  // The stage's outcome word, through the word→sentence table (WP-73, backlog 213).
  await expect(page.getByText('Verdict: approve.')).toBeVisible();
  // The runs are the Runs tab since S-23.9b; the rail beside it stays.
  await page.getByRole('navigation', { name: 'Task' }).getByRole('link', { name: /^Runs/ }).click();
  await expect(
    page
      .getByRole('list', { name: 'Runs' })
      .getByRole('link', { name: 'Implementation · Developer', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Cost so far', { exact: true })).toBeVisible();
  /**
   * S-23.9b: the rail's Checks is a merge box — each row's value is on the row, and the sentence
   * it rests on is in the row's expandable detail, so each basis below is read after one click.
   */
  const check = (id: string) => page.locator(`[data-check="${id}"]`);
  const expand = async (id: string) => {
    await check(id).locator('summary').click();
  };
  // WP-28: the refinement estimate, what it rests on and product/19 §10's accuracy — three numbers
  // the Checks panel showed as `$0.00` under the label *"Estimate"* before this row, because it read
  // `cost_estimated_usd` (then a column nothing wrote; since WP-47 a projection over the ledger's
  // estimated entries) instead of `estimate_usd`.
  await expect(page.getByText('$12.00')).toBeVisible();
  await expand('estimate');
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
  await expand('coverage');
  await expect(page.getByText(/81\.5 % on bbbbbbb, against 79\.0 % on main/)).toBeVisible();
  /**
   * WP-38's two Checks items, in the browser: the dependency the gate found with the licence a
   * **registry** published, and the reviewers the routing asked for — including the handle it could
   * not resolve, which is the fact the `set_reviewers` audit row cannot record.
   */
  await expect(page.getByText('Dependencies', { exact: true })).toBeVisible();
  await expect(page.getByText('1 added · waiting')).toBeVisible();
  await expand('dependencies');
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
  await expand('ci');
  // S-23.22: the gate by its name (`stageLabel`), never its id.
  await expect(page.getByText('This task has not entered CI.')).toBeVisible();
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
  // S-23.11a: a question row expands in place to its answer box — one more step than the card had.
  const row = page.locator(`[data-inbox-question="${IDS.question}"]`);
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  const answerBox = page.getByLabel('Your answer');
  await expect(answerBox).toBeVisible();

  await answerBox.fill('three');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();

  // The fake backend removes an answered question from `GET /api/org/inbox`, so the box
  // disappearing is evidence the POST arrived — with its CSRF header, which the fake enforces.
  await expect(answerBox).toHaveCount(0);
  // The pending approval is untouched, so the screen did not simply empty itself.
  await expect(page.getByRole('link', { name: 'Decide on the task' })).toBeVisible();
});

test('the agents list shows every live run and opens one’s dialog with a link to the run', async ({
  page,
}) => {
  await page.goto('/agents?view=list');
  const runs = page.getByRole('list', { name: 'Runs' });
  // What needs a person first: DEMO-1 has an open question, DEMO-5 is thinking, DEMO-6 waits.
  await expect(runs.getByRole('button', { name: /^demo_service · DEMO-/ })).toHaveText([
    `demo_service · DEMO-1 · Checkout ${HOSTILE.script}`,
    `demo_service · DEMO-5 · Flaky retries ${HOSTILE.image}`,
    'demo_service · DEMO-6 · Export the invoice as CSV',
  ]);
  await expect(runs.getByText('worker jan-mbp')).toBeVisible();
  await expect(runs.getByText('claude-opus-5').first()).toBeVisible();
  await runs.getByRole('button', { name: /^demo_service · DEMO-1/ }).click();
  const dialog = page.getByRole('dialog', { name: 'DEMO-1 · Implementation' });
  await expect(dialog.getByRole('link', { name: 'Open run' })).toHaveAttribute(
    'href',
    `/runs/${IDS.run}`,
  );
});

test('the audit log renders an entry in words, with its diff behind Details', async ({ page }) => {
  await page.goto('/audit');
  // S-23.11b: who · what, in words · when — the person resolved from the user list.
  const list = page.getByRole('list', { name: 'Audit entries' });
  await expect(list.getByText('changed a project’s settings', { exact: false })).toBeVisible();
  await expect(list.getByText('Fake Operator')).toBeVisible();
  await expect(page.getByText('autonomy_level')).toBeHidden();
  await list.getByText('Details').click();
  await expect(page.getByText('autonomy_level')).toBeVisible();
});

test('settings opens its first section and shows the session, the user list and the instance version', async ({
  page,
}) => {
  // S-23.11b: one section per page, beside a NavList; the bare URL opens the first.
  await page.goto('/settings');
  // One dark theme (TD-033's 2026-11-05 amendment): no Appearance section, so Session is first.
  await expect(page).toHaveURL(/\/settings\/session$/);
  await expect(page.getByLabel('Theme preference')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await expect(page.getByText('operator@example.invalid').first()).toBeVisible();
  await nav.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('list', { name: 'Users' }).getByText('Fake Operator')).toBeVisible();
  await nav.getByRole('link', { name: 'Instance' }).click();
  await expect(page.getByText('0.0.0-fake')).toBeVisible();
});

test('org settings carries the organisation budgets WP-30 gave it a writer for', async ({
  page,
}) => {
  // The sentence this file's own screen used to carry — *"global budgets … need `GET/PATCH /api/org`,
  // which no work package has built"* — is false since WP-30, and the control is what makes it so.
  await page.goto('/settings/budgets');
  await expect(page.getByText('Organisation budgets')).toBeVisible();
  await expect(page.getByText('spent $3.25 of $40.00 this window')).toBeVisible();
});

test('org settings lists the provider identities and offers the mapping form (WP-43)', async ({
  page,
}) => {
  // PROGRESS backlog 79: `POST /api/org/identities` was served and no screen called it, so every
  // decision from Slack, Jira or GitLab stayed `unmapped_identity`.
  await page.goto('/settings/identities');
  await expect(page.getByRole('heading', { name: 'Provider identities' })).toBeVisible();
  await expect(page.getByText('U0FAKEOPERATOR')).toBeVisible();
  // The display name is provider text: its markup is on the screen as characters, not an element.
  await expect(page.getByText('<img src=x onerror=alert(1)>operator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeVisible();
});

test('org settings shows the organisation document and saves a section through PATCH /api/org (WP-93)', async ({
  page,
  request,
}) => {
  // PROGRESS backlogs 146 (2) and 223: the organisation layer had no writer but SQL. Since
  // S-23.11b the maximums are the Policies page, saved by its one Save — only what changed.
  await page.goto('/settings/policies');
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  // The stored list is administrator text: held as a value, never parsed into an element.
  await expect(page.getByLabel('Organisation command block list')).toHaveValue(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.getByLabel('Organisation autonomy maximum')).toHaveValue('supervised');

  await page.getByLabel('Organisation autonomy maximum').selectOption('assist');
  await page.getByRole('button', { name: 'Save policies' }).click();
  await expect
    .poll(async () => (await commandLog(request)).filter((entry) => entry.path === '/api/org'))
    .toEqual([{ path: '/api/org', body: { autonomy: { maximum: 'assist' } } }]);
});

test('org settings lists a dead letter with its re-queue control (WP-96, backlog 326)', async ({
  page,
}) => {
  // Until WP-96 the fake answered this read with its 404, so the bundle drew only the error notice.
  await page.goto('/settings/dead-letters');
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
  await page.goto('/settings/failed-jobs');
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
  // bundle, so this is the one tier that shows the routes exist and the pages render in a browser.
  // Since S-23.11b each section is a page of its own; the bare URL opens Connections.
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/settings/connections$`));
  const nav = page.getByRole('navigation', { name: 'Project settings' });
  const section = page.locator('[data-settings-section]');
  for (const [link, heading] of [
    ['Connections', 'Connections'],
    ['Discovery & readiness', 'Discovery & readiness'],
    ['Business context', 'Business context'],
  ] as const) {
    await nav.getByRole('link', { name: link }).click();
    await expect(section.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Policies & WIP' }).click();
  for (const heading of [
    'Autonomy dial',
    'Features',
    'Risk classes',
    'Project budgets',
    'Notifications',
    'Who changed what',
  ]) {
    await expect(section.getByRole('heading', { name: heading, exact: true })).toBeVisible();
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
  await page.goto(`/projects/${PROJECT_KEY}/settings/discovery`);
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
  // product's front door had a step that could only be taken with `curl`. Since S-23.11a the probe
  // is in each row's `···` and the create is the four-step wizard behind **New integration**.
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Actions for Jira (fake)' }).click();
  await expect(page.getByRole('menuitem', { name: 'Test connection' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'New integration' }).click();
  await expect(page).toHaveURL(/\/integrations\/new$/);
  // WP-100 (backlog 328): the chosen provider's own required fields, from the server's catalogue,
  // labelled in words with the key in the hint, and its credential as an environment-variable name.
  await page.getByRole('radio', { name: /Jira Cloud/ }).check();
  await page.getByRole('button', { name: 'Continue to configuration' }).click();
  await expect(page.getByLabel('Site URL')).toBeVisible();
  await expect(page.getByText('Key: site_url.', { exact: false })).toBeVisible();
  await page.getByLabel('Name').fill('Jira (second)');
  await page.getByLabel('Site URL').fill('https://fake.atlassian.invalid');
  await page.getByLabel('User email').fill('operator@example.invalid');
  await page.getByRole('button', { name: 'Continue to credentials' }).click();
  await expect(page.getByLabel('Environment variable for API token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create integration' })).toBeVisible();
});

test('New project opens the wizard at Connect, and a project resumes where it stands (S-23.8)', async ({
  page,
}) => {
  // TD-033 decision 9: the step list, the step, and Continue that says where it goes — refused,
  // with the reason, past a required step that is not done. Against the built bundle, so this is
  // the tier that shows the lazy chunk and the validated search parameters work in a browser.
  await page.goto('/projects');
  await page.getByRole('main').getByRole('link', { name: 'New project' }).click();
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByRole('heading', { level: 1, name: 'New project' })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(steps.first()).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('Key')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to Technical discovery' }),
  ).toBeDisabled();

  // The fake project has a tracker and no git binding: it resumes at Connect, and says what is
  // missing rather than letting anybody past it.
  await page.goto(`/onboarding?project=${PROJECT_KEY}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Connect' })).toBeVisible();
  await expect(page.getByText('Bind a git integration to continue.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to Technical discovery' }),
  ).toBeDisabled();
  await page.getByRole('link', { name: 'Save and exit' }).click();
  await expect(page).toHaveURL('/');
});

test('the wizard’s Test connection shows a failed result beside the integration (WP-155)', async ({
  page,
  request,
}) => {
  // PROGRESS backlog 451: the press sent the probe and the step rendered nothing. The answer is
  // the Integrations card's own component, beside the integration that was tested.
  await page.goto(`/onboarding?project=${PROJECT_KEY}&step=connect`);
  const row = page.locator(`[data-integration-row="${IDS.integration}"]`);
  await expect(row.getByText('Jira (fake)', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Test connection' }).click();
  // Waited on the last thing the page writes — the rendered verdict — then the log asserted as
  // what it implies (rule 87): exactly one probe reached the server.
  await expect(row.getByText('Last test: failed')).toBeVisible();
  // The check's name in words since S-23.11a.
  await expect(row.getByText('Authenticated', { exact: true })).toBeVisible();
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
  await page.goto(`/onboarding?project=${PROJECT_KEY}&step=connect`);
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

test('the retired Appearance URL lands on Session, and a box sits above the page', async ({
  page,
}) => {
  await page.goto('/settings/appearance');
  await expect(page).toHaveURL(/\/settings\/session$/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  // TD-033's 2026-11-05 amendment: the page is the top bar's deep night, a card one step lighter.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(15, 13, 34)',
  );
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('link', { name: 'Users' }).click();
  const users = page.getByRole('list', { name: 'Users' });
  await expect(users).toBeVisible();
  const box = users.locator('xpath=ancestor-or-self::*[contains(@class, "bg-default")][1]');
  expect(await box.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(21, 19, 43)',
  );
});

test('the project panels render the vault, the proposals and the budget meter', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/knowledge`);
  // S-23.11b: the files are a NavList grouped by folder; the item is the file's own name.
  const files = page.getByRole('navigation', { name: 'Knowledge files' });
  await expect(files.getByRole('heading', { name: 'technical' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'architecture.md' })).toBeVisible();
  await expect(page.getByText('lessons/retries.md').first()).toBeVisible();
  await expect(page.getByText('significance 0.72')).toBeVisible();
  // WP-96 (backlog 326): the health panel's success branch, which the fake's 404 used to hide.
  await expect(page.locator('[data-kb-health="findings"]')).toBeVisible();
  await expect(page.getByText('links to runbooks/missing.md')).toBeVisible();
  await expect(page.getByText('The health report could not be loaded.')).toHaveCount(0);

  await page.goto(`/projects/${PROJECT_KEY}/budgets`);
  await expect(page.getByLabel('Cap used')).toBeVisible();
  await expect(page.getByText('$100.00')).toBeVisible();

  await page.goto(`/projects/${PROJECT_KEY}/pipeline`);
  // S-23.5: the canvas leads the tab; the configuration is folded below it.
  await expect(page.locator('[data-flow-canvas="template"]')).toBeVisible();
  await page.getByText('Effective configuration', { exact: true }).click();
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
  // S-23.19: sections with headings, a card per metric, the count pluralised.
  await expect(page.getByRole('heading', { level: 2, name: 'Throughput' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Quality' })).toBeVisible();
  const returns = page.locator('[data-metric-card="returns_per_delivered_task"]');
  await expect(returns.getByText('8.0', { exact: true })).toBeVisible();
  await expect(returns.getByText('1 observation', { exact: true })).toBeVisible();
  // A trend where two buckets carry a value, drawn as an SVG with its words beside it.
  const delivered = page.locator('[data-metric-card="tasks_delivered"]');
  await expect(delivered.locator('svg polyline')).toHaveCount(1);
  await expect(delivered.getByText(/^Trend by day: 2 of 2 days with data/)).toBeAttached();
  // The ratio with nothing to divide — not "0.0%": a dash, and the sentence in small print.
  await expect(
    page.locator('[data-metric-card="merge_rate"]').getByText('No data in this range'),
  ).toBeVisible();
  // The absence, in the disclosure that exists for it — collapsed since S-23.11b — with the owner
  // beside the reason.
  await expect(page.getByText('Queue wait', { exact: true })).toBeHidden();
  await page.getByText('Not measured, and why').click();
  await expect(page.getByText('Queue wait', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Nobody yet — a row that folds task.queued against task.dequeued owns it.'),
  ).toBeVisible();
  // The error direction of a figure that has one is on the screen rather than in a docblock — in
  // the one "How these are measured" disclosure since S-23.19, not under the value.
  await expect(page.getByText(/Over-counts: a bot that is not this platform/)).toBeHidden();
  await page.getByText('How these are measured').click();
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
  // S-23.11a: the guide is a tab of the integration's own page, reached from the row's `···`.
  await page.getByRole('button', { name: 'Actions for Jira (fake)' }).click();
  await page.getByRole('menuitem', { name: 'Setup guide' }).click();
  await expect(page).toHaveURL(new RegExp(`/integrations/${IDS.integration}\\?tab=setup-guide$`));
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

  // S-23.9b: each stage command is in the header's `···` menu and opens a dialog with the fields
  // the inline card had, under the same labels; the stage picked stays picked between them.
  const menu = async (item: string) => {
    await page.getByRole('button', { name: 'Task actions' }).click();
    await page.getByRole('menuitem', { name: item }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  };
  await menu('Retry stage…');
  await page.getByLabel('Stage', { exact: true }).selectOption('refinement');
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
  await menu('Return to stage…');
  const returnButton = page.getByRole('button', { name: 'Return to stage' });
  await expect(returnButton).toBeDisabled();
  await page.getByLabel('Reason', { exact: true }).fill('the spec missed the retry budget');
  await expect(returnButton).toBeEnabled();
  await returnButton.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await menu('Rework…');
  await page.getByLabel('Rework instructions').fill('split the helper out');
  await page.getByRole('button', { name: 'Rework' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

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

  // S-23.23: *Re-run ▾* is offered only once the run has ended (the server refuses `run.retry` on a
  // live run), so the run read is answered as failed from here on and the page is read again.
  await page.route(`**/api/runs/${IDS.run}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        status: 'failed',
        terminal_reason: 'error_during_execution',
        ended_at: new Date().toISOString(),
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel('Steer the agent')).toHaveCount(0);

  // WP-159: a select over `GET /api/org/models`, starting (WP-167) on *Configured (…)*, which names
  // the run read's `retry_defaults`. Wait for a listed option the run is not on first, so the value
  // is asserted over the loaded list (rule 87). Since S-23.10 the fields are behind *Re-run ▾*.
  await page.getByRole('button', { name: 'Re-run' }).click();
  await page.getByRole('menuitem', { name: 'Re-run with another model or effort…' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Re-run with another model or effort' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Retry with model').locator('option', { hasText: 'claude-sonnet-5' }),
  ).toHaveCount(1);
  await expect(page.getByLabel('Retry with model')).toHaveValue('configured');
  await expect(page.getByLabel('Retry with model').locator('option:checked')).toHaveText(
    'Configured (claude-opus-5)',
  );
  await page.getByLabel('Retry with model').selectOption('claude-sonnet-5');
  await page.getByLabel('Retry with effort').selectOption('low');
  await page
    .getByRole('dialog', { name: 'Re-run with another model or effort' })
    .getByRole('button', { name: 'Re-run' })
    .click();
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
  // S-23.9b: the timeline says there is none, and the menu offers no stage command at all.
  await expect(page.getByText('No stages yet')).toBeVisible();
  await page.getByRole('button', { name: 'Task actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Cancel task…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Retry stage…' })).toHaveCount(0);
  await expect(page.getByLabel('Stage', { exact: true })).toHaveCount(0);
});

test('the task screen takes a task over and renders what the response carries (WP-44)', async ({
  page,
  request,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Take over…' }).click();
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
  await expect(page.getByText('Taken over by a person')).toBeVisible();
  await expect(page.getByText('needs you — still held')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download the transcript (JSONL)' })).toHaveAttribute(
    'href',
    `/api/runs/${IDS.run}/transcript.jsonl`,
  );
  await expect(page.getByRole('link', { name: 'Download the workspace tarball' })).toHaveAttribute(
    'href',
    `/api/runs/${IDS.run}/export.tar`,
  );

  // The hand-back is the header's one primary action while the take-over is in force (S-23.9b).
  await page.getByRole('button', { name: 'Hand back…' }).click();
  const picker = page.getByLabel('Resume at');
  // S-23.22: each option says the stage's name; its value is still the id the route takes.
  await expect(picker.locator('option')).toHaveText([
    'Refinement',
    'Implementation',
    'Code review',
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
  // A maintainer has children left to decide, so the panel is in the needs-you box (S-23.9b).
  await expect(
    page
      .getByRole('region', { name: 'Needs you' })
      .getByRole('heading', { name: 'Proposed breakdown' }),
  ).toBeVisible();
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
