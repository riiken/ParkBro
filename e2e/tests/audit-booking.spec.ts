import { expect, test, type Page } from '@playwright/test';
import { istDate, nowWindow, seedListing, signInUi, suffix, uniquePlate } from './audit-helpers.ts';
import { adminSession } from './helpers.ts';

/**
 * Functional audit: the customer's booking journey beyond the main e2e journeys: vehicle form (EV + connector),
 * several vehicles, size checks, every booking type's price, payment success, cancelling a confirmed booking with
 * its refund, the access pass and the "I can't get in" form.
 */
test.describe.configure({ mode: 'serial' });

const S = suffix();
const ids: Record<string, string> = {};

test.beforeAll(async ({ playwright, browser, baseURL }) => {
  test.setTimeout(180_000);
  const admin = await adminSession(playwright, baseURL ?? '');
  const api = await playwright.request.newContext(baseURL ? { baseURL } : {});
  ids.small = (
    await seedListing(api, admin, browser, {
      title: `Hatchback bay ${S}`,
      latitude: 12.9719,
      longitude: 77.6412,
      areaLabel: 'Indiranagar',
      parking: { maxVehicleClass: 'HATCHBACK' },
      rates: [
        { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 3000 },
        { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 20000 },
        {
          mode: 'OVERNIGHT',
          unit: 'PER_NIGHT',
          pricePaise: 12000,
          overnightStart: '20:00',
          overnightEnd: '08:00',
        },
      ],
    })
  ).id;
  ids.charger = (
    await seedListing(api, admin, browser, {
      title: `Wallbox ${S}`,
      type: 'EV_CHARGING',
      latitude: 12.972,
      longitude: 77.642,
      areaLabel: 'Indiranagar',
      charger: { connectors: ['CCS2'], currentType: 'DC', powerKw: 30 },
      rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 25000 }],
    })
  ).id;
  await Promise.all([api.dispose(), admin.api.dispose()]);
});

/** Quote total as shown in the price box (₹ text). */
async function quoteTotal(page: Page) {
  await expect(page.locator('.quote')).toBeVisible();
  return (await page.locator('.quote tr').filter({ hasText: 'Total' }).locator('td').textContent())?.trim();
}

test('vehicles: EV reveals connector choices; too-big car refused; add another vehicle and switch', async ({
  page,
}) => {
  await signInUi(page);
  await page.goto(`/listings/${ids.small}`);
  // First vehicle: an electric SUV (too big for a hatchback bay) taking CCS2 and Type 2.
  const suv = uniquePlate();
  await page.getByLabel('Registration number').fill(suv);
  await page.getByLabel('Vehicle type').selectOption('SUV');
  await expect(page.getByRole('group', { name: 'Charging connectors it takes' })).toHaveCount(0);
  await page.getByLabel('Electric vehicle').check();
  const connectors = page.getByRole('group', { name: 'Charging connectors it takes' });
  await expect(connectors.getByLabel('CCS2')).toBeChecked();
  await connectors.getByLabel('Type 2').check();
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  await expect(page.getByText(/Booking for .*EV \(CCS2, Type 2\)/)).toBeVisible();
  const w = { date: istDate(2), from: '10:00', to: '12:00' };
  await page.getByLabel('Date').fill(w.date);
  await page.getByLabel('From').fill(w.from);
  await page.getByLabel('Until').fill(w.to);
  // Warned before pricing, and the price check is disabled for this vehicle.
  await expect(page.getByRole('alert').filter({ hasText: /too big/ })).toContainText(
    /too big: this space fits up to a hatchback/i,
  );
  await expect(page.getByRole('button', { name: 'Check price' })).toBeDisabled();

  // Add a second, smaller car from the booking box and book with it.
  const small = uniquePlate();
  await page.getByRole('button', { name: 'Add another vehicle' }).click();
  await page.getByLabel('Registration number').fill(small);
  await page.getByLabel('Vehicle type').selectOption('HATCHBACK');
  await page.getByLabel('Nickname (optional)').fill('City car');
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  await expect(page.getByLabel('Vehicle', { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`Booking for ${small}`))).toBeVisible();
  await page.getByLabel('Date').fill(w.date);
  await page.getByLabel('From').fill(w.from);
  await page.getByLabel('Until').fill(w.to);
  await page.getByRole('button', { name: 'Check price' }).click();
  expect(await quoteTotal(page)).toMatch(/₹6\d/); // 2 h × ₹30 + service fee
  await expect(page.locator('.quote')).toContainText(small);

  // Account: both vehicles listed; remove one (with confirmation); add another there.
  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Your vehicles' });
  await expect(section.getByText(suv)).toBeVisible();
  await expect(section.getByText('EV · CCS2, Type 2')).toBeVisible();
  await expect(section.getByText(/City car/)).toBeVisible();
  await section
    .getByRole('listitem')
    .filter({ hasText: suv })
    .getByRole('button', { name: 'Remove' })
    .click();
  await section.getByRole('button', { name: `Remove ${suv}` }).click();
  await expect(section.getByText(suv)).toHaveCount(0);
  await section.getByRole('button', { name: 'Add a vehicle' }).click();
  const third = uniquePlate();
  await section.getByLabel('Registration number').fill(third);
  await section.getByLabel('Vehicle type').selectOption('MUV');
  await section.getByRole('button', { name: 'Save vehicle' }).click();
  await expect(section.getByText(third)).toBeVisible();
  await expect(section.getByText('MUV / 7-seater')).toBeVisible();
});

test('every booking type prices correctly: hourly, daily (n days), overnight; charging session', async ({
  page,
}) => {
  await signInUi(page);
  await page.goto(`/listings/${ids.small}`);
  await page.getByLabel('Registration number').fill(uniquePlate());
  await page.getByLabel('Vehicle type').selectOption('HATCHBACK');
  await page.getByRole('button', { name: 'Save vehicle' }).click();

  const totals: Record<string, string | undefined> = {};
  await page.getByLabel('Booking type').selectOption('HOURLY');
  await page.getByLabel('Date').fill(istDate(3));
  await page.getByLabel('From').fill('09:00');
  await page.getByLabel('Until').fill('12:00');
  await page.getByRole('button', { name: 'Check price' }).click();
  totals.hourly = await quoteTotal(page);

  await page.getByLabel('Booking type').selectOption('DAILY');
  await page.getByLabel('Date').fill(istDate(3));
  await page.getByLabel('Days').fill('2');
  await page.getByRole('button', { name: 'Check price' }).click();
  totals.daily = await quoteTotal(page);

  await page.getByLabel('Booking type').selectOption('OVERNIGHT');
  await page.getByLabel('Night of').fill(istDate(3));
  await page.getByRole('button', { name: 'Check price' }).click();
  totals.overnight = await quoteTotal(page);

  // Host price × quantity, plus the customer service fee (never less than the host price).
  const rupees = (t?: string) => Number((t ?? '').replace(/[^\d]/g, ''));
  expect(rupees(totals.hourly)).toBeGreaterThanOrEqual(90);
  expect(rupees(totals.hourly)).toBeLessThan(110);
  expect(rupees(totals.daily)).toBeGreaterThanOrEqual(400);
  expect(rupees(totals.daily)).toBeLessThan(450);
  expect(rupees(totals.overnight)).toBeGreaterThanOrEqual(120);
  expect(rupees(totals.overnight)).toBeLessThan(140);

  // Charging session on the EV listing, with an EV that takes CCS2.
  await page.goto(`/listings/${ids.charger}`);
  await page.getByRole('button', { name: 'Add another vehicle' }).click();
  await page.getByLabel('Registration number').fill(uniquePlate());
  await page.getByLabel('Vehicle type').selectOption('SEDAN');
  await expect(page.getByLabel('Electric vehicle')).toBeChecked(); // charger listing: EV by default
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  await page.getByLabel('Date').fill(istDate(3));
  await page.getByLabel('From').fill('10:00');
  await page.getByLabel('Until').fill('11:00');
  await page.getByRole('button', { name: 'Check price' }).click();
  expect(rupees(await quoteTotal(page))).toBeGreaterThanOrEqual(250);
});

test('pay, confirmed booking shows access; share pass; report and withdraw a problem; cancel with refund', async ({
  page,
  context,
}) => {
  await signInUi(page);
  await page.goto(`/listings/${ids.small}`);
  await page.getByLabel('Registration number').fill(uniquePlate());
  await page.getByLabel('Vehicle type').selectOption('HATCHBACK');
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  const w = nowWindow(2);
  await page.getByLabel('Date').fill(w.date);
  await page.getByLabel('From').fill(w.from);
  await page.getByLabel('Until').fill(w.to);
  await page.getByRole('button', { name: 'Check price' }).click();
  await page.getByRole('button', { name: 'Reserve' }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Where to go: exact address and directions; access code and pass.
  await expect(page.getByText(/Audit Road, Bengaluru/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get directions' })).toHaveAttribute(
    'href',
    /google\.com\/maps\/dir/,
  );
  await expect(page.locator('.pass-code')).toHaveText(/\d\s?\d\s?\d\s?\d\s?\d\s?\d/);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Share with driver' }).click();
  await expect(page.getByRole('button', { name: 'Pass link copied' })).toBeVisible();
  const passUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(passUrl).toMatch(/\/pass\//);
  const pass = await context.newPage();
  await pass.goto(passUrl);
  await expect(pass.locator('.pass-code')).toBeVisible();
  await pass.close();
  const before = await page.locator('.pass-code').textContent();
  await page.getByRole('button', { name: 'New code' }).click();
  await expect(page.locator('.pass-code')).not.toHaveText(before ?? '');

  // Report a problem with a chosen reason and a note, then withdraw it.
  await page.getByRole('button', { name: "I can't get in" }).click();
  await page.getByLabel("What's wrong?").selectOption('UNIT_OCCUPIED');
  await page.getByLabel('Details (optional)').fill('A white car is parked in the bay');
  await page.getByRole('button', { name: 'Report problem' }).click();
  await expect(page.getByText(/Problem reported:.*Someone else is in my space/)).toBeVisible();
  await page.getByRole('button', { name: "It's sorted now" }).click();
  await expect(page.getByRole('button', { name: "I can't get in" })).toBeVisible();

  // Cancel the confirmed booking: refund preview, then the refund is recorded.
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText(/refund/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText(/Refund/i).first()).toBeVisible();
  await page.goto('/inbox');
  await expect(page.getByText(/Booking cancelled|Refund/).first()).toBeVisible();
});
