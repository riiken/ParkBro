import { expect, test } from '@playwright/test';
import pg from 'pg';
import { apiEnv } from '../playwright.config.ts';
import { adminSession, samplePhoto, seedPublishedParking, signUpInUi } from './helpers.ts';

const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pick = () => L[Math.floor(Math.random() * L.length)];

test('after a completed booking the customer reviews it and opens a dispute with a message', async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  test.setTimeout(200_000);
  const admin = await adminSession(playwright, baseURL ?? '');
  const hostApi = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const title = `Reviewed spot ${Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
  const listingId = await seedPublishedParking(hostApi, admin, {
    title,
    areaLabel: 'Koramangala',
    latitude: 12.9352,
    longitude: 77.6245,
    address: '3 Review Hidden Lane',
    accessInstructions: 'Gate on the left',
    photo: await samplePhoto(browser, 90),
  });

  await page.goto(`/listings/${listingId}`);
  await page.getByRole('link', { name: 'Sign in to book' }).click();
  await signUpInUi(page, 'Neha Kapoor');
  await page
    .getByLabel('Registration number')
    .fill(`KA 04 ${pick()}${pick()} ${1000 + Math.floor(Math.random() * 9000)}`);
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 2 * 86_400_000),
  );
  await page.getByLabel('Date').fill(day);
  await page.getByRole('button', { name: 'Check price' }).click();
  await page.getByRole('button', { name: 'Reserve' }).click();
  await page.getByRole('button', { name: 'Pay ₹80' }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  const bookingId = /\/bookings\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

  // Test-only time travel: the booking took place yesterday and completed.
  const db = new pg.Client({ connectionString: apiEnv.DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE booking.bookings SET period = tstzrange(now() - interval '26 hours', now() - interval '24 hours', '[)'), status = 'COMPLETED' WHERE id = $1`,
    [bookingId],
  );
  await db.end();
  await page.reload();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();

  const review = page.getByRole('form', { name: 'Leave a review' });
  await review.getByLabel('How was the space?').selectOption('4');
  await review.getByLabel('Getting in (optional)').selectOption('5');
  await review.getByLabel('Comment (optional, public)').fill('Easy access, a bit tight for an SUV.');
  await review.getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByText(/You rated ★★★★☆ · hidden until both reviews are in/)).toBeVisible();

  await page.getByRole('button', { name: 'Report a problem with this booking' }).click();
  await page.getByLabel('What happened?').selectOption('INCORRECT_LISTING');
  await page.getByLabel('Describe it').fill('The listing said covered but the bay was open.');
  await page.getByLabel('What would put it right?').selectOption('PARTIAL_REFUND');
  await page.getByRole('button', { name: 'Open dispute' }).click();
  await expect(page).toHaveURL(/\/disputes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'The listing was wrong' })).toBeVisible();
  await expect(page.getByText('Received')).toBeVisible();
  await page.getByLabel('Add a message').fill('It rained, so this mattered.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('It rained, so this mattered.')).toBeVisible();

  // The listing doesn't show the review yet (blind until the host reviews or the window closes).
  await page.goto(`/listings/${listingId}`);
  await expect(page.getByText('Easy access, a bit tight')).toHaveCount(0);
  await Promise.all([admin.api.dispose(), hostApi.dispose()]);
});
