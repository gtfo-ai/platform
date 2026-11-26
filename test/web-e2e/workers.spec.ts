/**
 * **What this machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1), in the built
 * bundle against the fake backend: the signed-in operator (an administrator) owns `jan-mbp`
 * (*My tasks and unassigned ones*) and `night-owl` (*Everything*), and `POST /__test__/workers-others`
 * adds Vojtěch's `vojta-mbp` (*Only my tasks*) and a project with no server claimant.
 *
 * The consequence line's evidence is the machine's own claim-scope read (BD-035,
 * `GET /api/workers/:id/claim-scope`), whose `unassigned_has_taker` the fake answers as the server
 * does: any other machine counts, the owner's own included; one read per owned machine, asked again
 * after a save. So `night-owl` under *Only my tasks* is told nothing (`jan-mbp` takes unassigned
 * tasks) — and once it is saved so, `jan-mbp` under *Only my tasks* is told the project's
 * unassigned tasks have nowhere to run. Then the save's request in the
 * server's log, *Saved*, the sentence the stored answer gives, and Vojtěch's machine read with
 * nothing to press, his name and the runs its policy leaves for others.
 */
import { expect, type Page, test } from '@playwright/test';
import { HOSTILE, IDS } from './support/fixtures.js';
import { commandLog, resetBackend, signIn } from './support/harness.js';

// The test signs in **at `/workers`** (the sign-in page redirects back there), so Home — whose
// `useWorkerNeed` asks the project's execution without a machine — never renders and cannot put a
// read in the page's log after the listener is attached (CI on #109: one such read, `none`).
test.beforeEach(async ({ request }) => {
  await resetBackend(request);
  expect((await request.post('/__test__/workers-others')).ok()).toBe(true);
});

const PROJECT_NAME = `Demo service ${HOSTILE.image}`;

/** The claim-scope read of one machine, once it has answered (after a save it is asked again). */
const scopeAnswered = (page: Page, workerId: string) =>
  page.waitForResponse(
    (answer) => new URL(answer.url()).pathname === `/api/workers/${workerId}/claim-scope`,
  );

test('Workers: the owner changes what their machine takes, warned per machine; somebody else’s reads with their name', async ({
  page,
  request,
}) => {
  // From before the page's load: which machines' claim scope the page asks.
  const scopeReads: string[] = [];
  page.on('request', (sent) => {
    const read = /^\/api\/workers\/([^/]+)\/claim-scope$/.exec(new URL(sent.url()).pathname);
    if (read !== null) {
      scopeReads.push(read[1] ?? '');
    }
  });
  await signIn(page, '/workers');
  await expect(page.getByRole('heading', { level: 1, name: 'Workers' })).toBeVisible();
  const mine = page.locator(`[data-worker="${IDS.worker}"] [data-worker-policy]`);
  const sentence = mine.locator('[data-claim-policy-sentence]');
  await expect(sentence).toHaveText(
    'This machine takes your tasks and unassigned ones, in all your projects.',
  );
  await expect(mine.locator('[data-policy-skipped]')).toHaveCount(0);
  // The owner's two machines asked what their cards may offer; Vojtěch's did not.
  await expect
    .poll(() => [...new Set(scopeReads)].sort())
    .toEqual([IDS.worker, IDS.workerPaused].sort());

  // night-owl: jan-mbp, the owner's other machine, takes unassigned tasks — no warning.
  const owl = page.locator(`[data-worker="${IDS.workerPaused}"] [data-worker-policy]`);
  await owl.getByRole('button', { name: 'Change' }).click();
  await owl.getByRole('radio', { name: 'Only my tasks' }).check();
  await expect(owl.getByRole('radio', { name: 'Only my tasks' })).toBeChecked();
  await expect(owl.getByText(/nowhere to run/)).toHaveCount(0);
  const mineReread = scopeAnswered(page, IDS.worker);
  await owl.getByRole('button', { name: 'Save' }).click();
  await expect(owl.getByText('Saved · applies to the next run')).toBeVisible();

  // jan-mbp: now nobody else takes the project's unassigned tasks — the warning, as text. Every
  // card's read is asked again after a save, so jan-mbp's answer reflects night-owl's.
  await mineReread;
  await mine.getByRole('button', { name: 'Change' }).click();
  await mine.getByRole('radio', { name: 'Only my tasks' }).check();
  await expect(mine.getByText(/have nowhere to run\.$/)).toHaveText(
    `Unassigned tasks in ${PROJECT_NAME} have nowhere to run.`,
  );
  await expect(mine.locator('img')).toHaveCount(0);

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
  expect(scopeReads).not.toContain(IDS.workerOthers);
});
