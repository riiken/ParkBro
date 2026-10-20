import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../apps/api/src/modules/identity/domain/totp.ts';
import { ADMIN_PORT, E2E_OTP_CODE, apiEnv } from '../playwright.config.ts';

const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
const grantCli = path.resolve(import.meta.dirname, '../../apps/api/src/cli/grant-admin.ts');

test('a granted platform admin signs in with OTP + authenticator code and signs out', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const phone = `8${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;

  // Register the person as an ordinary user first (admins are granted, never self-created).
  const challenge = await request.post('/api/v1/auth/otp/request', {
    data: { phone },
    headers: { 'x-requested-with': 'fetch' },
  });
  const verify = await request.post('/api/v1/auth/otp/verify', {
    data: { challengeId: (await challenge.json()).challengeId, code: E2E_OTP_CODE },
    headers: { 'x-requested-with': 'fetch' },
  });
  const register = await request.post('/api/v1/auth/register', {
    data: {
      ticket: (await verify.json()).ticket,
      displayName: 'Ops Lead',
      ageAttested: true,
      acceptedNoticeVersion: 'pilot-2026-10',
    },
    headers: { 'x-requested-with': 'fetch' },
  });
  expect(register.status()).toBe(201);

  // Grant through the real CLI and read the one-time TOTP enrolment URI.
  const output = execFileSync('node', [grantCli, phone, 'SUPPORT,TRUST_SAFETY'], {
    env: { ...process.env, ...apiEnv },
    encoding: 'utf8',
  });
  const uri = /otpauth:\/\/\S+/.exec(output)?.[0] ?? '';
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  expect(secret).not.toBe('');

  // A customer session must not open the admin console.
  await page.goto(`${ADMIN}/`);
  await expect(page).toHaveURL(`${ADMIN}/sign-in`);
  const csp = (await page.request.get(`${ADMIN}/sign-in`)).headers();
  expect(csp['content-security-policy']).toMatch(/'nonce-/);
  expect(csp['x-robots-tag']).toBe('noindex, nofollow');

  // The per-number resend window (30 s) is shared with the customer sign-up above: wait it out like a user would.
  await page.getByLabel('Mobile number').fill(phone);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'Continue' }).click();
    const outcome = await Promise.race([
      page
        .getByLabel('6-digit code')
        .waitFor()
        .then(() => 'sent' as const),
      page
        .locator('form [role="alert"]')
        .filter({ hasText: 'Too many requests' })
        .waitFor()
        .then(() => 'limited' as const),
    ]);
    if (outcome === 'sent') break;
    const seconds = Number(
      /wait (\d+) second/.exec((await page.locator('form [role="alert"]').textContent()) ?? '')?.[1] ?? 30,
    );
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Authenticator code' })).toBeVisible();

  await page.getByLabel('Code from your authenticator app').fill('000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('form [role="alert"]')).toContainText('authenticator code is incorrect');

  const code = hotp(base32Decode(secret), totpStep(Math.floor(Date.now() / 1000)));
  await page.getByLabel('Code from your authenticator app').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Signed in as Ops Lead')).toBeVisible();
  // The console: queues and an entity list with search (permissions are enforced by the API per call).
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await page.getByLabel('Exact phone or name').fill('Ops Lead');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('link', { name: 'Ops Lead' }).first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Analytics' }).click();
  await expect(page.getByRole('heading', { name: 'Liquidity', exact: true })).toBeVisible();
  await expect(page.getByText('Zero-result searches').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('navigation', { name: 'Admin' })).toContainText('SUPPORT, TRUST_SAFETY');

  // Locally web and admin share host 127.0.0.1 (cookies are per host, not port); in production they are separate
  // origins. Cookie-to-surface isolation itself is proven by the API integration tests.
  const adminCookie = (await page.context().cookies()).find((c) => c.name === '__Host-pb_admin');
  expect(adminCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${ADMIN}/sign-in`);
  await page.goto(`${ADMIN}/`);
  await expect(page).toHaveURL(`${ADMIN}/sign-in`);
});
