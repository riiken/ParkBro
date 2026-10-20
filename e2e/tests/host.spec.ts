import { expect, test, type Page } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';
import { adminSession, registerUser, samplePhoto, uniquePhone } from './helpers.ts';

const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pick = () => L[Math.floor(Math.random() * L.length)];
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
      problems.push(`${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

async function saveSection(page: Page, heading: string) {
  const section = page.getByRole('region', { name: heading });
  await section.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(
    section.getByRole('status').filter({ hasText: 'Saved' }).or(section.getByText('Confirmed.')).first(),
  ).toBeVisible();
}

test('a host lists a space, gets it approved, receives a monthly request, approves it and sees the calendar', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const problems = watch(page);
  const title = `Stilt slot near the park ${letters(5)}`;

  // Hosting mode: sign up, then become a host.
  await page.goto('/host');
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await page.getByLabel('Mobile number').fill(uniquePhone());
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Anita Desai');
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/host$/);
  await page.getByLabel('Your name as customers see it').fill('Anita');
  await page.getByRole('button', { name: 'Become a host' }).click();
  await expect(page.getByRole('heading', { name: 'Hi Anita' })).toBeVisible();

  // Create: property + title.
  await page.getByRole('link', { name: 'List a parking space' }).click();
  await page.getByLabel('Full address').fill('14 Hidden Cross Road, Koramangala');
  await page.getByLabel('Area (shown publicly)').fill('kora');
  await page
    .getByRole('button', { name: /Koramangala/ })
    .first()
    .click();
  await expect(page.getByText('Location set to the area centre.')).toBeVisible();
  await page.getByLabel('Listing title').fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Add a photo of the space')).toBeVisible();

  // Fill every section.
  await page.getByLabel('Largest vehicle that fits').selectOption('SUV');
  await page.getByLabel('CCTV').check();
  await saveSection(page, 'The space');
  await saveSection(page, 'Spaces');
  await page
    .getByLabel('Add photo')
    .setInputFiles({ name: 'slot.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 30) });
  await expect(page.getByRole('img', { name: 'slot photo' })).toBeVisible();
  await page.getByLabel(/Hourly/).fill('40');
  await page.getByLabel(/Monthly/).fill('3000');
  await saveSection(page, 'Prices');
  await saveSection(page, "When it's available"); // default: always (24/7)
  await page.getByLabel('How to get in (private)').fill('Gate code 4455, slot on the left');
  await saveSection(page, 'Description, rules and access');
  await page.getByLabel('I confirm this is true').check();
  await saveSection(page, 'Your confirmation');
  await expect(page.getByText('Everything is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();
  const assetId = /\/host\/listings\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

  // Platform review (admin API), then the listing is live.
  const admin = await adminSession(playwright, baseURL ?? '');
  const approve = await admin.api.post(`/api/admin/assets/${assetId}/approve`, {
    headers: admin.headers,
    data: {},
  });
  expect(approve.ok(), await approve.text()).toBe(true);
  await page.reload();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  // A customer requests a monthly spot (API).
  const customerApi = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const customer = await registerUser(customerApi, 'Ravi Kumar');
  const vehicle = await customerApi.post('/api/v1/me/vehicles', {
    headers: customer.headers,
    data: {
      plate: `KA 03 ${pick()}${pick()} ${1000 + Math.floor(Math.random() * 9000)}`,
      vehicleClass: 'SEDAN',
    },
  });
  expect(vehicle.ok(), await vehicle.text()).toBe(true);
  const startDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + 2 * 86_400_000),
  );
  const [y, m, d] = startDate.split('-').map(Number) as [number, number, number];
  const endDate = new Date(Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())))
    .toISOString()
    .slice(0, 10);
  const quote = await customerApi.post('/api/v1/quotes', {
    headers: customer.headers,
    data: {
      assetId,
      mode: 'MONTHLY',
      start: `${startDate}T09:00:00+05:30`,
      end: `${endDate}T09:00:00+05:30`,
    },
  });
  expect(quote.ok(), await quote.text()).toBe(true);
  const booking = await customerApi.post('/api/v1/bookings', {
    headers: { ...customer.headers, 'idempotency-key': crypto.randomUUID() },
    data: { quoteId: (await quote.json()).quoteId, vehicleId: (await vehicle.json()).id },
  });
  expect(booking.ok(), await booking.text()).toBe(true);

  // The host sees the request on Today and approves it.
  await page.getByRole('navigation', { name: 'Hosting' }).getByRole('link', { name: 'Today' }).click();
  const request = page
    .getByRole('region', { name: 'Requests to respond to' })
    .getByRole('listitem')
    .filter({ hasText: 'Ravi K.' });
  await expect(request).toContainText('Monthly');
  await expect(request).toContainText('₹3,000');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('No requests waiting.')).toBeVisible();

  // Monthly plans and the booking detail show it; the customer's phone never appears.
  await page
    .getByRole('navigation', { name: 'Hosting' })
    .getByRole('link', { name: 'Monthly plans' })
    .click();
  await page.getByRole('link', { name: new RegExp(`Ravi K\\. · ${title}`) }).click();
  await expect(page.getByText('Requested', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Month 1' }).click();
  await expect(page.getByText('Approved. Waiting for the customer to pay.')).toBeVisible();
  expect(await page.content()).not.toContain(customer.phone.slice(-6));

  // Calendar: the held month shows as booked on the start day.
  await page.goto(`/host/listings/${assetId}/calendar`);
  await page.getByLabel('Day').fill(startDate);
  await expect(page.getByText(/Booked \(incl\. turnover gap\)/)).toBeVisible();
  await page.getByLabel('Date').fill(startDate);
  await page.getByRole('button', { name: 'Block' }).click();
  await expect(page.locator('form[aria-label="Block time"] [role="alert"]')).toContainText(/booking/i);

  expect(problems).toEqual([]);
  await Promise.all([admin.api.dispose(), customerApi.dispose()]);
});
