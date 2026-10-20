import { expect, test, type Page } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';

function uniquePhone(): string {
  return `9${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
}

/** The form's error message (Next.js also renders a hidden role="alert" route announcer). */
const formError = (page: Page) => page.locator('form [role="alert"]');

/** Fails the test on any CSP violation or uncaught page error. */
function watchForViolations(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text()))
      problems.push(msg.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

test('a new customer signs up, manages their account and signs out', async ({ page }) => {
  const problems = watchForViolations(page);
  const phone = uniquePhone();

  // Protected page redirects to sign-in and back afterwards.
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount|\/sign-in\?next=\/account/);

  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await expect(page.getByText(`ending ${phone.slice(-4)}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend code in \d+s/ })).toBeDisabled();

  // Wrong code: clear, specific error and the form stays usable.
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(formError(page)).toContainText('That code is incorrect');

  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

  // Consent is required before an account is created.
  await page.getByLabel('Your name').fill('Priya Sharma');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('You must be 18 or older')).toBeVisible();
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByText(`Signed in as +91 ••••••${phone.slice(-4)}`)).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();

  // The session cookie is host-only, HttpOnly, Secure, SameSite=Lax.
  const cookie = (await page.context().cookies()).find((c) => c.name === '__Host-pb_session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

  // Profile update persists across reloads.
  await page.getByLabel('Your name').fill('Priya S');
  await page.getByLabel('Language').selectOption('hi');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(page.getByLabel('Your name')).toHaveValue('Priya S');
  await expect(page.getByLabel('Language')).toHaveValue('hi');

  // Data rights (DPDP): a copy of my data, with a reply-by date.
  await page.getByRole('button', { name: 'A copy of my data' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText(/A copy of my data · we'll reply by/)).toBeVisible();

  // Sign out ends the session; the account page then requires sign-in again.
  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in/);

  expect(problems).toEqual([]);
});

test('pages are served with a strict per-request nonce CSP', async ({ request }) => {
  const first = await request.get('/sign-in');
  const second = await request.get('/sign-in');
  const csp = first.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(second.headers()['content-security-policy']).not.toBe(csp);
  expect(first.headers()['x-frame-options']).toBe('DENY');
});

test('an invalid number is explained without leaving the page', async ({ page }) => {
  const problems = watchForViolations(page);
  await page.goto('/sign-in');
  await page.getByLabel('Mobile number').fill('12345');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(formError(page)).toContainText('Enter a valid Indian mobile number');
  await expect(page.getByLabel('Mobile number')).toBeEditable();
  expect(problems).toEqual([]);
});

test('open redirects via ?next= are ignored', async ({ page }) => {
  const phone = uniquePhone();
  await page.goto('/sign-in?next=//evil.example/steal');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Redirect Test');
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4110\/account$/);
});
