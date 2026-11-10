/**
 * The screens, asserted positively: named content is present, not "no error appeared".
 *
 * A negative assertion passes on a blank page and on a broken harness alike (standing rule 4), so
 * every test here names the thing it expects to see — this ticket key, this stage, this budget bar
 * — and the ones that exercise a command assert the *server* observed it by reading the state
 * back.
 */
import { expect, test } from '@playwright/test';
import {
  AUT_6655_JOB_URL,
  AUT_6676_URL,
  CANDIDATE_NAME,
  failedJobs,
  HELD_ELSEWHERE_ASSIGNEE,
  HOSTILE,
  IDS,
  identityLinkIssued,
  identityLinkMatch,
  LINK_ACCOUNT,
  OWNER_NAME,
  PROJECT_KEY,
  UNLINKED_ASSIGNEE,
} from './support/fixtures.js';
import { commandLog, openWaiting, resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

/**
 * Home (S-23.7): what needs you first, then what is running, then the projects, with the spend and
 * the instance in the rail. The fixture's organisation has a tracker and no git host, and its
 * project has run tickets — so since S-25.6 (research/21 F10) the checklist is gone and the rail
 * names only the missing piece and what it costs. The fixture's operator is an administrator, so
 * *Needs you* also carries the stuck event and the failed background job (F14).
 */
test('Home: needs you, running now, the projects, the rail and the missing piece', async ({
  page,
}) => {
  const needs = page.getByRole('list', { name: 'Needs you' });
  // The agent's question, first line, as text; its row's action opens the task.
  await expect(needs.getByText(/^Should the retry budget be 3 or 5\?/)).toBeVisible();
  // An approval names what it is about (S-25.1); the fixture's was asked before that was recorded.
  await expect(
    needs.getByText('Plan approval · the plan it is about was not recorded'),
  ).toBeVisible();
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

  // The background failures, an administrator's rows, each to its settings section.
  await expect(needs.getByRole('link', { name: 'Review 1 event is stuck' })).toHaveAttribute(
    'href',
    '/settings/dead-letters',
  );
  await expect(needs.getByRole('link', { name: 'Review 1 background job failed' })).toHaveAttribute(
    'href',
    '/settings/failed-jobs',
  );

  await expect(page.getByRole('region', { name: 'Set up' })).toHaveCount(0);
  const missing = page.getByRole('region', { name: 'Missing from setup' });
  await expect(
    missing.getByText('Merge requests can’t be opened until a git host is connected.'),
  ).toBeVisible();
  await expect(missing.getByRole('link', { name: 'Connect a git host →' })).toHaveAttribute(
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
  // S-25.4: DEMO-1 is `active` by state but has an open question and a pending approval, so the
  // one needs-you rule puts it under Needs you — the column, its ◆ and its header agree.
  const demo1 = waiting.getByRole('article', { name: 'DEMO-1' });
  await expect(demo1).toBeVisible();
  await expect(active.getByRole('article', { name: 'DEMO-1' })).toHaveCount(0);
  await expect(waiting.getByRole('article', { name: 'DEMO-2' })).toBeVisible();
  // The stage's human name (TD-033), not its id, under the card's phase strip — whose current
  // stage is the one marked as the step.
  await expect(demo1.getByText('Implementation', { exact: true })).toBeVisible();
  await expect(demo1.locator('[data-phase-track] li[aria-current="step"]')).toHaveAttribute(
    'title',
    'Implementation: current',
  );
  // The iteration counter product/10 asks for, as rounds (S-25.4: "Review round 2 of 3" in its
  // example; this fixture's loop has no frozen limit, so the round alone).
  await expect(demo1.getByText('Review round 1', { exact: true })).toBeVisible();
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
  // S-25.4: the ticket and merge request links are in the header, beside the key.
  await expect(
    page.locator('[data-task-links]').getByText('Ticket', { exact: true }),
  ).toBeVisible();
  // S-25.4: the timeline is the Flow's list mode, not a second section under the canvas.
  await expect(page.getByTestId('flow-canvas-frame')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Timeline, newest first' })).toHaveCount(0);
  await page.getByTestId('task-flow').getByRole('button', { name: 'List' }).click();
  await expect(page.getByTestId('flow-canvas-frame')).toHaveCount(0);
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
  // S-25.4: a task nobody has asked anything is *Ask the task*'s empty state, not an error.
  await expect(page.getByText('No questions yet')).toBeVisible();
  await expect(page.getByText('The thread could not be loaded.')).toHaveCount(0);
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
  await expect(page.getByText('Test coverage', { exact: true })).toBeVisible();
  await expect(page.getByText('+2.5 points')).toBeVisible();
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
  await expect(page.getByText('Protected files', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Test coverage', { exact: true })).toBeVisible();
  await expect(page.getByText('not measured')).toBeVisible();
  await expect(page.getByText('0.0 points')).toHaveCount(0);
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
  await expect(page.getByRole('link', { name: 'Review plan' })).toBeVisible();
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
  // S-25.7 (research/21 § 4, BACKLOG 1262): a row says what the agent is doing, not its model id.
  await expect(runs.getByText('claude-opus-5')).toHaveCount(0);
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
  // S-25.7 (research/21 F15): the row names the project it changed.
  await expect(list.getByText('changed the settings of', { exact: false })).toBeVisible();
  await expect(list.getByText('Fake Operator')).toBeVisible();
  await expect(page.getByText('autonomy_level')).toBeHidden();
  await list.getByText('Details').click();
  await expect(page.getByText('autonomy_level')).toBeVisible();
});

test('settings opens the first section the role may change and shows the session, the user list and the instance version', async ({
  page,
}) => {
  // S-23.11b: one section per page, beside a NavList. S-25.6: the bare URL opens the first section
  // the role may change — Policies for the fixture's administrator — rather than Session.
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/policies$/);
  await expect(page.getByLabel('Theme preference')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await nav.getByRole('link', { name: 'Session' }).click();
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
  await expect(page.getByRole('heading', { name: 'Linked accounts' })).toBeVisible();
  await expect(page.getByText('U0FAKEOPERATOR')).toBeVisible();
  // The display name is provider text: its markup is on the screen as characters, not an element.
  await expect(page.getByText('<img src=x onerror=alert(1)>operator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save mapping' })).toBeVisible();
});

test('Settings → Your accounts: a code, the account the provider proved, the confirmation, and unlink (S-26.8a)', async ({
  page,
  request,
}) => {
  await page.goto('/settings/accounts');
  await expect(page.getByRole('heading', { name: 'Your accounts' })).toBeVisible();
  await expect(page.getByText('No account is linked to you yet')).toBeVisible();
  await page.getByRole('button', { name: 'Link an account' }).click();
  // `exact`: the code's field is *Your link code*, and its copy button *Copy Your link code*
  // (`ui/copy-field.tsx`), which Playwright's default substring match also finds.
  await expect(page.getByLabel('Your link code', { exact: true })).toHaveValue(
    identityLinkIssued.code,
  );
  await expect(
    page.getByText(
      'Write this code as a comment on any ticket of a project you are in (Jira), from your own account.',
    ),
  ).toBeVisible();

  // The fake records the comment's author at once: the page asks before it links anything.
  const match = page.locator(`[data-link-match="${identityLinkMatch.id}"]`);
  await expect(match.getByRole('heading')).toHaveText(`Link Jira account ${LINK_ACCOUNT.name}?`);
  await expect(match.getByText(LINK_ACCOUNT.id)).toBeVisible();
  // The provider's name is characters on the screen, never an element.
  await expect(match.locator('img')).toHaveCount(0);
  expect((await commandLog(request)).filter((entry) => entry.path.endsWith('/confirm'))).toEqual(
    [],
  );

  await match.getByRole('button', { name: 'Link this account' }).click();
  await expect(page.getByText('You now own 2 tasks assigned to you in Jira.')).toBeVisible();
  await expect(page.getByText('You can delete the comment with the code now.')).toBeVisible();
  const list = page.getByRole('list', { name: 'Your linked accounts' });
  await expect(list.getByText(LINK_ACCOUNT.id)).toBeVisible();

  await list.getByRole('button', { name: 'Unlink' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'Answers and approvals from this Jira account stop counting as yours, though',
  );
  await dialog.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('No account is linked to you yet')).toBeVisible();
  await expect
    .poll(async () =>
      (await commandLog(request))
        .map((entry) => entry.path)
        .filter((path) => path.startsWith('/api/me/')),
    )
    .toEqual([
      '/api/me/identity-links',
      `/api/me/identity-links/matches/${identityLinkMatch.id}/confirm`,
      `/api/me/identities/jira-cloud/${LINK_ACCOUNT.id}`,
    ]);
});

test('Linked accounts: Unlink asks first and names the person, and an unlinked assignee says its tasks (S-26.8a)', async ({
  page,
  request,
}) => {
  await page.goto('/settings/identities');
  const candidates = page.getByRole('list', { name: 'Unmapped provider accounts' });
  await expect(candidates.getByText('assigned to 3 tasks', { exact: false })).toBeVisible();
  await expect(candidates.getByText(`Eva Malá ${HOSTILE.image}`)).toBeVisible();

  await page
    .getByRole('list', { name: 'Mapped provider accounts' })
    .getByRole('button', { name: 'Unlink' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'Unlink Slack account <img src=x onerror=alert(1)>operator from',
  );
  await dialog.getByRole('button', { name: 'Unlink' }).click();
  await expect
    .poll(async () =>
      (await commandLog(request))
        .map((entry) => entry.path)
        .filter((path) => path.startsWith('/api/org/identities/')),
    )
    .toEqual(['/api/org/identities/slack/U0FAKEOPERATOR']);
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
  await expect(letter.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText('The dead letters could not be loaded.')).toHaveCount(0);
});

test('org settings lists a failed job beside the dead letters, with no re-queue (WP-108, backlog 325)', async ({
  page,
}) => {
  await page.goto('/settings/failed-jobs');
  const job = page.locator(`[data-failed-job="${failedJobs.items[0]?.id ?? 'missing'}"]`);
  await expect(job).toBeVisible();
  // S-25.20: the queue in words, never its code name.
  await expect(job.getByText('A call to a connected tool')).toBeVisible();
  await expect(job.getByText('pipeline.outbound')).toHaveCount(0);
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
  await nav.getByRole('link', { name: 'Rules & limits' }).click();
  for (const heading of [
    'How much agents do alone',
    'Features',
    'Sensitive areas',
    // S-25.7: the cap editor moved to the Budgets tab; Rules & limits points there.
    'Budgets',
    'Notifications',
    'Who changed what',
    // S-28.7: which manual CI jobs the platform starts, waits for, or leaves alone.
    'Manual CI jobs',
  ]) {
    await expect(section.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  // BD-027's *Custom* with the differences listed, and the audit row that says who moved the dial.
  await expect(page.getByText('Custom', { exact: true })).toBeVisible();
  await expect(page.getByText('preset 5, in force 2')).toBeVisible();
  await expect(page.getByText('Changed how much agents do alone')).toBeVisible();
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
  // this is the tier that shows the selects, the *Returned* checkboxes and the save work in a browser.
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
  // *Returned* is a checkbox list since S-25.10 (a native multi-select needed Cmd/Ctrl-click).
  const returned = card.getByRole('group', { name: 'Returned' });
  await returned.getByRole('checkbox', { name: 'Sent back (to do)' }).check();
  await expect(returned.getByText('1 selected of at most 10')).toBeVisible();
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

test('the retired Appearance URL lands where /settings does, and a box sits above the page', async ({
  page,
}) => {
  await page.goto('/settings/appearance');
  await expect(page).toHaveURL(/\/settings\/policies$/);
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

test('the project panels render the knowledge base, the suggested edits and the budget meter', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/knowledge`);
  // S-23.11b: the files are a NavList grouped by folder; the item is the file's own name.
  const files = page.getByRole('navigation', { name: 'Knowledge files' });
  await expect(files.getByRole('heading', { name: 'technical' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'architecture.md' })).toBeVisible();
  await expect(page.getByText('lessons/retries.md').first()).toBeVisible();
  await expect(page.getByText('significance')).toHaveCount(0);
  // WP-96 (backlog 326): the health panel's success branch, which the fake's 404 used to hide.
  await expect(page.locator('[data-kb-health="findings"]')).toBeVisible();
  await expect(page.getByText('links to runbooks/missing.md')).toBeVisible();
  await expect(page.getByText('The health report could not be loaded.')).toHaveCount(0);

  await page.goto(`/projects/${PROJECT_KEY}/budgets`);
  await expect(page.getByLabel('Cap used')).toBeVisible();
  // The meter's own figure; the cap field below repeats it in its hint (spent … of … this window).
  await expect(
    page.getByRole('list', { name: 'Budgets', exact: true }).getByText('$100.00', { exact: true }),
  ).toBeVisible();
  // S-25.7 (research/21 F8): where the month's money went, and the cap set on the same page.
  await expect(
    page.getByRole('list', { name: 'By stage' }).getByText('Implementation'),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Top tasks' }).getByText('DEMO-1')).toBeVisible();
  await expect(page.getByText('$9.00 ($0.50 estimated)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project budgets', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save budgets' })).toBeVisible();

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
  // S-25.7 (research/21 F15): what the figure is from, and which way is good.
  await expect(returns.getByText('From 1 delivered task', { exact: true })).toBeVisible();
  await expect(returns.getByText('Lower is better', { exact: true })).toBeVisible();
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
  // S-25.4: the run sits inside its project's frame with its URL unchanged, and its *Now: Needs
  // you* (DEMO-1 has an open question) links to the answer box on the task's page in the project.
  await expect(
    page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name: 'Board' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(`/runs/${IDS.run}`);
  await expect(page.getByRole('link', { name: 'Answer the question →' })).toHaveAttribute(
    'href',
    new RegExp(`^/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}#answer-`),
  );

  // WP-85: what became of each steer, read from the command log and said in words.
  const sent = page.getByRole('region', { name: 'Commands sent to this run' });
  await expect(sent.getByText(/the agent received it/)).toBeVisible();
  await expect(sent.getByText(/the run ended before this message could be applied/)).toBeVisible();
  await page.getByLabel('Message the agent').fill('also check the rounding');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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
  await expect(page.getByLabel('Message the agent')).toHaveCount(0);

  // WP-159: a select over `GET /api/org/models`, starting (WP-167) on *Configured (…)*, which names
  // the run read's `retry_defaults`. Wait for a listed option the run is not on first, so the value
  // is asserted over the loaded list (rule 87). Since S-23.10 the fields are behind *Re-run ▾*.
  await page.getByRole('button', { name: 'Re-run', exact: true }).click();
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
    .getByRole('button', { name: 'Re-run', exact: true })
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
  // S-23.9b: the timeline says there is none, and the menu offers no stage command at all. The
  // timeline is the Flow's list mode since S-25.4.
  await page.getByTestId('task-flow').getByRole('button', { name: 'List' }).click();
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
  await page.getByRole('menuitem', { name: 'Work on it yourself…' }).click();
  await page.getByLabel('Why you are taking it over').fill('the agent is looping');
  await page.getByRole('checkbox', { name: /archive the workspace/ }).check();
  await page.getByRole('button', { name: 'Work on it yourself', exact: true }).click();

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
  await expect(page.getByText('A person is working on it')).toBeVisible();
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
  await page.getByRole('button', { name: 'Give it back to the agent…' }).click();
  const picker = page.getByLabel('Resume at');
  // S-23.22: each option says the stage's name; its value is still the id the route takes.
  await expect(picker.locator('option')).toHaveText([
    'Refinement',
    'Implementation',
    'Code review',
  ]);
  await picker.selectOption('code_review');
  await page.getByLabel('What you did').fill('fixed it by hand');
  await page.getByRole('button', { name: 'Give it back to the agent', exact: true }).click();
  await expect
    .poll(async () => (await commandLog(request)).map((entry) => entry.path))
    .toContain(`/api/tasks/${IDS.taskTaken}/hand-back`);
  const log = await commandLog(request);
  expect(log.find((entry) => entry.path.endsWith('/hand-back'))?.body).toEqual({
    stage: 'code_review',
    summary: 'fixed it by hand',
  });
});

/**
 * S-25.11 (product/10's Task detail amendment of 2026-11-07): a task CI sent back says why, who acts
 * and the round, with no action, while the Developer is on it — and the timeline's returned attempt
 * says where it went and why. A CI check that timed out (AUT-6655's shape) says it did not finish,
 * never that it failed, with what the platform saw last and the next step.
 */
test('a task CI sent back says why and what happens next; a timed-out CI check never reads as failed (S-25.11)', async ({
  page,
}) => {
  await page.goto(`/tasks/${IDS.taskCiFixing}`);
  await expect(page.getByRole('heading', { level: 1, name: /Round VAT once/ })).toBeVisible();
  const notice = page.getByRole('region', { name: 'What happens next' });
  await expect(
    notice.getByText(
      'CI failed on the merge request (job unit): the Developer is fixing it (round 2 of 3).',
    ),
  ).toBeVisible();
  await expect(notice.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs you' })).toHaveCount(0);
  // The header's Now line carries the short form.
  await expect(page.getByText('Now: CI failed · fixing, round 2/3')).toBeVisible();
  // The stage timeline's returned attempt names where it went and why.
  await page.getByTestId('task-flow').getByRole('button', { name: 'List' }).click();
  await expect(
    page.getByText('Sent back to Implementation: CI failed on the merge request (job unit).'),
  ).toBeVisible();

  await page.goto(`/tasks/${IDS.taskCiTimedOut}`);
  const needs = page.getByRole('region', { name: 'Needs you' });
  await expect(
    needs.getByText('CI did not finish in the time the platform waits for it. Nothing failed.'),
  ).toBeVisible();
  await expect(
    needs.getByText(/What the platform saw last: .*sentry-release-commit/),
  ).toBeVisible();
  await expect(needs.getByText(/Start or finish it there, then retry the stage\./)).toBeVisible();
  await expect(needs.getByRole('button', { name: 'Retry stage…' })).toBeVisible();
  await expect(needs.getByText(/CI failed/)).toHaveCount(0);
});

/**
 * S-25.12 (product/10's Task detail amendments of 2026-11-07), AUT-6655's shape: GitLab holds a
 * draft merge request's pipeline at the manual job `sentry-release-commit`, 60 minutes allowed.
 * While the CI check waits, the page says what it waits for and is *Needs you* at once, with the job
 * as its one next step; once the wait timed out, it says it did not finish within 60 minutes, from
 * the read — never a failure, and never the recorded sentence's internal words.
 */
test('a CI check held at a manual job says what it waits for, and its timeout from the read (S-25.12)', async ({
  page,
}) => {
  await page.goto(`/tasks/${IDS.taskCiHeld}`);
  await expect(
    page.getByRole('heading', { level: 1, name: /Release the Sentry commit/ }),
  ).toBeVisible();
  const needs = page.getByRole('region', { name: 'Needs you' });
  await expect(
    needs.getByText(
      'CI is waiting for someone to start the manual job sentry-release-commit in GitLab. Start it there and the task continues.',
    ),
  ).toBeVisible();
  await expect(needs.getByRole('link', { name: 'sentry-release-commit' })).toHaveAttribute(
    'href',
    AUT_6655_JOB_URL,
  );
  await expect(needs.getByText(/\d+ min so far; the task gives up after 60/)).toBeVisible();
  // The platform keeps the merge request a draft: the note links the readiness panel.
  await expect(needs.getByRole('link', { name: 'Discovery & readiness' })).toHaveAttribute(
    'href',
    `/projects/${PROJECT_KEY}/settings/discovery`,
  );
  // Needs you at once: the header's state, its Now line and its one primary.
  await expect(page.locator('[data-state-label="needs_you"]').first()).toHaveText('Needs you');
  await expect(
    page.getByText('Now: CI waits for someone to start the manual job sentry-release-commit'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start the job in GitLab' })).toHaveAttribute(
    'href',
    AUT_6655_JOB_URL,
  );

  await page.goto(`/tasks/${IDS.taskCiHeldTimedOut}`);
  const parked = page.getByRole('region', { name: 'Needs you' });
  await expect(
    parked.getByText(
      'CI did not finish within 60 minutes: pipeline 3038234623 was still held at the manual job sentry-release-commit.',
    ),
  ).toBeVisible();
  await expect(parked.getByText('Start the job in GitLab, then Retry.')).toBeVisible();
  await expect(parked.getByRole('button', { name: 'Retry stage…' })).toBeVisible();
  // S-25.15: that Retry stage… is the page's one amber primary, and the header offers no Resume.
  const primaries = page.locator('main [class~="border-primary-line"]');
  await expect(primaries).toHaveCount(1);
  await expect(primaries).toHaveText('Retry stage…');
  await expect(page.getByRole('main').getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await expect(parked.getByText(/What the platform saw last/)).toHaveCount(0);
  await expect(parked.getByText(/poll-only|ci_timeout_minutes|CI failed/)).toHaveCount(0);
});

/**
 * S-25.14 (product/10's Task detail amendment of 2026-11-07), AUT-6676's shape: the task stopped
 * because its Jira ticket is assigned to Vojtěch Kaizr, whom the platform cannot link. The callout
 * says whose ticket it is — from the record, not the brief — with the ways out in the box, *Take it*
 * the page's one amber primary, and the brief under *Details*. *Take it* writes the assignment
 * back, so it asks once, through the header's own confirmation.
 */
test('a ticket someone else holds says whose it is, with the ways out in the box (S-25.14)', async ({
  page,
  request,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskHeldElsewhere}`);
  await expect(
    page.getByRole('heading', { level: 1, name: /Export invoices as CSV/ }),
  ).toBeVisible();
  const needs = page.getByRole('region', { name: 'Needs you' });
  await expect(needs.locator('[data-held-sentence]')).toHaveText(
    `AUT-6676 is assigned in Jira to ${HELD_ELSEWHERE_ASSIGNEE}, so no agent started on it. ${HELD_ELSEWHERE_ASSIGNEE} isn’t a linked member of this project.`,
  );
  // The ways out, for an administrator: the owner control's two, Link account…, the ticket, Cancel.
  const steps = needs.locator('[data-held-steps]');
  await expect(steps.getByRole('button', { name: 'Take it' })).toBeVisible();
  await expect(steps.getByRole('button', { name: 'Assign…' })).toBeVisible();
  await expect(steps.getByRole('link', { name: 'Link account…' })).toHaveAttribute(
    'href',
    '/settings/identities',
  );
  await expect(steps.getByRole('link', { name: 'Open in Jira' })).toHaveAttribute(
    'href',
    AUT_6676_URL,
  );
  await expect(steps.getByRole('button', { name: 'Cancel task…' })).toBeVisible();
  // One amber primary, and it is the box's Take it: the header offers no Resume.
  const primaries = page.locator('main [class~="border-primary-line"]');
  await expect(primaries).toHaveCount(1);
  await expect(primaries).toHaveText('Take it');
  // S-25.15 part B: one Take it on the page — the header's owner line says Unassigned alone.
  await expect(page.locator('main').getByRole('button', { name: 'Take it' })).toHaveCount(1);
  await expect(page.locator('main').getByRole('button', { name: 'Assign…' })).toHaveCount(1);
  await expect(page.locator('[data-task-owner]')).toHaveText('Unassigned');
  // The brief, collapsed.
  const details = needs.locator('details[data-escalation-details]');
  await expect(details.locator('summary')).toHaveText('Details');
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(details.getByText(/the ticket is assigned to somebody other than/)).toBeVisible();

  // Take it, written back to Jira: one confirmation, the header's, naming whom it replaces.
  await steps.getByRole('button', { name: 'Take it' }).click();
  const dialog = page.getByRole('dialog', { name: 'Take AUT-6676?' });
  await expect(dialog).toContainText(
    `This also assigns AUT-6676 in Jira to you, replacing ${HELD_ELSEWHERE_ASSIGNEE}.`,
  );
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Take it and assign in Jira' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const taken = (await commandLog(request)).filter((entry) => entry.path.endsWith('/owner'));
  expect(taken).toEqual([
    { path: `/api/tasks/${IDS.taskHeldElsewhere}/owner`, body: { user_id: IDS.user } },
  ]);
});

/**
 * S-25.15 part B: why a stopped task waits, on every surface — AUT-6676's card, its row on Home's
 * *Needs you* and its row in the Inbox's *Stopped* section say whose ticket it is, the name as
 * text, and the Inbox row opens the task.
 */
test('why a stopped task waits, on the board, Home and the Inbox (S-25.15 part B)', async ({
  page,
  request,
}) => {
  await openWaiting(request);
  const words = `Waiting for: ${HELD_ELSEWHERE_ASSIGNEE}’s Jira ticket`;
  await page.goto(`/projects/${PROJECT_KEY}`);
  const held = page.getByRole('article', { name: 'AUT-6676' });
  await expect(held.locator('[data-card-setback="escalated"]')).toHaveText(words);
  await expect(held.locator('[data-needs-you]')).toHaveCount(1);

  await page.goto('/');
  const needs = page.getByRole('list', { name: 'Needs you' });
  await expect(needs.locator('[data-home-stop="held_elsewhere"]')).toHaveText(words);

  await page.goto('/inbox');
  const stopped = page.getByRole('list', { name: 'Stopped, waiting for a person' });
  const row = stopped.locator(`[data-inbox-escalated="${IDS.taskHeldElsewhere}"]`);
  await expect(row).toHaveText(words);
  // No command in the row: it opens the task, where it is decided (M25).
  await expect(stopped.getByRole('button')).toHaveCount(0);
  const open = stopped.getByRole('link', { name: 'Open AUT-6676' });
  await expect(open).toHaveAttribute('data-row-link', '');
  await open.click();
  await expect(page).toHaveURL(`/tasks/${IDS.taskHeldElsewhere}`);
  await expect(
    page.getByRole('region', { name: 'Needs you' }).locator('[data-held-sentence]'),
  ).toContainText(HELD_ELSEWHERE_ASSIGNEE);
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
  await page.getByRole('tab', { name: 'Knowledge given' }).click();
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

/**
 * S-26.8b (the M26 UX spec §§ 2–3): the owner on the task page — a task somebody else owns (taken,
 * then assigned through *Assign…*'s picker over the owner candidates read), one the tracker assigns
 * to a person the platform cannot link, and one nobody owns — and on the board: the card's avatar, and *Everyone* · *Mine* · *Unassigned* in the URL, in the request (the fake applies
 * `?owner=` as the server does) and remembered for the next visit.
 */
test('the owner on the task page and the board, with the board’s filter remembered (S-26.8b)', async ({
  page,
  request,
}) => {
  // DEMO-1: owned by somebody who is not the operator, so *Take it* asks first and names them.
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskFeature}`);
  await expect(page.getByRole('heading', { name: 'DEMO-1' })).toBeVisible();
  const owned = page.locator('[data-task-owner="owned"]');
  await expect(owned).toContainText(`Owner: ${OWNER_NAME}`);
  await expect(owned.locator('[data-avatar]')).toHaveText('VD');
  await owned.getByRole('button', { name: 'Take it' }).click();
  const dialog = page.getByRole('dialog', { name: `Take DEMO-1 from ${OWNER_NAME}?` });
  await expect(dialog).toContainText('Their machine stops getting it.');
  // The project does not write the assignment back, so the tracker is not mentioned.
  await expect(dialog).not.toContainText('Jira');
  await dialog.getByRole('button', { name: `Take it from ${OWNER_NAME}` }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-owner-done]')).toHaveText(
    'Assigned to you. Your machine picks it up at the next stage.',
  );
  const taken = (await commandLog(request)).filter((entry) => entry.path.endsWith('/owner'));
  expect(taken).toEqual([
    { path: `/api/tasks/${IDS.taskFeature}/owner`, body: { user_id: IDS.user } },
  ]);

  // *Assign…* (S-26.8b's follow-up): the people the server accepts, and what choosing one does —
  // Petra's assignment is written back, replacing the tracker's assignee (DEMO-1's owner came from
  // the tracker). Her name is her own text, rendered as text.
  await owned.getByRole('button', { name: 'Assign…' }).click();
  const picker = page.getByRole('dialog', { name: 'Assign DEMO-1' });
  await picker.getByLabel('Person').selectOption(IDS.ownerPetra);
  await expect(picker.locator('[data-owner-assign-consequence]')).toHaveText(
    `Assign DEMO-1 to ${CANDIDATE_NAME}? ${OWNER_NAME}’s machine stops getting it. This also assigns DEMO-1 in Jira to ${CANDIDATE_NAME}, replacing ${OWNER_NAME}.`,
  );
  await expect(picker.locator('script')).toHaveCount(0);
  await picker.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-owner-done]')).toHaveText(
    `Assigned to ${CANDIDATE_NAME}. Their machine picks it up at the next stage.`,
  );
  const assigned = (await commandLog(request)).filter((entry) => entry.path.endsWith('/owner'));
  expect(assigned).toEqual([
    { path: `/api/tasks/${IDS.taskFeature}/owner`, body: { user_id: IDS.user } },
    { path: `/api/tasks/${IDS.taskFeature}/owner`, body: { user_id: IDS.ownerPetra } },
  ]);

  // DEMO-2: the tracker's assignee, unlinked — their name is text, and an administrator may link.
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskBug}`);
  const unlinked = page.locator('[data-task-owner="unlinked"]');
  await expect(unlinked).toContainText(
    `Assigned in Jira to ${UNLINKED_ASSIGNEE} (not linked to a platform account)`,
  );
  await expect(unlinked.locator('script')).toHaveCount(0);
  await expect(unlinked.getByRole('link', { name: 'Link account…' })).toHaveAttribute(
    'href',
    '/settings/identities',
  );

  // DEMO-3: nobody owns it, and the tracker names nobody.
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskTaken}`);
  await expect(page.locator('[data-task-owner="unassigned"]')).toContainText('Unassigned');

  // The board: the owner's initials on the card, nothing on a card nobody owns.
  await page.goto(`/projects/${PROJECT_KEY}`);
  const demo1 = page.getByRole('article', { name: 'DEMO-1' });
  await expect(demo1.getByRole('img', { name: `Owner: ${OWNER_NAME}` })).toHaveText('VD');
  await expect(demo1.locator('[data-card-owner]')).toHaveAttribute('title', `Owner: ${OWNER_NAME}`);
  await expect(
    page.getByRole('article', { name: 'DEMO-2' }).locator('[data-card-owner]'),
  ).toHaveCount(0);

  // *Unassigned*: in the URL, applied by the server, and remembered for the next visit.
  const whose = page.getByRole('group', { name: 'Whose tasks' });
  await whose.getByRole('button', { name: 'Unassigned' }).click();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}?owner=none`);
  await expect(page.getByRole('article', { name: 'DEMO-2' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'DEMO-1' })).toHaveCount(0);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}?owner=none`);
  await expect(whose.getByRole('button', { name: 'Unassigned' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // *Everyone* forgets it.
  await whose.getByRole('button', { name: 'Everyone' }).click();
  await expect(page).toHaveURL(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole('article', { name: 'DEMO-1' })).toBeVisible();
});

test('why a task waits, on the board, the task page and the inbox (S-26.8b part 2)', async ({
  page,
  request,
}) => {
  await openWaiting(request);
  await page.goto(`/projects/${PROJECT_KEY}`);
  // The short form, every name as text; "your machine" to the machine's owner.
  await expect(
    page.getByRole('article', { name: 'DEMO-20' }).locator('[data-card-waiting]'),
  ).toHaveText(`Waiting · ${OWNER_NAME}’s machine is offline`);
  await expect(
    page.getByRole('article', { name: 'DEMO-21' }).locator('[data-card-waiting]'),
  ).toHaveText('Waiting · your machine needs an update');
  const unlinked = page.getByRole('article', { name: 'DEMO-22' }).locator('[data-card-waiting]');
  await expect(unlinked).toHaveText(`Waiting · assigned to ${UNLINKED_ASSIGNEE} (not linked)`);
  await expect(unlinked.locator('script')).toHaveCount(0);
  // A CI check held at a manual job: its short form, and Needs you.
  const held = page.locator('[data-column="waiting"]').getByRole('article', { name: 'DEMO-8' });
  await expect(held.locator('[data-card-setback="ci_held"]')).toHaveText('CI held · start the job');
  await expect(held.locator('[data-needs-you]')).toHaveCount(1);

  // The task page: the long form, and the read's Take it as a secondary step.
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${IDS.taskWaitingOffline}`);
  const notice = page.getByRole('region', { name: 'Why it waits' });
  await expect(notice.locator('[data-waiting]')).toHaveText(
    `Waiting for ${OWNER_NAME}’s machine. It’s offline (last seen 2 h ago).`,
  );
  await expect(notice.getByRole('button', { name: 'Take it' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Assign…' })).toBeVisible();

  // The inbox: the held job is a row of its own.
  await page.goto('/inbox');
  await expect(page.locator(`[data-inbox-ci-held="${IDS.taskCiHeld}"]`)).toHaveText(
    'CI waits for someone to start the manual job sentry-release-commit',
  );
});
