import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../app.ts';
import { createModules } from '../composition.ts';
import { base32Decode, CURRENT_NOTICE_VERSION, hotp, totpStep } from '../modules/identity/index.ts';
import { databaseReadiness } from '../modules/system/index.ts';
import { loadEnv } from '../platform/config/env.ts';
import { MIGRATIONS_DIR } from '../platform/db/cli-paths.ts';
import { createDb, createPool } from '../platform/db/database.ts';
import { loadMigrations } from '../platform/db/migrator.ts';
import { memoryOtpSender } from '../platform/providers/otp.ts';

/**
 * Development seed: sample hosts, approved listings and a customer, created through the real API in-process (the
 * same validation, review and privacy rules as the UI). Refuses to run outside development. Idempotent: skips if the
 * sample host already exists. Usage: pnpm --filter @parkbro/api db:seed
 */
const env = loadEnv();
if (env.NODE_ENV !== 'development' && !env.STAGING) {
  console.error('db:seed runs only in development or staging (STAGING=true)');
  process.exit(2);
}

const ACCOUNTS = { host: '9000000001', host2: '9000000002', customer: '9000000003', admin: '9000000009' };
const CSRF = { 'x-requested-with': 'fetch' };

const pool = createPool(env);
const db = createDb(pool);
const otp = memoryOtpSender();
const modules = createModules(env, db, { otpSender: otp });
const app = await buildApp({
  env: { ...env, LOG_LEVEL: 'warn' },
  readiness: databaseReadiness(pool, await loadMigrations(MIGRATIONS_DIR)),
  modules,
});
await app.ready();

let ip = 1;
const send = async (
  method: 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload: unknown,
  cookie?: string,
  contentType?: string,
) => {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: {
      ...CSRF,
      ...(cookie ? { cookie } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    remoteAddress: `10.9.0.${(ip++ % 250) + 1}`,
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res;
};
const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} cookie`);
  return `${c.name}=${c.value}`;
};
const clearResend = () => pool.query(`DELETE FROM platform.rate_limit_counters WHERE key LIKE 'otp-send:%'`);

async function signUp(phone: string, name: string) {
  await clearResend();
  const req = await send('POST', '/api/v1/auth/otp/request', { phone });
  const verify = await send('POST', '/api/v1/auth/otp/verify', {
    challengeId: req.json().challengeId,
    code: otp.lastCode(`+91${phone}`) ?? '',
  });
  if (verify.json().session) return cookieOf(verify, '__Host-pb_session');
  const reg = await send('POST', '/api/v1/auth/register', {
    ticket: verify.json().ticket,
    displayName: name,
    ageAttested: true,
    acceptedNoticeVersion: CURRENT_NOTICE_VERSION,
  });
  return cookieOf(reg, '__Host-pb_session');
}

async function photo(hue: number) {
  const w = 1200;
  const h = 800;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,25%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="380" y="260" width="440" height="300" rx="24" fill="rgba(255,255,255,0.18)"/><text x="600" y="440" font-size="96" text-anchor="middle" fill="white" font-family="sans-serif">P</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface Spec {
  title: string;
  address: string;
  area: string;
  lat: number;
  lng: number;
  kind?: 'INDEPENDENT_HOUSE' | 'COMMERCIAL';
  type?: 'PARKING' | 'EV_CHARGING';
  rates: { mode: string; unit: string; pricePaise: number; overnightStart?: string; overnightEnd?: string }[];
  units?: string[];
  covered?: boolean;
  description: string;
  hue: number;
}

async function listing(hostCookie: string, adminCookie: string, s: Spec) {
  const prop = (
    await send(
      'POST',
      '/api/v1/host/properties',
      {
        kind: s.kind ?? 'INDEPENDENT_HOUSE',
        address: s.address,
        latitude: s.lat,
        longitude: s.lng,
        areaLabel: s.area,
      },
      hostCookie,
    )
  ).json();
  const type = s.type ?? 'PARKING';
  const asset = (
    await send(
      'POST',
      '/api/v1/host/assets',
      {
        propertyId: prop.id,
        type,
        title: s.title,
        description: s.description,
        rulesText: 'Please park within the marked bay.',
        accessInstructions: 'Ring the bell at the gate; the bay is on the left.',
      },
      hostCookie,
    )
  ).json();
  const base = `/api/v1/host/assets/${asset.id}`;
  await send(
    'PUT',
    `${base}/parking-details`,
    {
      covered: s.covered ?? true,
      level: 'GROUND',
      maxVehicleClass: 'SUV',
      security: ['CCTV', 'GATED'],
      lighting: true,
    },
    hostCookie,
  );
  if (type === 'EV_CHARGING') {
    await send(
      'PUT',
      `${base}/charger-details`,
      {
        connectors: ['TYPE2', 'CCS2'],
        currentType: 'AC',
        powerKw: 7.4,
        cableProvided: true,
        connectionType: 'EV_METERED',
      },
      hostCookie,
    );
    await send('POST', `${base}/attestations`, { kind: 'CHARGER_SAFETY', accepted: true }, hostCookie);
  }
  if (s.units) await send('PUT', `${base}/units`, { labels: s.units }, hostCookie);
  await send(
    'PUT',
    `${base}/rates`,
    { rates: s.rates.map((r) => ({ overnightStart: null, overnightEnd: null, ...r })) },
    hostCookie,
  );
  await send(
    'PUT',
    `${base}/availability-rules`,
    { rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '00:00' }] },
    hostCookie,
  );
  await send('POST', `${base}/attestations`, { kind: 'RIGHT_TO_RENT', accepted: true }, hostCookie);
  await send('POST', `${base}/media?kind=SLOT`, await photo(s.hue), hostCookie, 'image/png');
  if (type === 'EV_CHARGING')
    await send('POST', `${base}/media?kind=CHARGER`, await photo(s.hue + 120), hostCookie, 'image/png');
  await send('POST', `${base}/submit`, {}, hostCookie);
  await send('POST', `/api/admin/assets/${asset.id}/approve`, {}, adminCookie);
  return asset.id as string;
}

try {
  const existing = await pool.query(
    `SELECT 1 FROM identity.users WHERE display_name = 'Meera (sample host)' LIMIT 1`,
  );
  if (existing.rowCount) {
    console.log('Sample data already present; nothing to do.');
  } else {
    // Admin (for listing review) with TOTP.
    await signUp(ACCOUNTS.admin, 'Sample Admin');
    const grant = await modules.identity.grantPlatformAdmin({
      phone: ACCOUNTS.admin,
      permissions: ['SUPER_ADMIN'],
      grantedBy: null,
    });
    await clearResend();
    const areq = await send('POST', '/api/admin/auth/otp/request', { phone: ACCOUNTS.admin });
    const aver = await send('POST', '/api/admin/auth/otp/verify', {
      challengeId: areq.json().challengeId,
      code: otp.lastCode(`+91${ACCOUNTS.admin}`) ?? '',
    });
    const secret = new URL(grant.enrollmentUri ?? '').searchParams.get('secret') ?? '';
    const atotp = await send('POST', '/api/admin/auth/totp', {
      ticket: aver.json().ticket,
      code: hotp(base32Decode(secret), totpStep(Math.floor(Date.now() / 1000))),
    });
    const admin = cookieOf(atotp, '__Host-pb_admin');

    const host = await signUp(ACCOUNTS.host, 'Meera (sample host)');
    await send('POST', '/api/v1/host/account', { kind: 'INDIVIDUAL', displayName: 'Meera' }, host);
    const host2 = await signUp(ACCOUNTS.host2, 'Arjun (sample host)');
    await send('POST', '/api/v1/host/account', { kind: 'BUSINESS', displayName: 'Arjun Motors' }, host2);

    const hourly = (p: number) => ({ mode: 'HOURLY', unit: 'PER_HOUR', pricePaise: p });
    await listing(host, admin, {
      title: 'Covered driveway near Forum Mall',
      address: '14, 5th Cross, Koramangala 4th Block, Bengaluru',
      area: 'Koramangala',
      lat: 12.9352,
      lng: 77.6245,
      description: 'Covered, gated driveway in a quiet lane. Five minutes walk to Forum Mall.',
      rates: [
        hourly(4000),
        { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 25000 },
        {
          mode: 'OVERNIGHT',
          unit: 'PER_NIGHT',
          pricePaise: 15000,
          overnightStart: '20:00',
          overnightEnd: '08:00',
        },
        { mode: 'MONTHLY', unit: 'PER_MONTH', pricePaise: 300000 },
      ],
      hue: 210,
    });
    await listing(host, admin, {
      title: 'Open stilt parking off 100 Feet Road',
      address: '221, 12th Main, Indiranagar, Bengaluru',
      area: 'Indiranagar',
      lat: 12.9719,
      lng: 77.6412,
      covered: false,
      description: 'Stilt-level bay in an independent house, suits sedans and SUVs.',
      rates: [hourly(3000), { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 20000 }],
      hue: 30,
    });
    await listing(host2, admin, {
      title: 'Shop lot with guard, HSR Sector 2',
      address: 'Shop 4, 27th Main, HSR Layout Sector 2, Bengaluru',
      area: 'HSR Layout',
      lat: 12.9116,
      lng: 77.6474,
      kind: 'COMMERCIAL',
      units: ['A1', 'A2', 'A3'],
      description: 'Three bays in front of our showroom. Security guard on duty 8 am – 10 pm.',
      rates: [hourly(2500), { mode: 'DAILY', unit: 'PER_DAY', pricePaise: 15000 }],
      hue: 140,
    });
    await listing(host2, admin, {
      title: 'Type 2 / CCS2 home charger, Koramangala',
      address: '8, 1st Cross, Koramangala 6th Block, Bengaluru',
      area: 'Koramangala',
      lat: 12.9385,
      lng: 77.6199,
      type: 'EV_CHARGING',
      description: '7.4 kW AC wallbox with parking bay. Cable provided.',
      rates: [{ mode: 'CHARGING_SESSION', unit: 'PER_HOUR', pricePaise: 12000 }],
      hue: 280,
    });

    const customer = await signUp(ACCOUNTS.customer, 'Priya (sample customer)');
    await send('POST', '/api/v1/me/vehicles', { plate: 'KA 01 AB 1234', vehicleClass: 'SEDAN' }, customer);
    console.log('Seeded 4 listings, 2 hosts, 1 customer and an admin.');
  }
  const fixed = env.OTP_PROVIDER === 'dev-fixed' ? env.OTP_DEV_FIXED_CODE : '(printed in the API log)';
  console.log(`\nSign in at http://localhost:4100 with any of these numbers; code ${fixed}:`);
  console.log(`  Host (Meera):       ${ACCOUNTS.host}`);
  console.log(`  Host (Arjun Motors): ${ACCOUNTS.host2}`);
  console.log(`  Customer (Priya):   ${ACCOUNTS.customer}`);
} finally {
  await app.close();
  await pool.end();
}
