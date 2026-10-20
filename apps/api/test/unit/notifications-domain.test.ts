import { describe, expect, it } from 'vitest';
import {
  channelsFor,
  MAX_ATTEMPTS,
  render,
  RETRY_MINUTES,
  TEMPLATES,
} from '../../src/modules/notifications/domain/templates.ts';

const all = { messaging: true, email: false, push: false };

describe('channel policy (D-144)', () => {
  it('always in-app, plus WhatsApp, falling back to SMS', () => {
    expect(channelsFor('TRANSACTIONAL', {}, all)).toEqual(['IN_APP', 'WHATSAPP']);
    expect(channelsFor('TRANSACTIONAL', { WHATSAPP: false }, all)).toEqual(['IN_APP', 'SMS']);
    expect(channelsFor('TRANSACTIONAL', { WHATSAPP: false, SMS: false }, all)).toEqual(['IN_APP']);
  });
  it('critical messages ignore opt-outs for one external channel', () => {
    expect(channelsFor('CRITICAL', { WHATSAPP: false, SMS: false }, all)).toEqual(['IN_APP', 'SMS']);
  });
  it('without a provider only in-app; email/push only when available and wanted', () => {
    expect(channelsFor('CRITICAL', {}, { messaging: false, email: false, push: false })).toEqual(['IN_APP']);
    expect(channelsFor('TRANSACTIONAL', {}, { messaging: false, email: true, push: true })).toEqual([
      'IN_APP',
      'PUSH',
      'EMAIL',
    ]);
    expect(channelsFor('REMINDER', {}, { messaging: false, email: true, push: true })).toEqual([
      'IN_APP',
      'PUSH',
    ]);
    expect(
      channelsFor(
        'TRANSACTIONAL',
        { PUSH: false, EMAIL: false },
        { messaging: false, email: true, push: true },
      ),
    ).toEqual(['IN_APP']);
  });
});

describe('templates', () => {
  it('render with the listing, time and amount; never need personal data', () => {
    const m = render('booking.confirmed.customer', {
      listingTitle: 'Covered driveway',
      date: 'Fri, 23 Oct',
      time: '10:00 am',
    });
    expect(m.title).toBe('Booking confirmed');
    expect(m.text).toBe(
      'ParkBro: Booking confirmed. Covered driveway on Fri, 23 Oct at 10:00 am. Your access details are in the app.',
    );
    expect(render('refund.started.customer', { listingTitle: 'X', amount: '₹80' }).body).toContain('₹80');
    for (const key of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
      const r = render(key, { listingTitle: 'L', date: 'D', time: 'T', amount: 'A' });
      expect(r.text.length).toBeLessThanOrEqual(300); // fits SMS concatenation limits comfortably
      expect(r.text).not.toMatch(/undefined/);
    }
  });
  it('retry schedule backs off and ends', () => {
    expect(RETRY_MINUTES).toEqual([1, 5, 30, 120, 360]);
    expect(MAX_ATTEMPTS).toBe(6);
  });
});
