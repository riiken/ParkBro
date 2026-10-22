import { expect, test, type Page } from '@playwright/test';
import { ADMIN_PORT } from '../playwright.config.ts';
import { adminInBrowser, customerBooks, ist, istDate, seedListing, sql, suffix } from './audit-helpers.ts';
import { adminSession, registerUser } from './helpers.ts';

/**
 * Functional audit: the admin console. Every page loads, and every action that needs a reason works end to end:
 * users (suspend, reinstate, pilot clearance), hosts (status), societies (create, participation, member hosts),
 * listings (approve, reject, suspend, reinstate), bookings (platform cancel + refund), payouts (verify account),
 * reviews (remove), disputes (review, ask, resolve with a partial refund), data requests, audit, analytics.
 */
test.describe.configure({ mode: 'serial' });
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;

async function reason(
  page: Page,
  label: string,
  text = 'Checked during the functional audit',
  scope = page.locator('body'),
) {
  await scope.getByRole('button', { name: label, exact: true }).first().click();
  const form = page.getByRole('form', { name: label });
  await form.getByLabel('Reason').fill(text);
  await form.getByRole('button', { name: `Confirm: ${label}` }).click();
  await expect(form).toHaveCount(0);
}

test('every admin page and reasoned action works', async ({ page, playwright, browser, baseURL }) => {
  test.setTimeout(400_000);
  const S = suffix();
  const admin = await adminSession(playwright, baseURL ?? '', 'SUPER_ADMIN');
  const adminApi = await playwright.request.newContext(baseURL ? { baseURL } : {});
  await adminInBrowser(page, adminApi, ADMIN);

  // Data to act on.
  const api = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const host = await registerUser(api, `Admin Audit Host ${S}`);
  await api.post('/api/v1/host/account', { headers: host.headers, data: { displayName: `AuditHost${S}` } });
  const live = await seedListing(
    api,
    admin,
    browser,
    {
      title: `Admin live bay ${S}`,
      latitude: 12.9719,
      longitude: 77.6412,
      areaLabel: 'Indiranagar',
      units: ['A1', 'A2'],
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 5000 }],
    },
    host,
  );
  const queued = await seedListing(
    api,
    admin,
    browser,
    {
      title: `Admin queued bay ${S}`,
      latitude: 12.972,
      longitude: 77.642,
      areaLabel: 'Indiranagar',
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 5000 }],
      approve: false,
    },
    host,
  );
  const rejected = await seedListing(
    api,
    admin,
    browser,
    {
      title: `Admin reject bay ${S}`,
      latitude: 12.9721,
      longitude: 77.6421,
      areaLabel: 'Indiranagar',
      rates: [{ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 5000 }],
      approve: false,
    },
    host,
  );
  const day = istDate(3);
  const paid = await customerBooks(
    api,
    live.id,
    { start: ist(day, '10:00'), end: ist(day, '12:00') },
    { pay: true, name: `Priya ${S}` },
  );
  const done = await customerBooks(
    api,
    live.id,
    { start: ist(day, '13:00'), end: ist(day, '14:00') },
    { pay: true, name: `Rohan ${S}` },
  );
  await sql(
    `UPDATE booking.bookings SET status = 'COMPLETED', period = tstzrange(now() - interval '3 hours', now() - interval '2 hours', '[)') WHERE id = $1`,
    [done.booking.id],
  );
  const rv = await api.post(`/api/v1/bookings/${done.booking.id}/review`, {
    headers: done.customer.headers,
    data: { rating: 1, body: `Rude host ${S}` },
  });
  expect(rv.ok(), await rv.text()).toBe(true);
  await api.post(`/api/v1/bookings/${done.booking.id}/review`, {
    headers: host.headers,
    data: { rating: 5 },
  });
  const dispute = await api.post(`/api/v1/bookings/${done.booking.id}/disputes`, {
    headers: done.customer.headers,
    data: {
      category: 'INCORRECT_LISTING',
      description: `The bay was smaller than shown ${S}`,
      requestedOutcome: 'PARTIAL_REFUND',
    },
  });
  expect(dispute.ok(), await dispute.text()).toBe(true);
  const disputeId = (await dispute.json()).id as string;
  await api.put('/api/v1/host/payout-account', {
    headers: host.headers,
    data: { method: 'UPI', holderName: 'Audit Host', vpa: `audit${S}@okhdfc` },
  });
  await api.post('/api/v1/me/data-requests', { headers: paid.customer.headers, data: { kind: 'ACCESS' } });

  // Dashboard and search.
  await page.goto(`${ADMIN}/`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
  await page.getByLabel('Search users, hosts, listings, bookings').fill(`Admin live bay ${S}`);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('link', { name: new RegExp(`Admin live bay ${S}`) }).first()).toBeVisible();

  // Listings: approve one from the queue, reject another with a reason; suspend + reinstate the live one.
  await page.goto(`${ADMIN}/listings/${queued.id}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/PUBLISHED|Live/).first()).toBeVisible();
  await page.goto(`${ADMIN}/listings/${rejected.id}`);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('form', { name: 'Reject' }).getByLabel('Reason').fill('Photo does not show the space');
  await page.getByRole('form', { name: 'Reject' }).getByRole('button', { name: 'Confirm: Reject' }).click();
  await expect(page.getByText(/DRAFT|Rejected|returned/i).first()).toBeVisible();
  await page.goto(`${ADMIN}/listings/${live.id}`);
  await reason(page, 'Suspend listing');
  expect((await api.get(`/api/v1/listings/${live.id}`)).status()).toBe(404);
  await reason(page, 'Reinstate');
  await expect(page.getByText(/PAUSED/).first()).toBeVisible(); // the host publishes it again
  const republish = await api.post(`/api/v1/host/assets/${live.id}/republish`, { headers: host.headers });
  expect(republish.ok(), await republish.text()).toBe(true);
  expect((await api.get(`/api/v1/listings/${live.id}`)).status()).toBe(200);

  // Hosts: account id shown; restrict hides listings; back to active.
  await page.goto(`${ADMIN}/hosts`);
  await page.getByLabel('Name').fill(`AuditHost${S}`);
  await page.getByRole('button', { name: 'Apply' }).click();
  const row = page.getByRole('row').filter({ hasText: `AuditHost${S}` });
  const hostAccountId = ((await row.locator('code').textContent()) ?? '').trim();
  expect(hostAccountId).toMatch(/^[0-9a-f-]{36}$/);
  await row.getByRole('button', { name: 'Set status' }).click();
  await row.getByLabel('New status').selectOption('RESTRICTED');
  await row.getByLabel('Reason').fill('Audit: temporary restriction');
  await row.getByRole('button', { name: 'Confirm: Set status' }).click();
  await expect(async () =>
    expect((await api.get(`/api/v1/listings/${live.id}`)).status()).toBe(404),
  ).toPass();
  await page.reload();
  await page.getByLabel('Name').fill(`AuditHost${S}`);
  await page.getByRole('button', { name: 'Apply' }).click();
  await row.getByRole('button', { name: 'Set status' }).click();
  await row.getByLabel('New status').selectOption('ACTIVE');
  await row.getByLabel('Reason').fill('Audit: restriction lifted');
  await row.getByRole('button', { name: 'Confirm: Set status' }).click();
  await expect(async () =>
    expect((await api.get(`/api/v1/listings/${live.id}`)).status()).toBe(200),
  ).toPass();

  // Societies: create, see the address, set participation, add + remove a member host.
  await page.goto(`${ADMIN}/properties`);
  await page.getByRole('button', { name: 'New society' }).click();
  const form = page.getByRole('form', { name: 'New society' });
  await form.getByLabel(/Society name/).fill(`Prestige Audit ${S}`);
  await form.getByLabel('Full address (private)').fill(`Block C, Prestige Audit ${S}, Indiranagar`);
  await form.getByLabel('Find it (map search)').fill('Indira');
  await form
    .getByRole('button', { name: /Indiranagar/ })
    .first()
    .click();
  await expect(form.getByText('Location set.')).toBeVisible();
  await expect(form.getByLabel('Area (shown publicly)')).toHaveValue('Indiranagar');
  await form.getByLabel(/Max spaces for outsiders/).fill('4');
  await form.getByRole('button', { name: 'Create society' }).click();
  await expect(page.getByRole('heading', { name: `Prestige Audit ${S}` })).toBeVisible();
  await expect(page.getByText(`Block C, Prestige Audit ${S}, Indiranagar`)).toBeVisible();
  // Only valid next steps are offered: consent first, then participating.
  for (const [to, why] of [
    ['PENDING_CONSENT', 'Committee meeting scheduled'],
    ['PARTICIPATING', 'Committee consent letter received'],
  ] as const) {
    await page.getByRole('button', { name: 'Change participation' }).click();
    await page.getByLabel('New participation').selectOption(to);
    await page.getByRole('form', { name: 'Change participation' }).getByLabel('Reason').fill(why);
    await page.getByRole('button', { name: 'Confirm: Change participation' }).click();
    await expect(page.locator('p').filter({ hasText: 'Now:' })).toContainText(to);
  }
  await expect(page.locator('p').filter({ hasText: 'Now:' })).toContainText('PARTICIPATING');
  await expect(page.getByText('at most 4 outsider spaces at once')).toBeVisible();
  await page.getByLabel('Host account id (from Hosts)').fill(hostAccountId);
  await page.getByRole('button', { name: 'Add member host' }).click();
  await expect(page.getByText(`${hostAccountId} · ACTIVE`)).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: hostAccountId })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText(`${hostAccountId} · REVOKED`)).toBeVisible();

  // Bookings: filter, open, cancel for the platform (full refund).
  await page.goto(`${ADMIN}/bookings`);
  await page.getByLabel('Booking id (start)').fill(paid.booking.id);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator(`a[href="/bookings/${paid.booking.id}"]`).click();
  await reason(page, 'Cancel for the platform (full refund)', 'Audit: host reported the bay unusable');
  const after = await (
    await api.get(`/api/v1/bookings/${paid.booking.id}`, { headers: paid.customer.headers })
  ).json();
  expect(after).toMatchObject({ status: 'CANCELLED', cancellation: { cancelledBy: 'PLATFORM' } });

  // Payouts: verify the host's payout account.
  await page.goto(`${ADMIN}/payouts`);
  const pending = page.locator('p').filter({ hasText: `audit${S}@okhdfc` });
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Verified' }).click();
  await expect(pending).toHaveCount(0);

  // Reviews: remove the abusive review.
  await page.goto(`${ADMIN}/reviews`);
  const review = page.getByRole('row').filter({ hasText: `Rude host ${S}` });
  await review.getByRole('button', { name: 'Remove' }).click();
  await review.getByLabel('Reason').fill('Abusive, not about the space');
  await review.getByRole('button', { name: 'Confirm: Remove' }).click();
  await expect(review).toContainText('REMOVED');

  // Disputes: start review, ask for information, resolve with a partial refund.
  await page.goto(`${ADMIN}/disputes/${disputeId}`);
  await page.getByRole('button', { name: 'Start review (internal note)' }).click();
  await page.getByPlaceholder('Internal note').first().fill('Checking photos against the listing');
  await page.getByRole('button', { name: 'Confirm: Start review (internal note)' }).click();
  await page.getByRole('button', { name: 'Ask the parties for information' }).click();
  await page
    .getByPlaceholder('Message to both parties')
    .fill('Please share a photo of the bay with a car in it.');
  await page.getByRole('button', { name: 'Confirm: Ask the parties for information' }).click();
  await expect(page.getByText('Please share a photo of the bay with a car in it.')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.getByLabel('Outcome').selectOption('REFUND_PARTIAL');
  await page.getByLabel('Partial refund in rupees').fill('20');
  await page
    .getByPlaceholder('Decision note (shared with the parties)')
    .fill('Bay narrower than listed: partial refund.');
  await page.getByRole('button', { name: 'Confirm: Resolve' }).click();
  await expect(page.getByText(/RESOLVED/).first()).toBeVisible();

  // Data requests: mark done.
  await page.goto(`${ADMIN}/data-requests`);
  const dr = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: paid.customer.headers ? /.{8}/ : /x/ }) })
    .first();
  await dr.getByRole('button', { name: 'Mark done' }).click();
  await dr.getByLabel('Reason').fill('Export sent to the verified number');
  await dr.getByRole('button', { name: 'Confirm: Mark done' }).click();

  // Users: suspend (session ends), reinstate, pilot clearance.
  const userId = (await (await api.get('/api/v1/me', { headers: paid.customer.headers })).json())
    .id as string;
  await page.goto(`${ADMIN}/users/${userId}`);
  await reason(page, 'Suspend user', 'Audit: fraud report check');
  expect((await api.get('/api/v1/me', { headers: paid.customer.headers })).status()).toBe(401);
  await reason(page, 'Reinstate user', 'Audit: report unfounded');
  await page.getByRole('button', { name: 'Clear to book' }).click();
  await page
    .getByRole('form', { name: 'Clear to book' })
    .getByLabel('Reason')
    .fill('RC and ID seen on a call');
  await page.getByRole('button', { name: 'Confirm: Clear to book' }).click();
  await expect(page.getByText('Cleared to book.')).toBeVisible();

  // Audit log shows those actions; the other read-only pages load.
  await page.goto(`${ADMIN}/audit`);
  await page.getByLabel('Entity id').fill(userId);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('user.suspend').first()).toBeVisible();
  await expect(page.getByText('user.clearance_granted').first()).toBeVisible();
  for (const [path, heading] of [
    ['/analytics', 'Analytics'],
    ['/fraud', /Fraud/],
    ['/config', /Config/],
    ['/payments', 'Payments'],
    ['/users', 'Users'],
  ] as const) {
    await page.goto(`${ADMIN}${path}`);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  await page.goto(`${ADMIN}/analytics`);
  await page.getByLabel('Period').selectOption('7');
  await expect(page.getByRole('heading', { name: 'Liquidity', exact: true })).toBeVisible();
  await Promise.all([api.dispose(), admin.api.dispose(), adminApi.dispose()]);
});
