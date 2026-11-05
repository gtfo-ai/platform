/**
 * Sign-in, the route guard and the deep-link return (TD-022, technical/09).
 *
 * The guard is a convenience — the server authorises every request — so what is asserted here is
 * the *behaviour a user sees*: a refused deep link comes back to where it was going, a wrong
 * password says so, and a redirect target that points off-origin is refused.
 */
import { type APIRequestContext, expect, test } from '@playwright/test';
import { CREDENTIALS } from './support/fixtures.js';
import { resetBackend, signIn } from './support/harness.js';

const HINT =
  'Nobody has signed in here yet. Use the administrator account set by APP_BOOTSTRAP_ADMIN_EMAIL.';

test.describe('the bootstrap hint (WP-291)', () => {
  test.beforeEach(async ({ request }) => {
    await resetBackend(request);
  });
  test.afterEach(async ({ request }) => {
    await resetBackend(request);
  });

  const pending = async (request: APIRequestContext, value: boolean | 'fails'): Promise<void> => {
    const response = await request.post('/__test__/setup-state', { data: { pending: value } });
    expect(response.ok()).toBe(true);
  };

  test('is shown while nobody has signed in, inside the form block below the button', async ({
    page,
    request,
  }) => {
    await pending(request, true);
    await page.goto('/sign-in');
    const hint = page.getByText(HINT);
    await expect(hint).toBeVisible();
    // Inside the ink block, below the button, so it never sits on the dither field.
    await expect(page.getByRole('region', { name: 'Sign in' }).getByText(HINT)).toBeVisible();
    const button = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
    const hintBox = await hint.boundingBox();
    expect(hintBox?.y ?? 0).toBeGreaterThan((button?.y ?? 0) + (button?.height ?? 0));
  });

  test('is absent once somebody has signed in', async ({ page, request }) => {
    await pending(request, false);
    const read = page.waitForResponse('**/api/setup-state');
    await page.goto('/sign-in');
    expect((await read).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(HINT)).toHaveCount(0);
  });

  test('is absent, with no error, when the read fails', async ({ page, request }) => {
    await pending(request, 'fails');
    const read = page.waitForResponse('**/api/setup-state');
    await page.goto('/sign-in');
    expect((await read).status()).toBe(500);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(HINT)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('the form keeps an amber focus ring and the field is decorative', async ({ page }) => {
    await page.goto('/sign-in');
    // The field is inside an `aria-hidden` box, so it is absent from the accessibility tree.
    await expect(page.locator('[aria-hidden="true"] > canvas')).toHaveCount(1);
    await page.getByLabel('Email').focus();
    await expect(page.getByLabel('Email')).toHaveCSS('outline-color', 'rgb(244, 184, 96)');
  });
});

test.describe('authentication', () => {
  test('an unauthenticated visit is sent to the sign-in page', async ({ page }) => {
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
    await expect(
      page.getByRole('heading', { name: 'Tickets in, merge requests out.' }),
    ).toBeVisible();
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
    await expect(
      page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
    ).toBeVisible();
  });

  test('signing out returns to the sign-in page', async ({ page }) => {
    await signIn(page);
    await expect(
      page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
    ).toBeVisible();

    // Sign out sits in the top bar's account menu since TD-033: one "open the menu" step.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
