import { expect, test, type Page } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';
import { istDate, suffix } from './audit-helpers.ts';
import { adminSession, samplePhoto, uniquePhone } from './helpers.ts';

/**
 * Functional audit: the host listing editor. Every field in every section is set to a non-default value, saved,
 * and proven persisted after a reload; then the public listing must show each one (and never the private access
 * text); then pause / publish again; then calendar blocks.
 */
test.describe.configure({ mode: 'serial' });

const S = suffix();
const title = `Audit stilt bay ${S}`;
const PRIVATE_ACCESS = `Gate code 7${S.length}91 then left`;
let listingUrl = '';

async function save(page: Page, heading: string, button: RegExp = /^(Save|Confirm)$/) {
  const section = page.getByRole('region', { name: heading });
  await section.getByRole('button', { name: button }).click();
  await expect(
    section.getByRole('status').filter({ hasText: 'Saved' }).or(section.getByText('Confirmed.')).first(),
  ).toBeVisible();
}

test('every editor field saves and survives a reload; the public listing shows them, never the private access', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await page.goto('/host');
  await page.getByLabel('Mobile number').fill(uniquePhone());
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Audit Host');
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Your name as customers see it').fill('Audit');
  await page.getByRole('button', { name: 'Become a host' }).click();
  await page.getByRole('link', { name: 'List a parking space' }).click();
  await page.getByLabel('Type of property').selectOption('COMMERCIAL');
  await page.getByLabel('Full address').fill('77 Audit Lane, Koramangala');
  await page.getByLabel('Area (shown publicly)').fill('kora');
  await page
    .getByRole('button', { name: /Koramangala/ })
    .first()
    .click();
  await page.getByLabel('Listing title').fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  listingUrl = page.url();

  // The space: every control to a non-default.
  const space = page.getByRole('region', { name: 'The space' });
  await space.getByLabel('Open', { exact: true }).check();
  await space.getByLabel('Where').selectOption('STILT');
  await space.getByLabel('Largest vehicle that fits').selectOption('MUV');
  await space.getByLabel('Height limit (m, optional)').fill('2.1');
  await space.getByLabel('Length (m, optional)').fill('5.2');
  for (const label of ['CCTV', 'Security guard', 'Gated', 'Well lit at night', /EV-ready socket/, /Tandem/])
    await space.getByLabel(label).check();
  await save(page, 'The space');

  // Spaces.
  await page.getByLabel('Space labels, one per line').fill('B1\nB2\nB3');
  await save(page, 'Spaces');

  // Photos: two kinds; then remove the second.
  await page.getByLabel('Photo of').selectOption({ label: 'The space' });
  await page
    .getByLabel('Add photo')
    .setInputFiles({ name: 'slot.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 15) });
  await expect(page.getByRole('img', { name: 'slot photo' })).toBeVisible();
  await page.getByLabel('Photo of').selectOption({ label: 'The entrance' });
  await page
    .getByLabel('Add photo')
    .setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 210) });
  await expect(page.getByRole('img', { name: /entrance photo/i })).toBeVisible();
  await page
    .getByRole('region', { name: 'Photos' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('img', { name: /entrance photo/i }) })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByRole('img', { name: /entrance photo/i })).toHaveCount(0);

  // Prices: all four parking modes, with overnight hours.
  await page.getByLabel(/^Hourly/).fill('50');
  await page.getByLabel(/^Daily/).fill('300');
  await page.getByLabel(/^Overnight \(/).fill('150');
  await page.getByLabel('Overnight from').fill('21:00');
  await page.getByLabel('Overnight until').fill('07:00');
  await page.getByLabel(/^Monthly/).fill('3500');
  await save(page, 'Prices');

  // Schedule: custom, weekdays 08:00–20:00.
  const schedule = page.getByRole('region', { name: "When it's available" });
  await schedule.getByLabel('Custom').check();
  for (const d of ['Sat', 'Sun']) await schedule.getByLabel(d, { exact: true }).uncheck();
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await schedule.getByLabel(d, { exact: true }).check();
  await schedule.getByLabel('From').fill('08:00');
  await schedule.getByLabel('Until').fill('20:00');
  await save(page, "When it's available");

  // Description, rules and access.
  await page
    .getByLabel('Description (public)')
    .fill('Stilt bay under an office block, 2 minutes to Forum Mall.');
  await page.getByLabel('House rules (public)').fill('No overnight engine idling. Reverse park only.');
  await page.getByLabel('How to get in (private)').fill(PRIVATE_ACCESS);
  await save(page, 'Description, rules and access');

  // Booking settings.
  const settings = page.getByRole('region', { name: 'Booking settings' });
  await settings.getByLabel(/I approve/).check();
  await settings.getByLabel(/Shortest hourly/).fill('2');
  await settings.getByLabel(/Longest hourly/).fill('10');
  await settings.getByLabel('Notice needed (hours)').fill('3');
  await settings.getByLabel('Gap between bookings (minutes)').fill('15');
  await settings.getByLabel('Cancellation policy').selectOption('STRICT');
  await save(page, 'Booking settings');

  await page.getByLabel('I confirm this is true').check();
  await save(page, 'Your confirmation', /^Confirm$/);

  // Reload: every value persisted.
  await page.reload();
  await expect(space.getByLabel('Open', { exact: true })).toBeChecked();
  await expect(space.getByLabel('Where')).toHaveValue('STILT');
  await expect(space.getByLabel('Largest vehicle that fits')).toHaveValue('MUV');
  await expect(space.getByLabel('Height limit (m, optional)')).toHaveValue('2.1');
  await expect(space.getByLabel('Length (m, optional)')).toHaveValue('5.2');
  for (const label of ['CCTV', 'Security guard', 'Gated', 'Well lit at night', /EV-ready socket/, /Tandem/])
    await expect(space.getByLabel(label)).toBeChecked();
  await expect(page.getByLabel('Space labels, one per line')).toHaveValue('B1\nB2\nB3');
  await expect(page.getByLabel(/^Hourly/)).toHaveValue('50');
  await expect(page.getByLabel(/^Daily/)).toHaveValue('300');
  await expect(page.getByLabel(/^Overnight \(/)).toHaveValue('150');
  await expect(page.getByLabel('Overnight from')).toHaveValue('21:00');
  await expect(page.getByLabel('Overnight until')).toHaveValue('07:00');
  await expect(page.getByLabel(/^Monthly/)).toHaveValue('3500');
  await expect(schedule.getByLabel('Sat', { exact: true })).not.toBeChecked();
  await expect(schedule.getByLabel('Mon', { exact: true })).toBeChecked();
  await expect(schedule.getByLabel('From')).toHaveValue('08:00');
  await expect(schedule.getByLabel('Until')).toHaveValue('20:00');
  await expect(page.getByLabel('How to get in (private)')).toHaveValue(PRIVATE_ACCESS);
  await expect(settings.getByLabel(/I approve/)).toBeChecked();
  await expect(settings.getByLabel(/Shortest hourly/)).toHaveValue('2');
  await expect(settings.getByLabel(/Longest hourly/)).toHaveValue('10');
  await expect(settings.getByLabel('Notice needed (hours)')).toHaveValue('3');
  await expect(settings.getByLabel('Gap between bookings (minutes)')).toHaveValue('15');
  await expect(settings.getByLabel('Cancellation policy')).toHaveValue('STRICT');
  await expect(page.getByText('Everything is ready.')).toBeVisible();

  // Submit → approve → the public page shows every attribute; the private access text never appears.
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();
  const assetId = /\/host\/listings\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const admin = await adminSession(playwright, baseURL ?? '');
  const approved = await admin.api.post(`/api/admin/assets/${assetId}/approve`, {
    headers: admin.headers,
    data: {},
  });
  expect(approved.ok(), await approved.text()).toBe(true);
  await admin.api.dispose();

  await page.goto(`/listings/${assetId}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const facts = page.locator('.facts');
  for (const text of [
    'Open · Stilt',
    'Fits up to MUV / 7-seater',
    'Height limit 2.10 m',
    'Length 5.2 m',
    'Security: CCTV, Guard, Gated',
    'Well lit',
    'EV-ready socket',
    /Tandem/,
    '3 spaces',
  ])
    await expect(facts.getByText(text)).toBeVisible();
  await expect(page.getByText('Mon–Fri, 08:00–20:00')).toBeVisible();
  await expect(page.getByText('Stilt bay under an office block, 2 minutes to Forum Mall.')).toBeVisible();
  await expect(page.getByText('No overnight engine idling. Reverse park only.')).toBeVisible();
  const prices = page.locator('table.prices');
  for (const p of ['₹50/hour', '₹300/day', '₹150/night', '₹3,500/month'])
    await expect(prices.getByText(p)).toBeVisible();
  await expect(prices.getByText('(21:00–07:00)')).toBeVisible();
  await expect(page.getByText(/Cancellation: Strict/)).toBeVisible();
  await expect(page.getByText('The host approves each request.')).toBeVisible();
  expect(await page.content()).not.toContain(PRIVATE_ACCESS);

  // Pause hides it from customers; publish again restores it.
  await page.goto(listingUrl);
  await page.getByRole('button', { name: 'Pause listing' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/v1/listings/${assetId}`)).status()).toBe(404);
  await page.getByRole('button', { name: 'Publish again' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/v1/listings/${assetId}`)).status()).toBe(200);

  // Calendar: block one space for two hours, see it on that day, remove it.
  await page.goto(`${listingUrl}/calendar`);
  const block = page.getByRole('form', { name: 'Block time' });
  await block.getByLabel('Date').fill(istDate(4));
  await block.getByLabel('From').fill('09:00');
  await block.getByLabel('Until').fill('11:00');
  await block.getByLabel('Space').selectOption({ label: 'B2' });
  await block.getByLabel('Note (only you see it)').fill('Painting');
  const saved = page.waitForResponse(
    (r) => r.url().includes('availability-exceptions') && r.request().method() === 'POST',
  );
  await block.getByRole('button', { name: 'Block' }).click();
  expect((await saved).status()).toBe(201);
  // The calendar jumps to the blocked day; space B2 shows the block, B1 doesn't.
  await expect(page.getByLabel('Day')).toHaveValue(istDate(4));
  const b2 = page.getByRole('region', { name: 'Space B2' });
  await expect(b2.locator('.blocked')).toContainText('Blocked: Painting');
  await expect(page.getByRole('region', { name: 'Space B1' }).locator('.blocked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove block' }).first().click();
  await expect(page.locator('.timeline .blocked')).toHaveCount(0);
});
