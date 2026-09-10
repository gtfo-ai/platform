/**
 * Sign-in, the route guard and the deep-link return (TD-022, technical/09).
 *
 * The guard is a convenience — the server authorises every request — so what is asserted here is
 * the *behaviour a user sees*: a refused deep link comes back to where it was going, a wrong
 * password says so, and a redirect target that points off-origin is refused.
 */
import { expect, test } from '@playwright/test';
import { CREDENTIALS } from './support/fixtures.js';
import { signIn } from './support/harness.js';

test.describe('authentication', () => {
  test('an unauthenticated visit is sent to the sign-in page', async ({ page }) => {
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
    await expect(page.getByRole('heading', { name: 'Agentic platform' })).toBeVisible();
  });

  test('a wrong password is reported and does not sign the user in', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(CREDENTIALS.email);
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Those credentials were not accepted.');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('signing in returns to the deep link that was refused', async ({ page }) => {
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);

    await page.getByLabel('Email').fill(CREDENTIALS.email);
    await page.getByLabel('Password').fill(CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  });

  test('a redirect pointing at another origin is refused', async ({ page }) => {
    // `//evil.example` is protocol-relative: a browser resolves it to another origin, so a client
    // that navigated to it would turn the login page into an open redirect.
    await page.goto('/sign-in?redirect=%2F%2Fevil.example%2Fsteal');
    await page.getByLabel('Email').fill(CREDENTIALS.email);
    await page.getByLabel('Password').fill(CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
  });

  test('signing out returns to the sign-in page', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
