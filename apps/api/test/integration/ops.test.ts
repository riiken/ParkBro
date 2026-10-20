import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpsHealth } from '../../src/modules/ops/ops-health.ts';
import { opsMonitorRoutes } from '../../src/modules/ops/http/routes.ts';
import { createDb } from '../../src/platform/db/database.ts';
import { at, bookingKit, istDay } from './helpers/booking.ts';
import { createTestDatabase, type TestDatabase } from './helpers/db.ts';
import { identityHarness, type IdentityHarness } from './helpers/identity-app.ts';

const TOKEN = 'ops-monitor-token-for-tests-0123456789';
let db: TestDatabase;
let h: IdentityHarness;
let trust: string;
let kit: ReturnType<typeof bookingKit>;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await identityHarness(db, {
    // The composed endpoint has no token in tests (disabled); mount a second copy with one.
    extraRoutes: async (api) => {
      await api.register(opsMonitorRoutes, {
        prefix: '/t',
        ops: createOpsHealth({ db: createDb(db.pool) as never }),
        token: TOKEN,
      });
    },
  });
  trust = await h.adminSignIn(['TRUST_SAFETY']);
  kit = bookingKit(h, () => trust, db);
});

afterAll(async () => {
  await h.close();
  await db.drop();
});

const monitor = (auth?: string) =>
  h.app.inject({ method: 'GET', url: '/api/t/health/ops', headers: auth ? { authorization: auth } : {} });

describe('operational health', () => {
  it('is ok when nothing is stuck; the monitor endpoint needs the token and is off without one', async () => {
    expect((await h.get('/api/health/ops')).statusCode).toBe(404);
    expect((await monitor()).statusCode).toBe(401);
    expect((await monitor('Bearer wrong-token')).statusCode).toBe(401);
    const res = await monitor(`Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.find((c: { name: string }) => c.name === 'jobs_failed_24h').status).toMatch(
      /ok|unknown/,
    );
    expect(Object.keys(body.checks[0])).toEqual(['name', 'status', 'value']);
  });

  it('a stuck hold warns; a customer stuck at a gate is critical (503) with runbook text for admins', async () => {
    const l = await kit.listing(1, { units: ['A1', 'A2'] });
    const c = await kit.customer();
    const b = await kit.booked(c, l.assetId, at(istDay(2), '10:00'), at(istDay(2), '12:00'));
    // Simulate a stopped expire-holds job (test-only).
    await kit.sql(
      `UPDATE booking.bookings SET hold_expires_at = now() - interval '6 minutes' WHERE id = $1`,
      [b.id],
    );
    let body = (await monitor(`Bearer ${TOKEN}`)).json();
    expect(body.status).toBe('warn');
    expect(body.checks.find((x: { name: string }) => x.name === 'holds_not_expired')).toEqual({
      name: 'holds_not_expired',
      status: 'warn',
      value: 1,
    });

    // An open "can't get in" issue past its deadline (booking-issues job stopped).
    await kit.sql(`UPDATE booking.bookings SET status = 'CONFIRMED', hold_expires_at = NULL WHERE id = $1`, [
      b.id,
    ]);
    await kit.sql(
      `INSERT INTO booking.booking_issues (id, booking_id, kind, reporter_kind, status, deadline_at)
       VALUES (gen_random_uuid(), $1, 'ACCESS_DENIED', 'CUSTOMER', 'OPEN', now() - interval '10 minutes')`,
      [b.id],
    );
    const res = await monitor(`Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(503);
    body = res.json();
    expect(body.status).toBe('critical');

    expect((await h.get('/api/admin/v1/ops/health', c.cookie)).statusCode).toBe(401);
    const admin = (await h.get('/api/admin/v1/ops/health', trust)).json();
    const issue = admin.checks.find((x: { name: string }) => x.name === 'issues_past_deadline');
    expect(issue).toMatchObject({ area: 'access', value: 1, status: 'critical', criticalAt: 1 });
    expect(issue.meaning).toMatch(/stuck at a gate/);
  });
});
