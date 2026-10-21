import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seedListing, suffix } from './audit-helpers.ts';
import { adminSession } from './helpers.ts';

/**
 * Functional audit: search (every filter, dropdown, sort and toggle must change the results correctly).
 * Five listings near Yelahanka with deliberately different features; assertions are on titles, so leftovers from
 * earlier runs never matter.
 */
const Y = { latitude: 13.1007, longitude: 77.5963 };
const near = (dLat: number, dLng: number) => ({ latitude: Y.latitude + dLat, longitude: Y.longitude + dLng });

test.describe.configure({ mode: 'serial' });

const S = suffix();
const T = {
  covered: `Covered CCTV ${S}`,
  open: `Open guarded ${S}`,
  overnight: `Overnight bay ${S}`,
  dc: `Fast DC charger ${S}`,
  ac: `Home AC charger ${S}`,
};

let coveredId = '';
let coveredHost: { api: APIRequestContext; headers: Record<string, string> } | null = null;

test.beforeAll(async ({ playwright, browser, baseURL }) => {
  test.setTimeout(180_000);
  const admin = await adminSession(playwright, baseURL ?? '');
  const api = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const covered = await seedListing(api, admin, browser, {
    title: T.covered,
    ...near(0.002, 0.001),
    parking: { covered: true, security: ['CCTV'], maxVehicleClass: 'SUV' },
    rates: [
      { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
      { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 30000 },
    ],
  });
  coveredId = covered.id;
  coveredHost = { api, headers: covered.host.headers };
  await seedListing(api, admin, browser, {
    title: T.open,
    ...near(-0.003, 0.002),
    parking: {
      covered: false,
      security: ['GUARD', 'GATED'],
      evReadySocket: true,
      maxVehicleClass: 'HATCHBACK',
    },
    rates: [
      { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 2500 },
      { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 250000 },
    ],
  });
  await seedListing(api, admin, browser, {
    title: T.overnight,
    ...near(0.004, -0.003),
    parking: { covered: true, maxVehicleClass: 'SEDAN' },
    rates: [
      {
        mode: 'OVERNIGHT',
        unit: 'PER_NIGHT',
        pricePaise: 15000,
        overnightStart: '20:00',
        overnightEnd: '08:00',
      },
    ],
  });
  await seedListing(api, admin, browser, {
    title: T.dc,
    type: 'EV_CHARGING',
    ...near(0.001, -0.002),
    charger: { connectors: ['CCS2'], currentType: 'DC', powerKw: 50 },
    rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 30000 }],
  });
  await seedListing(api, admin, browser, {
    title: T.ac,
    type: 'EV_CHARGING',
    ...near(-0.002, -0.001),
    charger: { connectors: ['TYPE2'], currentType: 'AC', powerKw: 7.4 },
    rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 12000 }],
  });
  await admin.api.dispose();
});

async function openSearch(page: Page) {
  await page.goto('/search');
  await page.getByLabel('Where?').fill('Yelahanka');
  await page.getByRole('button', { name: /Yelahanka/ }).click();
  await expect(page.getByLabel('Where?')).toHaveValue('Yelahanka');
}

/** Runs the search and returns the titles of our audit listings, in result order. */
async function results(page: Page): Promise<string[]> {
  const done = page.waitForResponse((r) => r.url().includes('/api/v1/listings/search'));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await done;
  await page.waitForTimeout(150);
  const titles = await page.locator('.cards .card h3').allTextContents();
  return titles.filter((t) => t.endsWith(S));
}

async function filters(page: Page) {
  const panel = page.locator('details.filters');
  if (!(await panel.getAttribute('open'))) await panel.locator('summary').click();
}

test('parking: type, every checkbox, vehicle size, booking type, max price and sort', async ({ page }) => {
  await openSearch(page);
  expect((await results(page)).sort()).toEqual([T.covered, T.open, T.overnight].sort());

  await filters(page);
  const check = async (label: string, expected: string[]) => {
    await page.getByLabel(label, { exact: true }).check();
    expect((await results(page)).sort(), `${label} on`).toEqual(expected.sort());
    await page.getByLabel(label, { exact: true }).uncheck();
  };
  await check('Covered', [T.covered, T.overnight]);
  await check('CCTV', [T.covered]);
  await check('Guard', [T.open]);
  await check('Gated', [T.open]);
  await check('EV-ready socket', [T.open]);
  // Two filters together narrow further.
  await page.getByLabel('Covered', { exact: true }).check();
  await page.getByLabel('CCTV', { exact: true }).check();
  expect(await results(page)).toEqual([T.covered]);
  await page.getByLabel('Covered', { exact: true }).uncheck();
  await page.getByLabel('CCTV', { exact: true }).uncheck();

  // Vehicle size: a space fits that size or smaller cars.
  await page.getByLabel('My vehicle').selectOption('SUV');
  expect(await results(page)).toEqual([T.covered]);
  await page.getByLabel('My vehicle').selectOption('SEDAN');
  expect((await results(page)).sort()).toEqual([T.covered, T.overnight].sort());
  await page.getByLabel('My vehicle').selectOption('');

  // Booking type.
  await page.getByLabel('Booking type').selectOption('MONTHLY');
  expect(await results(page)).toEqual([T.open]);
  await page.getByLabel('Booking type').selectOption('OVERNIGHT');
  expect(await results(page)).toEqual([T.overnight]);
  await page.getByLabel('Booking type').selectOption('DAILY');
  expect(await results(page)).toEqual([T.covered]);
  await page.getByLabel('Booking type').selectOption('HOURLY');
  expect((await results(page)).sort()).toEqual([T.covered, T.open].sort());

  // Sort by price (hourly): ₹25 before ₹40. Nearest first is the default.
  await page.getByLabel('Sort by').selectOption('price');
  expect(await results(page)).toEqual([T.open, T.covered]);
  await page.getByLabel('Sort by').selectOption('distance');

  // Max price ₹30/hour: only the ₹25 space.
  await page.getByLabel(/Max price/).fill('30');
  expect(await results(page)).toEqual([T.open]);
  await page.getByLabel(/Max price/).fill('');
  expect((await results(page)).length).toBe(2);
});

test('EV: connector, AC/DC, minimum power; results never mix parking and charging', async ({ page }) => {
  await openSearch(page);
  await page.getByRole('radio', { name: 'EV charging' }).check();
  expect((await results(page)).sort()).toEqual([T.dc, T.ac].sort());
  await filters(page);
  await page.getByLabel('Connector').selectOption('CCS2');
  expect(await results(page)).toEqual([T.dc]);
  await page.getByLabel('Connector').selectOption('TYPE2');
  expect(await results(page)).toEqual([T.ac]);
  await page.getByLabel('Connector').selectOption('');
  await page.getByLabel('Charging', { exact: true }).selectOption('DC');
  expect(await results(page)).toEqual([T.dc]);
  await page.getByLabel('Charging', { exact: true }).selectOption('AC');
  expect(await results(page)).toEqual([T.ac]);
  await page.getByLabel('Charging', { exact: true }).selectOption('');
  await page.getByLabel('Minimum power (kW)').fill('20');
  expect(await results(page)).toEqual([T.dc]);
  await page.getByLabel('Minimum power (kW)').fill('');
  // Max price per session hour: ₹150 keeps only the ₹120 charger.
  await page.getByLabel(/Max price/).fill('150');
  expect(await results(page)).toEqual([T.ac]);
});

test('a date and time window checks real availability, and the window carries to the listing', async ({
  page,
}) => {
  await openSearch(page);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Date (optional)').fill(day);
  await page.getByLabel('From').fill('10:00');
  await page.getByLabel('Until').fill('12:00');
  await page.getByLabel('Booking type').selectOption('HOURLY');
  expect((await results(page)).sort()).toEqual([T.covered, T.open].sort());
  // The host blocks the covered space 09:00–13:00 that day: the same search must now leave it out.
  if (!coveredHost) throw new Error('seed missing');
  const blocked = await coveredHost.api.post(`/api/v1/host/assets/${coveredId}/availability-exceptions`, {
    headers: coveredHost.headers,
    data: {
      kind: 'BLOCK',
      start: new Date(`${day}T09:00:00+05:30`).toISOString(),
      end: new Date(`${day}T13:00:00+05:30`).toISOString(),
    },
  });
  expect(blocked.status(), await blocked.text()).toBe(201);
  expect(await results(page)).toEqual([T.open]);
  // Outside the block (14:00–16:00) it is available again.
  await page.getByLabel('From').fill('14:00');
  await page.getByLabel('Until').fill('16:00');
  expect((await results(page)).sort()).toEqual([T.covered, T.open].sort());
  await page
    .getByRole('link', { name: new RegExp(T.covered) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`date=${day}.*from=14%3A00.*to=16%3A00`));
  await expect(page.getByRole('heading', { name: T.covered })).toBeVisible();
});

test('describe-what-you-need fills the form; use my location; empty results offer a wider search', async ({
  page,
  context,
}) => {
  await page.goto('/search');
  await page.getByLabel('Describe what you need').fill('covered parking near Yelahanka');
  await page.getByRole('button', { name: 'Fill in the search' }).click();
  await expect(page.locator('.understood').getByText('Covered', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Where?')).toHaveValue('Yelahanka');
  await expect
    .poll(async () =>
      (await page.locator('.cards .card h3').allTextContents()).filter((t) => t.endsWith(S)).sort(),
    )
    .toEqual([T.covered, T.overnight].sort());
  await page.getByRole('button', { name: 'No' }).click();
  await expect(page.getByText('Thanks for the feedback.')).toBeVisible();

  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(Y);
  await page.goto('/search');
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByLabel('Where?')).toHaveValue('Your location');
  expect((await results(page)).sort()).toEqual([T.covered, T.open, T.overnight].sort());

  // Somewhere with nothing nearby, then the wider search button.
  await context.setGeolocation({ latitude: 12.75, longitude: 77.35 });
  await page.goto('/search');
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByLabel('Where?')).toHaveValue('Your location');
  await results(page);
  await expect(page.getByRole('heading', { name: /No spots found/ })).toBeVisible();
  const wider = page.waitForResponse((r) => r.url().includes('radiusM=10000'));
  await page.getByRole('button', { name: 'Search within 10 km' }).click();
  await wider;
});
