/**
 * The *Add a worker* wizard (S-23.20) in the built bundle, against the fake backend: entered from the
 * top bar's `+` menu, its installer line and its by-hand commands carry this page's origin, Install
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
  // The installer of the platform the browser reports comes first (Playwright's *Desktop Chrome*
  // reports Windows); the other is behind a disclosure.
  const windowsFirst = /\bWin(?:dows|32|64)\b/.test(await page.evaluate(() => navigator.userAgent));
  const shown = windowsFirst
    ? {
        os: 'windows',
        label: 'Windows (PowerShell)',
        run: `irm ${origin}/api/worker/v1/install.ps1 | iex`,
        url: `${origin}/api/worker/v1/install.ps1`,
      }
    : {
        os: 'unix',
        label: 'macOS or Linux (Terminal)',
        run: `curl -fsSL ${origin}/api/worker/v1/install.sh | sh`,
        url: `${origin}/api/worker/v1/install.sh`,
      };
  const installer = page.locator(`[data-installer="${shown.os}"]`);
  await expect(installer.getByLabel(shown.label, { exact: true })).toBeVisible();
  await expect(installer.getByLabel(shown.label, { exact: true })).toHaveValue(shown.run);
  await expect(installer.getByRole('link', { name: 'Read the script first' })).toHaveAttribute(
    'href',
    shown.url,
  );
  await page.getByText('Set it up by hand', { exact: true }).click();
  await expect(page.getByLabel('Download the worker’s compose file', { exact: true })).toHaveValue(
    `curl -fsSo compose.worker.yml ${origin}/api/worker/v1/compose.yml`,
  );
  await expect(
    page.getByLabel('Then create a file named .env.worker beside it, with this line', {
      exact: true,
    }),
  ).toHaveValue(`APP_CORE_URL=${origin}`);

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
