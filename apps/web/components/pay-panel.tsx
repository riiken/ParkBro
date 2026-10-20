'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useEffect, useRef, useState } from 'react';
import { formatRupees } from '../lib/booking';
import { FormError } from './field';

interface Payment {
  id: string;
  status: 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  provider: 'FAKE' | 'RAZORPAY';
  amountPaise: number;
  failureReason: string | null;
  checkout: Record<string, string | number> | null;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open(): void;
      on(event: string, cb: () => void): void;
    };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('checkout unavailable'));
    document.head.appendChild(s);
  });
}

/**
 * C-05 pay → C-08 provider checkout → C-09 confirming. The page never decides that a payment succeeded: after
 * checkout it asks the server, which asks the provider, and it waits (polling) for the booking to be confirmed.
 */
export function PayPanel({
  bookingId,
  amountPaise,
  onConfirmed,
}: {
  bookingId: string;
  amountPaise: number;
  onConfirmed: () => void;
}) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checkout' | 'confirming'>('idle');
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string>('');
  const polls = useRef(0);

  async function start() {
    setError(null);
    key.current ||= crypto.randomUUID(); // one key per attempt: retries can't create two orders
    try {
      const p = await apiRequest<Payment>(`/api/v1/bookings/${encodeURIComponent(bookingId)}/payments`, {
        method: 'POST',
        headers: { 'idempotency-key': key.current },
      });
      setPayment(p);
      if (p.provider === 'RAZORPAY' && p.checkout) await openRazorpay(p);
      else setPhase('checkout');
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not start the payment.');
    }
  }

  async function openRazorpay(p: Payment) {
    await loadRazorpay();
    const c = p.checkout ?? {};
    const Checkout = window.Razorpay;
    if (!Checkout) throw new Error('checkout unavailable');
    const rzp = new Checkout({
      key: c.keyId,
      order_id: c.orderId,
      amount: c.amount,
      currency: 'INR',
      name: c.name,
      handler: (res: { razorpay_payment_id: string; razorpay_signature: string }) =>
        void returned(p.id, {
          providerPaymentId: res.razorpay_payment_id,
          signature: res.razorpay_signature,
        }),
      modal: { ondismiss: () => void returned(p.id, {}) },
    });
    rzp.open();
    setPhase('checkout');
  }

  async function simulated(outcome: 'captured' | 'failed') {
    if (!payment) return;
    try {
      await apiRequest(`/api/v1/dev/fake-checkout/${payment.id}`, { method: 'POST', body: { outcome } });
      await returned(payment.id, {});
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Test checkout failed.');
    }
  }

  async function returned(paymentId: string, body: { providerPaymentId?: string; signature?: string }) {
    setPhase('confirming');
    polls.current = 0;
    try {
      const p = await apiRequest<Payment>(`/api/v1/payments/${paymentId}/return`, { method: 'POST', body });
      setPayment(p);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not check the payment.');
    }
  }

  // C-09: wait for the server-verified result; give up politely after ~1 minute (reconciliation continues).
  useEffect(() => {
    if (phase !== 'confirming' || !payment) return;
    if (payment.status === 'SUCCEEDED') return onConfirmed();
    if (payment.status === 'FAILED') {
      setPhase('idle');
      setError(
        `Payment didn't go through. ${payment.failureReason ?? ''} No money was taken; if it was, it will be refunded automatically.`.trim(),
      );
      key.current = '';
      return;
    }
    if (polls.current >= 20) return;
    const t = setTimeout(async () => {
      polls.current += 1;
      try {
        setPayment(await apiRequest<Payment>(`/api/v1/payments/${payment.id}`));
      } catch {
        // keep waiting
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [phase, payment, onConfirmed]);

  return (
    <div className="notice" aria-live="polite">
      {phase === 'idle' ? (
        <button type="button" onClick={() => void start()}>
          Pay {formatRupees(amountPaise)}
        </button>
      ) : null}
      {phase === 'checkout' && payment?.provider === 'FAKE' ? (
        <div role="group" aria-label="Test checkout">
          <p className="small">Test payments: no real money moves.</p>
          <div className="row-start">
            <button type="button" onClick={() => void simulated('captured')}>
              Complete test payment
            </button>
            <button type="button" className="link" onClick={() => void simulated('failed')}>
              Simulate a failed payment
            </button>
          </div>
        </div>
      ) : null}
      {phase === 'confirming' ? (
        <p role="status">
          Waiting for payment confirmation from your bank or UPI app…
          {polls.current >= 20
            ? ' This is taking longer than usual; we will update your booking as soon as it arrives.'
            : ''}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
