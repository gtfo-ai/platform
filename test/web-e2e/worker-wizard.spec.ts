/**
 * The *Add a worker* wizard (S-23.20) in the built bundle, against the fake backend: entered from the
 * top bar's `+` menu, its by-hand commands carry this page's origin (no installer line until the
 * core serves one), Install
 * continues on the person's word, Start points at the worker's page and keeps the hand-made Claude
 * sign-in and its troubleshooting as fallbacks, Approve is done by a worker of this
 * person created since the wizard opened, and Ready lists what stops that worker in words.
 *
 * The fixture's workers were created on 2026-09-10 and last seen then too, so a wizard opened
 * "now" sees none of them as its own, and one opened with `since` before that sees `jan-mbp` —
 * which, last seen two months before any browser's clock, is not connected.
 */
import { expect, test } from '@playwright/test';
import { resetBackend, signIn } from './support/harness.js';

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
});

test('Add a worker: from the + menu through Install and Start, with this platform’s commands', async ({
  page,
  baseURL,
}) => {
  await page.getByRole('button', { name: 'Create new…' }).click();
  await page.getByRole('menuitem', { name: 'Add a worker' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add a worker' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Install' })).toBeVisible();
  await expect(page).toHaveURL(/[?&]since=/);

  const origin = new URL(baseURL ?? '').origin;
  // Until the core serves the one-line installer (S-22.20, `INSTALLER_AVAILABLE`), the by-hand
  // setup is the step itself and no installer line is shown.
  await expect(page.locator('[data-installer]')).toHaveCount(0);
  await expect(page.getByLabel('Download the worker’s compose file', { exact: true })).toHaveValue(
    `curl -fsSo compose.worker.yml ${origin}/api/worker/v1/compose.yml`,
  );
  await expect(
    page.getByLabel('Then create a file named .env.worker beside it, with this line', {
      exact: true,
    }),
  ).toHaveValue(`APP_CORE_URL=${origin}`);
  await expect(page.getByLabel('Start the worker', { exact: true })).toHaveValue(
    'docker compose --env-file .env.worker -f compose.worker.yml up -d',
  );

  const toStart = page.getByRole('button', { name: 'Continue to Start it and sign in' });
  await expect(toStart).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I’ve done this' }).check();
  await expect(toStart).toBeEnabled();
  await toStart.click();

  await expect(page.getByRole('heading', { level: 2, name: 'Start it and sign in' })).toBeVisible();
  await expect(page.getByText(/walks you through signing in to Claude/)).toBeVisible();
  await page.getByText('If you set it up by hand', { exact: true }).click();
  await expect(page.getByText(/The token appears in the/)).toBeVisible();
  const trouble = page.getByRole('region', { name: 'Troubleshooting' });
  await trouble.getByText('Safari can’t connect to localhost:…/callback').click();
  await expect(trouble.getByText(/stopped before you authorized/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Approve' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approve the code' })).toHaveAttribute(
    'href',
    '/workers/approve',
  );
  // No worker of this person was created since the wizard opened.
  await expect(page.getByText(/Waiting for your new worker to appear/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Ready to work' })).toBeDisabled();
});

test('Add a worker: a worker of this person since the wizard opened is approved, and Ready says why it takes nothing', async ({
  page,
}) => {
  await page.goto('/workers/new?step=approve&since=2026-09-01T00:00:00.000Z&installed=true');
  await expect(page.getByText(/is approved and connected/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Ready to work' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Ready to work' })).toBeVisible();
  const needs = page.getByRole('list', { name: 'What the worker needs' });
  await expect(needs.getByText(/^Not connected — last seen/)).toBeVisible();
  await expect(needs.getByText(/^Start the worker on that computer/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Choose projects' })).toBeDisabled();
});
