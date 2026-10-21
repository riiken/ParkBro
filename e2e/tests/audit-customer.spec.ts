import { expect, test } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';
import { ist, istDate, nowWindow, seedListing, signInUi, sql, suffix } from './audit-helpers.ts';
import { adminSession, registerUser, samplePhoto } from './helpers.ts';

/**
 * Functional audit: the rest of the customer side. Account settings (notification channels persist, signed-in
 * devices, data requests of every kind), inbox (open marks read, mark all read), reviews (rating + every
 * dimension + comment, blind until both sides review), disputes (every field, message, photo evidence), the EV
 * charger fault form, and a monthly plan's notice.
 */
test.describe.configure({ mode: 'serial' });

test('account: notification channels persist; other devices sign out; every data request kind', async ({
  page,
  browser,
}) => {
  const phone = await signInUi(page, 'Settings Tester');
  const prefs = page.getByRole('region', { name: 'Notifications' });
  await prefs.getByLabel('WhatsApp', { exact: true }).uncheck();
  await page.waitForTimeout(400);
  await prefs.getByLabel('SMS (used when WhatsApp is off)').uncheck();
  await page.waitForTimeout(400);
  await page.reload();
  await expect(prefs.getByLabel('WhatsApp', { exact: true })).not.toBeChecked();
  await expect(prefs.getByLabel('SMS (used when WhatsApp is off)')).not.toBeChecked();
  await prefs.getByLabel('WhatsApp', { exact: true }).check();
  await page.waitForTimeout(400);
  await page.reload();
  await expect(prefs.getByLabel('WhatsApp', { exact: true })).toBeChecked();

  // A second device signs in; the first device signs it out.
  // The same number asked for a code moments ago: skip the 30-second resend wait (test only).
  await sql(`DELETE FROM platform.rate_limit_counters WHERE key LIKE 'otp-send:phone30s:%'`);
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto('/sign-in');
  await second.getByLabel('Mobile number').fill(phone);
  await second.getByRole('button', { name: 'Send code' }).click();
  await second.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await second.getByRole('button', { name: 'Continue' }).click();
  await expect(second).toHaveURL(/\/account$/);
  await page.reload();
  const devices = page.getByRole('region', { name: 'Signed-in devices' });
  await expect(devices.getByRole('listitem')).toHaveCount(2);
  await devices.getByRole('button', { name: 'Sign out' }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  await second.goto('/account');
  await expect(second).toHaveURL(/\/sign-in/);
  await other.close();

  // Data requests: correction and erasure (access is in the auth journey).
  const data = page.getByRole('region', { name: 'Your data' });
  await data.getByRole('button', { name: 'Correct my data' }).click();
  await data.getByLabel(/anything we should know/).fill('My name is spelt wrong');
  await data.getByRole('button', { name: 'Send request' }).click();
  await expect(data.getByText(/Correct my data · we'll reply by/)).toBeVisible();
  await data.getByRole('button', { name: 'Delete my account and data' }).click();
  await expect(data.getByText(/Your account will be closed/)).toBeVisible();
  await data.getByRole('button', { name: 'Cancel' }).click();
  await expect(data.getByText(/Delete my account and data · we'll reply by/)).toHaveCount(0);
});

test('booking life: inbox, review with every dimension, dispute with message and photo, charger fault, plan notice', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const S = suffix();
  const admin = await adminSession(playwright, baseURL ?? '');
  const hostApi = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const host = await registerUser(hostApi, 'Lakshmi Host');
  await hostApi.post('/api/v1/host/account', { headers: host.headers, data: { displayName: 'Lakshmi' } });
  const spot = await seedListing(
    hostApi,
    admin,
    browser,
    {
      title: `Review bay ${S}`,
      latitude: 12.925,
      longitude: 77.5938,
      areaLabel: 'Jayanagar',
      units: ['J1', 'J2'],
      rates: [
        { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
        { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
      ],
    },
    host,
  );

  // The customer books and pays in the browser (so the browser has the session).
  await signInUi(page, 'Life Tester');
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await playwright.request.newContext({
    ...(baseURL ? { baseURL } : {}),
    extraHTTPHeaders: { cookie },
  });
  const meHeaders = { 'x-requested-with': 'fetch' };
  const vehicle = await (
    await me.post('/api/v1/me/vehicles', {
      headers: meHeaders,
      data: { plate: `KA 09 ZX ${1000 + Math.floor(Math.random() * 8999)}`, vehicleClass: 'HATCHBACK' },
    })
  ).json();
  const book = async (start: string, end: string, mode = 'HOURLY') => {
    const q = await (
      await me.post('/api/v1/quotes', { headers: meHeaders, data: { assetId: spot.id, mode, start, end } })
    ).json();
    const b = await me.post('/api/v1/bookings', {
      headers: { ...meHeaders, 'idempotency-key': crypto.randomUUID() },
      data: { quoteId: q.quoteId, vehicleId: vehicle.id },
    });
    expect(b.ok(), await b.text()).toBe(true);
    return (await b.json()) as { id: string };
  };
  const day = istDate(2);
  const done = await book(ist(day, '09:00'), ist(day, '10:00'));
  await page.goto(`/bookings/${done.id}`);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Inbox: unread messages; opening one marks it read; then mark all read.
  await page.goto('/inbox');
  const unread = page.locator('.unread');
  await expect(unread.first()).toBeVisible();
  const before = await unread.count();
  await page
    .getByRole('button', { name: /Booking confirmed/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/bookings/${done.id}`));
  await page.goto('/inbox');
  await expect(unread).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(unread).toHaveCount(0);

  // The booking happened (test clock): completed, so both sides can review.
  await sql(
    `UPDATE booking.bookings SET status = 'COMPLETED', period = tstzrange(now() - interval '3 hours', now() - interval '2 hours', '[)') WHERE id = $1`,
    [done.id],
  );
  await page.goto(`/bookings/${done.id}`);
  const review = page.getByRole('form', { name: 'Leave a review' });
  await review.getByLabel('How was the space?').selectOption('4');
  for (const sel of await review.locator('select[id^="dim-"]').all()) await sel.selectOption('5');
  await review.getByLabel('Comment (optional, public)').fill(`Easy entry, clean bay ${S}`);
  await review.getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByText(/You rated ★★★★☆/)).toBeVisible();
  // Blind: not public until the host reviews too.
  expect((await (await page.request.get(`/api/v1/listings/${spot.id}/reviews`)).text()).includes(S)).toBe(
    false,
  );
  const hostReview = await hostApi.post(`/api/v1/bookings/${done.id}/review`, {
    headers: host.headers,
    data: { rating: 5, body: 'Polite and on time' },
  });
  expect(hostReview.ok(), await hostReview.text()).toBe(true);
  await page.goto(`/listings/${spot.id}`);
  await expect(page.getByText(`Easy entry, clean bay ${S}`)).toBeVisible();

  // Dispute: every field, then a message and a photo.
  await page.goto(`/bookings/${done.id}`);
  await page.getByRole('button', { name: 'Report a problem with this booking' }).click();
  const dispute = page.getByRole('form', { name: 'Open a dispute' });
  await dispute.getByLabel('What happened?').selectOption('INCORRECT_LISTING');
  await dispute.getByLabel('Describe it').fill('The bay was much narrower than the photos showed.');
  await dispute.getByLabel('What would put it right?').selectOption('PARTIAL_REFUND');
  await dispute.getByRole('button', { name: 'Open dispute' }).click();
  await expect(page).toHaveURL(/\/disputes\/[0-9a-f-]{36}/);
  await page.getByLabel('Add a message').fill('Photo attached of the bay width.');
  await page.getByRole('form', { name: 'Add to the dispute' }).getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Photo attached of the bay width.')).toBeVisible();
  await page
    .getByLabel(/Add a photo/)
    .setInputFiles({ name: 'bay.png', mimeType: 'image/png', buffer: await samplePhoto(browser, 300) });
  await expect(page.locator('img[src*="/api/v1/dispute-evidence/"]').first()).toBeVisible();

  // Monthly plan: request, the host approves, the customer pays, then gives notice.
  const start = istDate(5);
  const end = new Date(`${start}T09:00:00+05:30`);
  end.setMonth(end.getMonth() + 1);
  const monthly = await book(ist(start, '09:00'), end.toISOString(), 'MONTHLY');
  const approve = await hostApi.post(`/api/v1/host/bookings/${monthly.id}/approve`, {
    headers: host.headers,
    data: {},
  });
  expect(approve.ok(), await approve.text()).toBe(true);
  await page.goto(`/bookings/${monthly.id}`);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'View plan' }).click();
  await page.getByRole('button', { name: 'Give notice' }).click();
  await page.getByRole('button', { name: 'Yes, give notice' }).click();
  await expect(page.getByText(/notice|Ends|ending/i).first()).toBeVisible();

  // EV: a charger booking for now, start charging, report a fault.
  const ev = await seedListing(
    hostApi,
    admin,
    browser,
    {
      title: `Fault charger ${S}`,
      type: 'EV_CHARGING',
      latitude: 12.926,
      longitude: 77.594,
      areaLabel: 'Jayanagar',
      charger: { connectors: ['TYPE2'], currentType: 'AC', powerKw: 7.4 },
      rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 12000 }],
    },
    host,
  );
  // The browser customer adds an EV (Type 2) and books a session for now.
  const evCar = await (
    await me.post('/api/v1/me/vehicles', {
      headers: meHeaders,
      data: {
        plate: `KA 08 EV ${1000 + Math.floor(Math.random() * 8999)}`,
        vehicleClass: 'SEDAN',
        isEv: true,
        connectors: ['TYPE2'],
      },
    })
  ).json();
  const nw = nowWindow(1);
  const q = await (
    await me.post('/api/v1/quotes', {
      headers: meHeaders,
      data: {
        assetId: ev.id,
        mode: 'CHARGING_SESSION',
        start: ist(nw.date, nw.from),
        end: ist(nw.date, nw.to),
      },
    })
  ).json();
  const evBooking = await (
    await me.post('/api/v1/bookings', {
      headers: { ...meHeaders, 'idempotency-key': crypto.randomUUID() },
      data: { quoteId: q.quoteId, vehicleId: evCar.id },
    })
  ).json();
  await page.goto(`/bookings/${evBooking.id}`);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Start charging' }).click();
  await expect(page.getByRole('button', { name: 'Stop charging' })).toBeVisible();
  await page.getByRole('button', { name: 'Charger not working?' }).click();
  const fault = page.getByRole('form', { name: 'Report a charger problem' });
  await fault.getByLabel("What's wrong?").selectOption({ index: 1 });
  const reason = (await fault.getByLabel("What's wrong?").locator('option:checked').textContent()) ?? '';
  await fault.getByLabel('Details (optional)').fill('Stops after a minute');
  await fault.getByRole('button', { name: 'Report problem' }).click();
  await expect(
    page.getByText(new RegExp(`Problem reported: ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
  ).toBeVisible();
  // A charger fault opens a "can't get in"-style recourse automatically (15-minute rule).
  await expect(page.getByText(/The charger isn.t working/).first()).toBeVisible();
  await Promise.all([me.dispose(), hostApi.dispose(), admin.api.dispose()]);
});
