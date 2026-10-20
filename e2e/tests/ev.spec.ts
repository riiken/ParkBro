import { expect, test, type Page } from '@playwright/test';
import { adminSession, samplePhoto, signUpInUi } from './helpers.ts';

const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pick = () => L[Math.floor(Math.random() * L.length)];
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

async function save(page: Page, region: string) {
  const r = page.getByRole('region', { name: region });
  await r.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(
    r.getByRole('status').filter({ hasText: 'Saved' }).or(r.getByText('Confirmed.')),
  ).toBeVisible();
}

/** Next quarter hour at least a minute away, in IST: {date, from, to}. */
function nextWindow() {
  const t = new Date(Date.now() + 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(t)
      .map((p) => [p.type, p.value]),
  );
  let minutes = Number(parts.hour) * 60 + Number(parts.minute);
  minutes = Math.ceil(minutes / 15) * 15;
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  if (minutes >= 24 * 60) {
    minutes -= 24 * 60;
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { date, from: hhmm(minutes), to: hhmm(minutes + 60) };
}

test('a host lists an EV charger; a driver books it and starts and stops charging', async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  test.setTimeout(200_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  const title = `Home wallbox charger ${letters(5)}`;

  // Host: EV listing through the wizard and editor.
  await page.goto('/host');
  await signUpInUi(page, 'Kavya Iyer');
  await page.getByLabel('Your name as customers see it').fill('Kavya');
  await page.getByRole('button', { name: 'Become a host' }).click();
  await page.getByRole('link', { name: 'List a parking space' }).click();
  await page.getByLabel(/EV charging/).check();
  await page.getByLabel('Full address').fill('8 Hidden Charger Lane, Indiranagar');
  await page.getByLabel('Area (shown publicly)').fill('indira');
  await page
    .getByRole('button', { name: /Indiranagar/ })
    .first()
    .click();
  await page.getByLabel('Listing title').fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('Describe the charger')).toBeVisible();
  await expect(page.getByText('Confirm the charger safety statement')).toBeVisible();

  await save(page, 'The parking bay');
  await page.getByLabel('Rated power (kW)').fill('7.4');
  await save(page, 'The charger');
  await save(page, 'Spaces');
  await page.getByLabel('Photo of').selectOption('SLOT');
  await page
    .getByLabel('Add photo')
    .setInputFiles({ name: 'bay.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 120) });
  await expect(page.getByRole('img', { name: 'slot photo' })).toBeVisible();
  await page.getByLabel('Photo of').selectOption('CHARGER');
  await page
    .getByLabel('Add photo')
    .setInputFiles({ name: 'charger.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 200) });
  await expect(page.getByRole('img', { name: 'charger photo' })).toBeVisible();
  await page.getByLabel('Charging price (₹)').fill('120');
  await page.getByLabel('Charged').selectOption('PER_HOUR');
  await save(page, 'Prices');
  await save(page, "When it's available");
  await page.getByLabel('How to get in (private)').fill('Charger is on the left wall');
  await save(page, 'Description, rules and access');
  await page
    .getByRole('region', { name: 'Your confirmation' })
    .getByLabel(/I confirm this is true/)
    .check();
  await save(page, 'Your confirmation');
  await page
    .getByRole('region', { name: 'Charger safety' })
    .getByLabel(/I confirm this is true/)
    .check();
  await save(page, 'Charger safety');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();
  const assetId = /\/host\/listings\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  const admin = await adminSession(playwright, baseURL ?? '');
  const approved = await admin.api.post(`/api/admin/assets/${assetId}/approve`, {
    headers: admin.headers,
    data: {},
  });
  expect(approved.ok(), await approved.text()).toBe(true);

  // Driver (separate browser context): sign up from the listing, add the EV, book now.
  const driverContext = await browser.newContext();
  const driver = await driverContext.newPage();
  driver.on('pageerror', (e) => problems.push(e.message));
  await driver.goto(`/listings/${assetId}`);
  await expect(driver.getByText('Fast AC charging')).toBeVisible();
  await driver.getByRole('link', { name: 'Sign in to book' }).click();
  await signUpInUi(driver, 'Arjun Menon');
  await driver
    .getByLabel('Registration number')
    .fill(`KA 53 ${pick()}${pick()} ${1000 + Math.floor(Math.random() * 9000)}`);
  await expect(driver.getByLabel('Electric vehicle')).toBeChecked();
  await driver.getByLabel('Charging connector').selectOption('TYPE2');
  await driver.getByRole('button', { name: 'Save vehicle' }).click();
  const w = nextWindow();
  await driver.getByLabel('Date').fill(w.date);
  await driver.getByLabel('From').fill(w.from);
  await driver.getByLabel('Until').fill(w.to);
  await driver.getByRole('button', { name: 'Check price' }).click();
  await expect(driver.locator('.quote')).toContainText('₹120');
  await driver.getByRole('button', { name: 'Reserve' }).click();
  await expect(driver).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  const bookingId = /\/bookings\/([0-9a-f-]{36})/.exec(driver.url())?.[1] ?? '';

  // Pay through the (test) provider checkout: success arrives as a signed webhook, never from the page.
  await driver.getByRole('button', { name: 'Pay ₹120' }).click();
  await driver.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(driver.getByText('Confirmed', { exact: true })).toBeVisible();
  await driver.reload();
  const panel = driver.getByRole('region', { name: 'Charging' });
  await expect(panel).toContainText('Plug in, then tap Start.');
  await expect(panel).toContainText('Fast AC charging · AC 7.4 kW · Type 2');
  await panel.getByRole('button', { name: 'Start charging' }).click();
  await expect(panel).toContainText('Charging since');
  await panel.getByRole('button', { name: 'Stop charging' }).click();
  await expect(panel).toContainText('Stopped at');

  // The host sees the session on the booking (read-only).
  await page.goto(`/host/bookings/${bookingId}`);
  await expect(page.getByRole('region', { name: 'Charging' })).toContainText('Stopped at');
  await expect(page.getByRole('button', { name: 'Start charging' })).toHaveCount(0);

  // Earnings: ₹120 paid, 10% commission, ₹108 pending until 48 h after the booking ends.
  await page.goto('/host/earnings');
  await expect(page.getByRole('row', { name: /Pending/ })).toContainText('₹108');
  await expect(page.getByRole('region', { name: 'By booking' })).toContainText('commission −₹12');
  await page.getByLabel('Account holder name').fill('Kavya Iyer');
  await page.getByLabel('UPI ID').fill('kavya@okbank');
  await page.getByRole('button', { name: 'Save payout account' }).click();
  await expect(page.getByText(/Being verified/)).toBeVisible();

  expect(problems).toEqual([]);
  await Promise.all([admin.api.dispose(), driverContext.close()]);
});
