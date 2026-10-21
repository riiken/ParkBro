import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { E2E_OTP_CODE } from '../playwright.config.ts';
import { registerUser, samplePhoto, uniquePhone, type Session } from './helpers.ts';

/**
 * Helpers for the functional audit suites (audit-*.spec.ts): listings with precise features so each filter and
 * control can be proven to include or exclude the right things. Everything goes through the real API.
 */
export interface ListingSpec {
  title: string;
  type?: 'PARKING' | 'EV_CHARGING';
  latitude: number;
  longitude: number;
  areaLabel?: string;
  parking?: {
    covered?: boolean;
    level?: string;
    maxVehicleClass?: string;
    security?: string[];
    lighting?: boolean;
    evReadySocket?: boolean;
    tandem?: boolean;
  };
  charger?: { connectors: string[]; currentType: 'AC' | 'DC'; powerKw: number };
  rates: { mode: string; unit: string; pricePaise: number; overnightStart?: string; overnightEnd?: string }[];
  units?: string[];
  approvalRequired?: boolean;
  hue?: number;
}

export async function seedListing(
  hostApi: APIRequestContext,
  admin: Session,
  browser: Browser,
  spec: ListingSpec,
  host?: Session & { phone: string },
) {
  const owner = host ?? (await registerUser(hostApi, 'Audit Host'));
  const h = owner.headers;
  const ok = async (
    p: Promise<{ ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }>,
    step: string,
  ) => {
    const res = await p;
    if (!res.ok()) throw new Error(`${step}: ${res.status()} ${await res.text()}`);
    return res;
  };
  const post = (url: string, data?: unknown, extra: Record<string, string> = {}) =>
    hostApi.post(url, { headers: { ...h, ...extra }, ...(data === undefined ? {} : { data }) });
  const put = (url: string, data: unknown) => hostApi.put(url, { headers: h, data });

  if (!host) await ok(post('/api/v1/host/account', { displayName: 'Audit Host' }), 'host account');
  const property = (await (
    await ok(
      post('/api/v1/host/properties', {
        kind: 'INDEPENDENT_HOUSE',
        address: `${Math.floor(Math.random() * 900) + 10}, Audit Road, Bengaluru`,
        latitude: spec.latitude,
        longitude: spec.longitude,
        areaLabel: spec.areaLabel ?? 'Yelahanka',
      }),
      'property',
    )
  ).json()) as { id: string };
  const type = spec.type ?? 'PARKING';
  const asset = (await (
    await ok(
      post('/api/v1/host/assets', {
        propertyId: property.id,
        type,
        title: spec.title,
        description: 'Audit listing.',
        accessInstructions: 'Ring the bell at the gate.',
      }),
      'asset',
    )
  ).json()) as { id: string; version: number };
  const base = `/api/v1/host/assets/${asset.id}`;
  if (spec.approvalRequired) {
    await ok(
      hostApi.patch(base, { headers: h, data: { version: asset.version, approvalRequired: true } }),
      'approval setting',
    );
  }
  await ok(
    put(`${base}/parking-details`, {
      covered: true,
      level: 'GROUND',
      maxVehicleClass: 'SEDAN',
      ...spec.parking,
    }),
    'parking details',
  );
  if (type === 'EV_CHARGING') {
    await ok(
      put(`${base}/charger-details`, {
        cableProvided: true,
        connectionType: 'EV_METERED',
        ...(spec.charger ?? { connectors: ['TYPE2'], currentType: 'AC', powerKw: 7.4 }),
      }),
      'charger details',
    );
    await ok(post(`${base}/attestations`, { kind: 'CHARGER_SAFETY', accepted: true }), 'charger attestation');
  }
  if (spec.units) await ok(put(`${base}/units`, { labels: spec.units }), 'units');
  await ok(
    put(`${base}/rates`, {
      rates: spec.rates.map((r) => ({ overnightStart: null, overnightEnd: null, ...r })),
    }),
    'rates',
  );
  await ok(
    put(`${base}/availability-rules`, {
      rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '00:00' }],
    }),
    'rules',
  );
  await ok(post(`${base}/attestations`, { kind: 'RIGHT_TO_RENT', accepted: true }), 'attest');
  const hue = spec.hue ?? Math.floor(Math.random() * 360);
  await ok(
    post(`${base}/media?kind=SLOT`, await samplePhoto(browser, hue), { 'content-type': 'image/png' }),
    'photo',
  );
  if (type === 'EV_CHARGING') {
    await ok(
      post(`${base}/media?kind=CHARGER`, await samplePhoto(browser, (hue + 97) % 360), {
        'content-type': 'image/png',
      }),
      'charger photo',
    );
  }
  await ok(post(`${base}/submit`), 'submit');
  await ok(
    admin.api.post(`/api/admin/assets/${asset.id}/approve`, { data: {}, headers: admin.headers }),
    'approve',
  );
  return { id: asset.id, propertyId: property.id, host: owner };
}

/** Signs in (or up) in the browser with a fresh number and returns it. */
export async function signInUi(page: Page, name = 'Audit Driver'): Promise<string> {
  await page.goto('/sign-in');
  const phone = uniquePhone();
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(E2E_OTP_CODE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('I am 18 or older').check();
  await page.getByLabel(/I agree to the/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  return phone;
}

export const suffix = () =>
  Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');

const IST_PARTS = (t: Date) =>
  Object.fromEntries(
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

/** A 2-hour window starting at the next quarter hour (IST), as the booking form wants it. */
export function nowWindow(hours = 2) {
  const p = IST_PARTS(new Date(Date.now() + 60_000));
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
  return { date, from: hhmm(m), to: hhmm(m + hours * 60) };
}

/** A date N days ahead in IST (YYYY-MM-DD). */
export const istDate = (daysAhead: number) => {
  const p = IST_PARTS(new Date(Date.now() + daysAhead * 86_400_000));
  return `${p.year}-${p.month}-${p.day}`;
};

const PL = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const pl = () => PL[Math.floor(Math.random() * PL.length)];
/** Unique plate: a plate can be active on only one account. */
export const uniquePlate = () =>
  `KA 0${1 + Math.floor(Math.random() * 9)} ${pl()}${pl()} ${1000 + Math.floor(Math.random() * 9000)}`;
