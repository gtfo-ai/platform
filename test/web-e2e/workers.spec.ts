/**
 * **What this machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1), in the built
 * bundle against the fake backend: the signed-in operator (an administrator) owns `jan-mbp` and
 * `night-owl`, and `POST /__test__/workers-others` adds Vojtěch's `vojta-mbp`. The operator changes
 * their own machine through `PUT /api/workers/:id/claim-policy` — the request in the server's log,
 * *Saved*, and the sentence the stored answer gives — and reads Vojtěch's machine with nothing to
 * press, with his name and the runs its policy leaves for others. The consequence line is **not
 * said** on this screen yet (BACKLOG 1350), though the project's execution read here says nobody
 * else takes its unassigned tasks: no execution read is made, and no line is drawn.
 */
import { expect, test } from '@playwright/test';
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

test('Workers: the owner changes what their machine takes; somebody else’s reads with their name', async ({
  page,
  request,
}) => {
  const executionReads: string[] = [];
  page.on('request', (sent) => {
    if (/\/api\/projects\/[^/]+\/execution$/.test(new URL(sent.url()).pathname)) {
      executionReads.push(sent.url());
    }
  });
  // From before the page's load: the screen asks no project's execution, on load or on Change.
  await page.goto('/workers');
  await expect(page.getByRole('heading', { level: 1, name: 'Workers' })).toBeVisible();

  const mine = page.locator(`[data-worker="${IDS.worker}"] [data-worker-policy]`);
  const sentence = mine.locator('[data-claim-policy-sentence]');
  await expect(sentence).toHaveText(
    'This machine takes your tasks and unassigned ones, in all your projects.',
  );
  await expect(mine.locator('[data-policy-skipped]')).toHaveCount(0);

  await mine.getByRole('button', { name: 'Change' }).click();
  await mine.getByRole('radio', { name: 'Only my tasks' }).check();
  await expect(mine.getByRole('radio', { name: 'Only my tasks' })).toBeChecked();
  // BACKLOG 1350: not said here yet, and nothing asked for it.
  await expect(mine.getByText(/nowhere to run/)).toHaveCount(0);
  await expect(mine.locator('img')).toHaveCount(0);

  await mine.getByRole('radio', { name: 'Only these:' }).check();
  await mine.getByRole('checkbox', { name: `Demo service ${HOSTILE.image}` }).check();
  await mine.getByRole('button', { name: 'Save' }).click();
  await expect(mine.getByText('Saved · applies to the next run')).toBeVisible();
  await expect(sentence).toHaveText(
    `This machine takes only your tasks, in Demo service ${HOSTILE.image}.`,
  );
  await expect
    .poll(async () =>
      (await commandLog(request)).filter((entry) => entry.path.endsWith('/claim-policy')),
    )
    .toEqual([
      {
        path: `/api/workers/${IDS.worker}/claim-policy`,
        body: { claim_policy: 'mine', claim_project_ids: [IDS.project] },
      },
    ]);

  // Vojtěch's machine: read only, his name in the sentence, and the runs it leaves for others.
  const theirs = page.locator(`[data-worker="${IDS.workerOthers}"] [data-worker-policy]`);
  await expect(theirs.locator('[data-claim-policy-sentence]')).toHaveText(
    'This machine takes only Vojtěch’s tasks, in all their projects.',
  );
  await expect(theirs.getByRole('button', { name: 'Change' })).toHaveCount(0);
  await expect(theirs.locator('[data-policy-skipped]')).toHaveText(
    'Skipped 3 runs this machine doesn’t take',
  );
  await expect(page.getByText(/nowhere to run/)).toHaveCount(0);
  expect(executionReads).toEqual([]);
});
