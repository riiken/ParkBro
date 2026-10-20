import { expect, test } from '@playwright/test';
import { adminSession, samplePhoto, seedPublishedParking } from './helpers.ts';

const SECRET_ADDRESS = '42 Hidden Garden Road';
const SECRET_ACCESS = 'Gate PIN 9911';

test('a customer finds a nearby listing and views it without seeing the exact address', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));

  const admin = await adminSession(playwright, baseURL ?? '');
  const host = await playwright.request.newContext(baseURL ? { baseURL } : {});
  // Letters only: long digit runs are (rightly) rejected as possible phone numbers in public text.
  const suffix = Array.from({ length: 5 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const title = `Gated driveway ${suffix}`;
  const listingId = await seedPublishedParking(host, admin, {
    title,
    areaLabel: 'Koramangala',
    latitude: 12.9352,
    longitude: 77.6245,
    address: SECRET_ADDRESS,
    accessInstructions: SECRET_ACCESS,
    photo: await samplePhoto(browser, 140),
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Search near you' }).click();
  await expect(page.getByRole('heading', { name: 'Find parking near you' })).toBeVisible();

  // Searching without a place explains what to do.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toContainText('Choose a place');

  await page.getByLabel('Where?').fill('kora');
  await page.getByRole('button', { name: /Koramangala/ }).click();
  await page.getByLabel('Booking type').selectOption('HOURLY');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const card = page.getByRole('link', { name: new RegExp(title) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('₹40/hour');
  await expect(card).toContainText(/~\d+ m|~\d\.\d km/);

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/listings/${listingId}\\?lat=`));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(
    page.getByText('The exact address and entry details are shared after you book.'),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: `Photo of ${title}` })).toBeVisible();
  await expect(page.getByText('₹3,000/month')).toBeVisible();
  await expect(page.getByText('Hosted by Meera')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to book' })).toBeVisible();

  // A hard load (server-rendered HTML) must also satisfy the CSP, not only client navigation.
  await page.reload();
  await expect(page.getByRole('img', { name: `Photo of ${title}` })).toBeVisible();

  // Location privacy in the rendered page, not just the API (L-9).
  const html = await page.content();
  expect(html).not.toContain(SECRET_ADDRESS);
  expect(html).not.toContain(SECRET_ACCESS);
  expect(html).not.toContain('Iyer'); // individual hosts by first name only (L-8)

  // Photo actually loads (served by the API through the same origin).
  const photoOk = await page
    .getByRole('img', { name: `Photo of ${title}` })
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(photoOk).toBe(true);

  expect(problems).toEqual([]);
  await Promise.all([admin.api.dispose(), host.dispose()]);
});

test('an empty search offers to widen the area', async ({ page }) => {
  await page.goto('/search');
  await page.getByRole('radio', { name: 'EV charging' }).check();
  await page.getByLabel('Where?').fill('airport');
  await page.getByRole('button', { name: /Kempegowda International Airport/ }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: /No spots found near Kempegowda/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search within 10 km' })).toBeVisible();
});

test('unknown listings show a not-found page', async ({ page }) => {
  const res = await page.goto('/listings/01a1568b-0000-7000-8000-000000000000');
  expect(res?.status()).toBe(404);
});

test('a customer describes what they need and the search is filled in and run', async ({ page }) => {
  await page.goto('/search');
  await page.getByLabel('Describe what you need').fill('fast CCS2 charging near Yelahanka');
  await page.getByRole('button', { name: 'Fill in the search' }).click();
  const understood = page.locator('.understood');
  for (const chip of ['EV charging', 'Near Yelahanka', 'CCS2', 'DC fast']) {
    await expect(understood.getByText(chip, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('Where?')).toHaveValue('Yelahanka');
  await expect(page.getByLabel('Connector')).toHaveValue('CCS2');
  // The regular search ran; availability comes from it, never from the AI.
  await expect(page.getByRole('heading', { name: /No spots found near Yelahanka/ })).toBeVisible();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Thanks for the feedback.')).toBeVisible();
});
