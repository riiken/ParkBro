import { expect, test } from '@playwright/test';
import {
  customerBooks,
  hostInBrowser,
  ist,
  istDate,
  nowWindow,
  seedListing,
  sql,
  suffix,
} from './audit-helpers.ts';
import { adminSession } from './helpers.ts';

/**
 * Functional audit: a host's day-to-day controls. Requests (approve on Today, decline on the booking), host
 * cancellation with a reason, a customer who can't get in (fixed on site), a no-show report, the payout account
 * (UPI then bank, with validation), guard links (create, check by plate and code, allow entry, access log,
 * revoke).
 */
test.describe.configure({ mode: 'serial' });

test('requests, cancellations, "can\'t get in", no-shows, payouts and guard links', async ({
  page,
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const S = suffix();
  const host = await hostInBrowser(page, playwright, baseURL ?? '', 'Audit Hostops');
  const admin = await adminSession(playwright, baseURL ?? '');
  const api = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const requestListing = await seedListing(
    host.api,
    admin,
    browser,
    {
      title: `Request-only bay ${S}`,
      latitude: 12.9116,
      longitude: 77.6474,
      areaLabel: 'HSR Layout',
      units: ['R1', 'R2', 'R3'],
      approvalRequired: true,
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 }],
    },
    host,
  );
  const instant = await seedListing(
    host.api,
    admin,
    browser,
    {
      title: `Instant bay ${S}`,
      latitude: 12.912,
      longitude: 77.648,
      areaLabel: 'HSR Layout',
      units: ['I1', 'I2', 'I3'],
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 }],
    },
    host,
  );

  // 1. Two requests: approve one on Today, decline the other on its booking page.
  const day = istDate(3);
  const r1 = await customerBooks(
    api,
    requestListing.id,
    { start: ist(day, '09:00'), end: ist(day, '11:00') },
    { name: 'Asha Rao' },
  );
  const r2 = await customerBooks(
    api,
    requestListing.id,
    { start: ist(day, '12:00'), end: ist(day, '14:00') },
    { name: 'Kiran Das' },
  );
  expect(r1.booking.status).toBe('AWAITING_HOST_APPROVAL');
  await page.goto('/host');
  await expect(
    page.getByRole('list', { name: 'At a glance' }).getByText('2', { exact: true }).first(),
  ).toBeVisible();
  const requests = page.getByRole('region', { name: 'Requests to respond to' });
  await requests
    .getByRole('listitem')
    .filter({ hasText: 'Asha R.' })
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(requests.getByText('Asha R.')).toHaveCount(0);
  const s1 = await (
    await api.get(`/api/v1/bookings/${r1.booking.id}`, { headers: r1.customer.headers })
  ).json();
  expect(s1.status).toBe('PENDING_PAYMENT');
  await page.goto(`/host/bookings/${r2.booking.id}`);
  await page.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText(/Declined/).first()).toBeVisible();

  // 2. Host cancels a paid booking with a reason: the customer is refunded in full and told why.
  const c = await customerBooks(
    api,
    instant.id,
    { start: ist(day, '15:00'), end: ist(day, '16:00') },
    { pay: true, name: 'Meena S' },
  );
  await page.goto(`/host/bookings/${c.booking.id}`);
  await page.getByRole('button', { name: 'Cancel this booking' }).click();
  await page.getByLabel('Reason (the customer sees it)').fill('Water tank repair in the driveway');
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  const cancelled = await (
    await api.get(`/api/v1/bookings/${c.booking.id}`, { headers: c.customer.headers })
  ).json();
  expect(cancelled).toMatchObject({
    status: 'CANCELLED',
    cancellation: { cancelledBy: 'HOST', reason: 'Water tank repair in the driveway' },
  });

  // 3. A customer who can't get in: shows on Today; the host marks it fixed on site.
  const w = nowWindow(2);
  const live = await customerBooks(
    api,
    instant.id,
    { start: ist(w.date, w.from), end: ist(w.date, w.to) },
    { pay: true, name: 'Vikram P' },
  );
  const issue = await api.post(`/api/v1/bookings/${live.booking.id}/issues`, {
    headers: live.customer.headers,
    data: { kind: 'ACCESS_DENIED', note: 'Guard says no booking' },
  });
  expect(issue.status(), await issue.text()).toBe(201);
  await page.goto('/host');
  const stuck = page.getByRole('region', { name: /can.t get in/ });
  await expect(stuck.getByText(/Vikram P\./)).toBeVisible();
  await stuck.getByRole('link', { name: /Vikram P\./ }).click();
  await page.getByRole('button', { name: 'Fixed on site' }).click();
  await expect(page.getByRole('button', { name: 'Fixed on site' })).toHaveCount(0);

  // 4. No-show: a booking that started 40 minutes ago with no check-in (test clock moved in the database).
  const ns = await customerBooks(
    api,
    instant.id,
    { start: ist(day, '17:00'), end: ist(day, '19:00') },
    { pay: true, name: 'Nisha T' },
  );
  // Move it to a space the live booking isn't using (the exclusion constraint rightly forbids overlaps).
  await sql(
    `UPDATE booking.bookings
        SET unit_id = (SELECT u.id FROM assets.asset_units u WHERE u.asset_id = $2
                         AND u.id <> (SELECT unit_id FROM booking.bookings WHERE id = $3) ORDER BY u.label DESC LIMIT 1),
            period = tstzrange(now() - interval '40 minutes', now() + interval '80 minutes', '[)')
      WHERE id = $1`,
    [ns.booking.id, instant.id, live.booking.id],
  );
  await page.goto(`/host/bookings/${ns.booking.id}`);
  await page.getByRole('button', { name: /Report no-show/ }).click();
  await expect(page.getByText(/No-show/).first()).toBeVisible();

  // 5. Payout account: UPI, then switch to a bank account (with validation).
  await page.goto('/host/earnings');
  const account = page.getByRole('form', { name: 'Payout account' });
  await account.getByRole('radio', { name: 'UPI' }).check();
  await account.getByLabel('Account holder name').fill('Audit Hostops');
  await account.getByLabel('UPI ID').fill('audit.host@okaxis');
  await account.getByRole('button', { name: 'Save payout account' }).click();
  await expect(page.getByText(/Being verified/)).toBeVisible();
  // Shown masked, never in full.
  await expect(page.getByText('UPI ••••host · Audit Hostops · Being verified')).toBeVisible();
  expect(await page.content()).not.toContain('audit.host@okaxis');
  await page.getByRole('button', { name: 'Change' }).click();
  await account.getByRole('radio', { name: 'Bank transfer' }).check();
  await account.getByLabel('Account holder name').fill('Audit Hostops');
  await account.getByLabel('Account number').fill('123456789012');
  await account.getByLabel('IFSC').fill('BAD');
  await account.getByRole('button', { name: 'Save payout account' }).click();
  await expect(
    account
      .getByRole('alert')
      .filter({ hasText: /IFSC|Invalid|check/i })
      .first(),
  ).toBeVisible();
  await account.getByLabel('IFSC').fill('HDFC0001234');
  await account.getByRole('button', { name: 'Save payout account' }).click();
  await expect(
    page.getByText(/Bank A\/c ••••9012 · HDFC0001234 · Audit Hostops · Being verified · payouts resume/),
  ).toBeVisible();

  // 6. Guard links: create, check by plate and by code, allow entry, access log, revoke.
  await page.goto('/host/gates');
  // Guard links are per property: pick the property where the live booking is.
  await page.getByLabel('Property').selectOption(instant.propertyId);
  const newLink = page.getByRole('form', { name: 'New guard link' });
  await newLink.getByLabel('Gate name').fill(`Gate ${S}`);
  await newLink.getByRole('button', { name: 'Create guard link' }).click();
  const link =
    (await page.getByRole('status').filter({ hasText: 'New link' }).locator('code').textContent()) ?? '';
  expect(link).toMatch(/\/gate\//);
  const guard = await page.context().browser()!.newPage();
  await guard.goto(link);
  await guard.getByLabel('Vehicle number or 6-digit code').fill(live.vehicle.plate);
  await guard.getByRole('button', { name: 'Check' }).click();
  await expect(guard.getByText('Valid now')).toBeVisible();
  await expect(guard.getByText(/I[123]/).first()).toBeVisible(); // the space
  await guard.getByRole('button', { name: 'Allow entry' }).click();
  await expect(guard.getByText('Entry recorded.')).toBeVisible();
  await guard.getByLabel('Vehicle number or 6-digit code').fill('000000');
  await guard.getByRole('button', { name: 'Check' }).click();
  await expect(guard.getByText(/Not valid/)).toBeVisible();
  await page.reload();
  await page.getByLabel('Property').selectOption(instant.propertyId);
  await expect(
    page
      .getByRole('region', { name: 'Access log' })
      .getByText(/entry|Entered|allowed/i)
      .first(),
  ).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: `Gate ${S}` })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: `Gate ${S}` })
      .getByText('Revoked'),
  ).toBeVisible();
  await guard.reload();
  await expect(guard.getByText(/no longer valid|not valid|revoked|expired/i).first()).toBeVisible();
  await guard.close();
  await Promise.all([api.dispose(), admin.api.dispose(), host.api.dispose()]);
});
