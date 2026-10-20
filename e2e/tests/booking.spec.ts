import { expect, test } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';
import { adminSession, samplePhoto, seedPublishedParking, uniquePhone } from './helpers.ts';

const SECRET_ADDRESS = '9 Quiet Lane Hidden';
const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pick = () => L[Math.floor(Math.random() * L.length)];
/** Unique per run: a plate can be active on only one account. */
const plate = `KA 05 ${pick()}${pick()} ${String(1000 + Math.floor(Math.random() * 9000))}`;

test('a customer signs in from a listing, adds a vehicle, reserves a space and cancels the hold', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
      problems.push(`${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(e.message));

  const admin = await adminSession(playwright, baseURL ?? '');
  const host = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const suffix = Array.from({ length: 5 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const title = `Booking driveway ${suffix}`;
  const listingId = await seedPublishedParking(host, admin, {
    title,
    areaLabel: 'Koramangala',
    latitude: 12.9352,
    longitude: 77.6245,
    address: SECRET_ADDRESS,
    accessInstructions: 'Ring the bell',
    photo: await samplePhoto(browser, 200),
  });

  await page.goto(`/listings/${listingId}`);
  await page.getByRole('link', { name: 'Sign in to book' }).click();
  await page.getByLabel('Mobile number').fill(uniquePhone());
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Kiran Rao');
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(new RegExp(`/listings/${listingId}$`));

  // First booking: add the vehicle inline.
  await page.getByLabel('Registration number').fill(plate);
  await page.getByLabel('Vehicle type').selectOption('SEDAN');
  await page.getByRole('button', { name: 'Save vehicle' }).click();

  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 86_400_000),
  );
  await page.getByLabel('Date').fill(tomorrow);
  await page.getByLabel('From').fill('10:00');
  await page.getByLabel('Until').fill('12:00');
  await page.getByRole('button', { name: 'Check price' }).click();
  await expect(page.locator('.quote')).toContainText('₹80');
  await expect(page.locator('.quote')).toContainText(plate);
  await page.getByRole('button', { name: 'Reserve' }).click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Held for payment')).toBeVisible();
  await expect(page.getByText(/holding this space for you until/)).toBeVisible();
  // Not confirmed, so no exact address (L-6).
  expect(await page.content()).not.toContain(SECRET_ADDRESS);

  // A failed test payment leaves the hold in place and explains what happened.
  await page.getByRole('button', { name: 'Pay ₹80' }).click();
  await page.getByRole('button', { name: 'Simulate a failed payment' }).click();
  await expect(page.getByText(/Payment didn't go through/)).toBeVisible();
  await expect(page.getByText('Held for payment')).toBeVisible();

  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Nothing has been charged.')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('Cancelled by you.')).toBeVisible();

  await page.getByRole('link', { name: 'Bookings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Past' })).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeVisible();

  expect(problems).toEqual([]);
  await Promise.all([admin.api.dispose(), host.dispose()]);
});

test('a customer requests a monthly spot from the listing and sees it under monthly plans', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const admin = await adminSession(playwright, baseURL ?? '');
  const host = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const title = `Monthly driveway ${Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
  const listingId = await seedPublishedParking(host, admin, {
    title,
    areaLabel: 'Koramangala',
    latitude: 12.9352,
    longitude: 77.6245,
    address: '3 Plan Street Hidden',
    accessInstructions: 'Ring twice',
    photo: await samplePhoto(browser, 260),
  });
  // Sign up from the listing link (the session cookie is Secure, so it is set by the app itself).
  await page.goto(`/sign-in?next=${encodeURIComponent(`/listings/${listingId}?mode=MONTHLY`)}`);
  await page.getByLabel('Mobile number').fill(uniquePhone());
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Meena Pillai');
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page
    .getByLabel('Registration number')
    .fill(`KA 51 ${pick()}${pick()} ${1000 + Math.floor(Math.random() * 9000)}`);
  await page.getByRole('button', { name: 'Save vehicle' }).click();

  // The search window carries into the listing (mode preselected).
  await expect(page.getByLabel('Booking type')).toHaveValue('MONTHLY');
  const start = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 3 * 86_400_000),
  );
  await page.getByLabel('Start date').fill(start);
  await page.getByRole('button', { name: 'Check price' }).click();
  await expect(page.locator('.quote')).toContainText('₹3,000');
  await expect(page.locator('.quote')).toContainText('The host approves this request before you pay.');
  await page.getByRole('button', { name: 'Request monthly spot' }).click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Waiting for host')).toBeVisible();
  await expect(page.getByText(/Month 1 of a monthly plan/)).toBeVisible();
  await page.getByRole('link', { name: 'View plan' }).click();
  await expect(
    page.getByText('Request sent. The host reviews monthly requests before you pay.'),
  ).toBeVisible();
  await page.getByRole('link', { name: '← Your bookings' }).click();
  await expect(page.getByRole('heading', { name: 'Monthly plans' })).toBeVisible();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await Promise.all([admin.api.dispose(), host.dispose()]);
});
