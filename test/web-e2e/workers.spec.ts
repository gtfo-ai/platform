/**
 * **What this machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1), in the built
 * bundle against the fake backend: the signed-in operator (an administrator) owns `jan-mbp`
 * (*My tasks and unassigned ones*) and `night-owl` (*Everything*), and `POST /__test__/workers-others`
 * adds Vojtěch's `vojta-mbp` (*Only my tasks*) and a project with no server claimant.
 *
 * The consequence line's evidence is the project's execution read **for the machine being changed**
 * (`?worker_id=`, which the fake answers as the server does: any other machine counts, the owner's
 * own included), asked only once *Change* opens. So `night-owl` under *Only my tasks* is told
 * nothing (`jan-mbp` takes unassigned tasks) — and once it is saved so, `jan-mbp` under *Only my
 * tasks* is told the project's unassigned tasks have nowhere to run. Then the save's request in the
 * server's log, *Saved*, the sentence the stored answer gives, and Vojtěch's machine read with
 * nothing to press, his name and the runs its policy leaves for others.
 */
import { expect, type Page, test } from '@playwright/test';
import { HOSTILE, IDS } from './support/fixtures.js';
import { commandLog, resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  expect((await request.post('/__test__/workers-others')).ok()).toBe(true);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

const PROJECT_NAME = `Demo service ${HOSTILE.image}`;

/** The execution read asked for one machine, once it has answered. */
const executionAnswered = (page: Page, workerId: string) =>
  page.waitForResponse(
    (answer) =>
      new URL(answer.url()).pathname === `/api/projects/${IDS.project}/execution` &&
      new URL(answer.url()).searchParams.get('worker_id') === workerId,
  );

test('Workers: the owner changes what their machine takes, warned per machine; somebody else’s reads with their name', async ({
  page,
  request,
}) => {
  // From before the page's load: no execution is asked until Change opens a card.
  const executionReads: string[] = [];
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (/^\/api\/projects\/[^/]+\/execution$/.test(url.pathname)) {
      executionReads.push(url.searchParams.get('worker_id') ?? 'none');
    }
  });
  await page.goto('/workers');
  await expect(page.getByRole('heading', { level: 1, name: 'Workers' })).toBeVisible();
  const mine = page.locator(`[data-worker="${IDS.worker}"] [data-worker-policy]`);
  const sentence = mine.locator('[data-claim-policy-sentence]');
  await expect(sentence).toHaveText(
    'This machine takes your tasks and unassigned ones, in all your projects.',
  );
  await expect(mine.locator('[data-policy-skipped]')).toHaveCount(0);
  expect(executionReads).toEqual([]);

  // night-owl: jan-mbp, the owner's other machine, takes unassigned tasks — no warning.
  const owl = page.locator(`[data-worker="${IDS.workerPaused}"] [data-worker-policy]`);
  const owlAnswered = executionAnswered(page, IDS.workerPaused);
  await owl.getByRole('button', { name: 'Change' }).click();
  await owlAnswered;
  await owl.getByRole('radio', { name: 'Only my tasks' }).check();
  await expect(owl.getByRole('radio', { name: 'Only my tasks' })).toBeChecked();
  await expect(owl.getByText(/nowhere to run/)).toHaveCount(0);
  await owl.getByRole('button', { name: 'Save' }).click();
  await expect(owl.getByText('Saved · applies to the next run')).toBeVisible();

  // jan-mbp: now nobody else takes the project's unassigned tasks — the warning, as text.
  const mineAnswered = executionAnswered(page, IDS.worker);
  await mine.getByRole('button', { name: 'Change' }).click();
  await mineAnswered;
  await mine.getByRole('radio', { name: 'Only my tasks' }).check();
  await expect(mine.getByText(/have nowhere to run\.$/)).toHaveText(
    `Unassigned tasks in ${PROJECT_NAME} have nowhere to run.`,
  );
  await expect(mine.locator('img')).toHaveCount(0);
  // Each read was for the machine being changed, and none without one.
  expect(executionReads).toEqual([IDS.workerPaused, IDS.worker]);

  await mine.getByRole('radio', { name: 'Only these:' }).check();
  await mine.getByRole('checkbox', { name: PROJECT_NAME }).check();
  await mine.getByRole('button', { name: 'Save' }).click();
  await expect(mine.getByText('Saved · applies to the next run')).toBeVisible();
  await expect(sentence).toHaveText(`This machine takes only your tasks, in ${PROJECT_NAME}.`);
  await expect
    .poll(async () =>
      (await commandLog(request)).filter((entry) => entry.path.endsWith('/claim-policy')),
    )
    .toEqual([
      {
        path: `/api/workers/${IDS.workerPaused}/claim-policy`,
        body: { claim_policy: 'mine', claim_project_ids: null },
      },
      {
        path: `/api/workers/${IDS.worker}/claim-policy`,
        body: { claim_policy: 'mine', claim_project_ids: [IDS.project] },
      },
    ]);

  // Vojtěch's machine: read only, his name in the sentence, the runs it leaves for others, and no
  // read asked for it.
  const theirs = page.locator(`[data-worker="${IDS.workerOthers}"] [data-worker-policy]`);
  await expect(theirs.locator('[data-claim-policy-sentence]')).toHaveText(
    'This machine takes only Vojtěch’s tasks, in all their projects.',
  );
  await expect(theirs.getByRole('button', { name: 'Change' })).toHaveCount(0);
  await expect(theirs.locator('[data-policy-skipped]')).toHaveText(
    'Skipped 3 runs this machine doesn’t take',
  );
  await expect(theirs.getByText(/nowhere to run/)).toHaveCount(0);
  expect(executionReads).not.toContain(IDS.workerOthers);
});
