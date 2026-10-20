import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { base32Decode, hotp, totpStep } from '../../apps/api/src/modules/identity/domain/totp.ts';
import { E2E_OTP_CODE, apiEnv } from '../playwright.config.ts';

const H = { 'x-requested-with': 'fetch' };
const grantCli = path.resolve(import.meta.dirname, '../../apps/api/src/cli/grant-admin.ts');

export function uniquePhone(prefix = '9'): string {
  return `${prefix}${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
}

async function expectOk<R extends { ok(): boolean; status(): number; text(): Promise<string> }>(
  res: R,
  step: string,
): Promise<R> {
  if (!res.ok()) throw new Error(`${step} failed: ${res.status()} ${await res.text()}`);
  return res;
}

/**
 * A signed-in API session. Playwright's API client (unlike a Chrome tab) won't send `Secure` cookies over
 * http://127.0.0.1, so the session cookie is carried explicitly. Staging and production are HTTPS.
 */
export interface Session {
  api: APIRequestContext;
  headers: Record<string, string>;
}

function sessionCookie(res: { headersArray(): { name: string; value: string }[] }, name: string): string {
  const header = res
    .headersArray()
    .find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie`);
  return header.value.split(';')[0] ?? '';
}

/** Registers a user through the API and returns a session carrying the user cookie. */
export async function registerUser(
  api: APIRequestContext,
  name: string,
  phone = uniquePhone(),
): Promise<Session & { phone: string }> {
  const ch = await expectOk(
    await api.post('/api/v1/auth/otp/request', { data: { phone }, headers: H }),
    'otp request',
  );
  const verify = await expectOk(
    await api.post('/api/v1/auth/otp/verify', {
      data: { challengeId: (await ch.json()).challengeId, code: E2E_OTP_CODE },
      headers: H,
    }),
    'otp verify',
  );
  const reg = await expectOk(
    await api.post('/api/v1/auth/register', {
      data: {
        ticket: (await verify.json()).ticket,
        displayName: name,
        ageAttested: true,
        acceptedNoticeVersion: 'pilot-2026-10',
      },
      headers: H,
    }),
    'register',
  );
  return { api, phone, headers: { ...H, cookie: sessionCookie(reg, '__Host-pb_session') } };
}

/** An admin session with TRUST_SAFETY (granted through the real CLI, signed in with OTP + TOTP). */
export async function adminSession(
  playwright: { request: { newContext(o: object): Promise<APIRequestContext> } },
  baseURL: string,
): Promise<Session> {
  const api = await playwright.request.newContext({ baseURL });
  const { phone } = await registerUser(api, 'Review Admin', uniquePhone('7'));
  const out = execFileSync('node', [grantCli, phone, 'TRUST_SAFETY'], {
    env: { ...process.env, ...apiEnv },
    encoding: 'utf8',
  });
  const secret = new URL(/otpauth:\/\/\S+/.exec(out)?.[0] ?? '').searchParams.get('secret') ?? '';
  // The per-number resend window (30 s) is shared with sign-up. Honour Retry-After: blocked attempts still count
  // towards the hourly limit, so polling would lock the number out (as it would for a real user).
  let challenge: { challengeId: string } | undefined;
  for (let attempt = 0; attempt < 3 && !challenge; attempt++) {
    const res = await api.post('/api/admin/auth/otp/request', { data: { phone }, headers: H });
    if (res.ok()) challenge = await res.json();
    else if (res.status() === 429)
      await new Promise((r) => setTimeout(r, (Number(res.headers()['retry-after'] ?? 30) + 1) * 1000));
    else throw new Error(`admin otp request failed: ${res.status()} ${await res.text()}`);
  }
  const verify = await expectOk(
    await api.post('/api/admin/auth/otp/verify', {
      data: { challengeId: challenge?.challengeId, code: E2E_OTP_CODE },
      headers: H,
    }),
    'admin otp',
  );
  const totp = await expectOk(
    await api.post('/api/admin/auth/totp', {
      data: {
        ticket: (await verify.json()).ticket,
        code: hotp(base32Decode(secret), totpStep(Math.floor(Date.now() / 1000))),
      },
      headers: H,
    }),
    'admin totp',
  );
  return { api, headers: { ...H, cookie: sessionCookie(totp, '__Host-pb_admin') } };
}

/** A realistic-looking listing photo, rendered by the browser (no image library needed in e2e). */
export async function samplePhoto(browser: Browser, hue: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(
    `<body style="margin:0;height:600px;background:linear-gradient(135deg,hsl(${hue},60%,45%),hsl(${(hue + 80) % 360},50%,25%))"></body>`,
  );
  const png = await page.screenshot();
  await page.close();
  return png;
}

export interface SeedOptions {
  title: string;
  areaLabel: string;
  latitude: number;
  longitude: number;
  address: string;
  accessInstructions: string;
  photo: Buffer;
}

/** Publishes a parking listing end to end through the real API (host + admin review). */
export async function seedPublishedParking(hostApi: APIRequestContext, admin: Session, o: SeedOptions) {
  return (await seedPublishedParkingWithHost(hostApi, admin, o)).listingId;
}

/** Same, also returning the host session and property (for host-side API steps in tests). */
export async function seedPublishedParkingWithHost(
  hostApi: APIRequestContext,
  admin: Session,
  o: SeedOptions,
) {
  const host = await registerUser(hostApi, 'Meera Iyer');
  const h = host.headers;
  const post = (url: string, data?: unknown, extra: Record<string, string> = {}) =>
    hostApi.post(url, { headers: { ...h, ...extra }, ...(data === undefined ? {} : { data }) });
  const put = (url: string, data: unknown) => hostApi.put(url, { headers: h, data });

  await expectOk(await post('/api/v1/host/account', { displayName: 'Meera Iyer' }), 'become host');
  const property = await (
    await expectOk(
      await post('/api/v1/host/properties', {
        kind: 'INDEPENDENT_HOUSE',
        address: o.address,
        latitude: o.latitude,
        longitude: o.longitude,
        areaLabel: o.areaLabel,
      }),
      'property',
    )
  ).json();
  const asset = await (
    await expectOk(
      await post('/api/v1/host/assets', {
        propertyId: property.id,
        type: 'PARKING',
        title: o.title,
        description: 'Gated, well-lit driveway.',
        accessInstructions: o.accessInstructions,
      }),
      'asset',
    )
  ).json();
  const base = `/api/v1/host/assets/${asset.id}`;
  await expectOk(
    await put(`${base}/parking-details`, {
      covered: true,
      level: 'GROUND',
      maxVehicleClass: 'SUV',
      security: ['GATED', 'CCTV'],
      lighting: true,
    }),
    'details',
  );
  await expectOk(
    await put(`${base}/rates`, {
      rates: [
        { mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: 4000 },
        { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
      ],
    }),
    'rates',
  );
  await expectOk(
    await put(`${base}/availability-rules`, {
      rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '00:00' }],
    }),
    'rules',
  );
  await expectOk(await post(`${base}/attestations`, { kind: 'RIGHT_TO_RENT', accepted: true }), 'attest');
  await expectOk(await post(`${base}/media?kind=SLOT`, o.photo, { 'content-type': 'image/png' }), 'photo');
  await expectOk(await post(`${base}/submit`), 'submit');
  await expectOk(
    await admin.api.post(`/api/admin/assets/${asset.id}/approve`, { data: {}, headers: admin.headers }),
    'approve',
  );
  return { listingId: asset.id as string, propertyId: property.id as string, host };
}

/** Signs up a new user through the UI on the current page's sign-in screen (the app sets the Secure cookie). */
export async function signUpInUi(page: Page, name: string): Promise<string> {
  const phone = uniquePhone();
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  return phone;
}
