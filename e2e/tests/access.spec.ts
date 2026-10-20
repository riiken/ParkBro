import { expect, test } from '@playwright/test';
import { adminSession, samplePhoto, seedPublishedParkingWithHost, signUpInUi } from './helpers.ts';

const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pick = () => L[Math.floor(Math.random() * L.length)];

/** Next quarter hour ≥ 1 min away (IST): the booking's access window is open right away. */
function nowWindow() {
  const t = new Date(Date.now() + 60_000);
  const p = Object.fromEntries(
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
      .map((x) => [x.type, x.value]),
  );
  let m = Math.ceil((Number(p.hour) * 60 + Number(p.minute)) / 15) * 15;
  let date = `${p.year}-${p.month}-${p.day}`;
  if (m >= 1440) {
    m -= 1440;
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  const hhmm = (x: number) =>
    `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  return { date, from: hhmm(m), to: hhmm(m + 120) };
}

test('a driver gets a code, a guard verifies it at the gate, and a problem is fixed by the host', async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  test.setTimeout(200_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  const admin = await adminSession(playwright, baseURL ?? '');
  const hostApi = await playwright.request.newContext(baseURL ? { baseURL } : {});
  const title = `Gated plot ${Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
  const seeded = await seedPublishedParkingWithHost(hostApi, admin, {
    title,
    areaLabel: 'Koramangala',
    latitude: 12.9352,
    longitude: 77.6245,
    address: '21 Gatehouse Hidden Road',
    accessInstructions: 'Blue gate, ring once',
    photo: await samplePhoto(browser, 30),
  });

  // Driver books for now and pays (test checkout).
  await page.goto(`/listings/${seeded.listingId}`);
  await page.getByRole('link', { name: 'Sign in to book' }).click();
  await signUpInUi(page, 'Rohan Das');
  const plate = `KA 02 ${pick()}${pick()} ${1000 + Math.floor(Math.random() * 9000)}`;
  await page.getByLabel('Registration number').fill(plate);
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  const w = nowWindow();
  await page.getByLabel('Date').fill(w.date);
  await page.getByLabel('From').fill(w.from);
  await page.getByLabel('Until').fill(w.to);
  await page.getByRole('button', { name: 'Check price' }).click();
  await page.getByRole('button', { name: 'Reserve' }).click();
  await page.getByRole('button', { name: 'Pay ₹80' }).click();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();

  const getIn = page.getByRole('region', { name: 'Get in' });
  await expect(getIn).toContainText(plate);
  const code = (await getIn.locator('.pass-code').innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);

  // Host creates a guard link (API) and a guard uses it (separate browser, no account).
  const gate = await hostApi.post(`/api/v1/host/properties/${seeded.propertyId}/gates`, {
    headers: seeded.host.headers,
    data: { label: 'Front gate' },
  });
  expect(gate.ok(), await gate.text()).toBe(true);
  const guardContext = await browser.newContext();
  const guard = await guardContext.newPage();
  await guard.goto((await gate.json()).path);
  await expect(guard.getByRole('heading', { name: 'Front gate' })).toBeVisible();
  await guard.getByLabel('Vehicle number or 6-digit code').fill('999999');
  await guard.getByRole('button', { name: 'Check' }).click();
  await expect(guard.getByText('Not valid: no booking right now')).toBeVisible();
  await guard.getByLabel('Vehicle number or 6-digit code').fill(code);
  await guard.getByRole('button', { name: 'Check' }).click();
  await expect(guard.getByText('Valid now')).toBeVisible();
  await expect(guard.getByText(plate)).toBeVisible();
  expect(await guard.content()).not.toContain('Rohan');
  await guard.getByRole('button', { name: 'Allow entry' }).click();
  await expect(guard.getByText('Entry recorded.')).toBeVisible();

  await page.reload();
  await expect(page.getByText("You're parked", { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Get in' })).toContainText(/Entered at/);

  // A problem: someone else in the space. The host sees it and fixes it.
  await page.getByRole('button', { name: "I can't get in" }).click();
  await page.getByLabel("What's wrong?").selectOption('UNIT_OCCUPIED');
  await page.getByRole('button', { name: 'Report problem' }).click();
  await expect(
    page.getByText(/If it isn't fixed by then, you get a full refund automatically/),
  ).toBeVisible();
  const issues = await hostApi.get('/api/v1/host/bookings', { headers: seeded.host.headers });
  const withIssue = (await issues.json()).find(
    (b: { issue: { status: string } | null }) => b.issue?.status === 'OPEN',
  );
  expect(withIssue).toBeTruthy();
  const resolved = await hostApi.post(
    `/api/v1/host/bookings/${withIssue.id}/issues/${withIssue.issue.id}/resolve`,
    { headers: seeded.host.headers, data: { note: 'Moved the other car' } },
  );
  expect(resolved.ok(), await resolved.text()).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: "I can't get in" })).toBeVisible();

  // The inbox has the confirmation and payment (in-app channel of the notification outbox).
  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('button', { name: /Booking confirmed/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Payment received/ })).toContainText('₹80');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toHaveCount(0);

  // The access log has the checks.
  const log = await hostApi.get(`/api/v1/host/properties/${seeded.propertyId}/access-log`, {
    headers: seeded.host.headers,
  });
  const kinds = (await log.json()).map((e: { kind: string }) => e.kind);
  expect(kinds).toEqual(expect.arrayContaining(['ISSUED', 'DENIED', 'VERIFIED', 'ENTERED']));

  expect(problems).toEqual([]);
  await Promise.all([admin.api.dispose(), hostApi.dispose(), guardContext.close()]);
});
