'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type Step = { kind: 'phone' } | { kind: 'otp'; challengeId: string } | { kind: 'totp'; ticket: string };

/** Admin sign-in: phone OTP, then mandatory authenticator (TOTP) code (architecture.md §9). */
export default function AdminSignInPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>, action: (value: string) => Promise<void>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value') ?? '').trim();
    setBusy(true);
    setError(null);
    action(value)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.userMessage : 'Something went wrong.'))
      .finally(() => setBusy(false));
  }

  const config = {
    phone: {
      title: 'Admin sign in',
      label: 'Mobile number',
      input: { type: 'tel', autoComplete: 'tel-national' },
      action: async (phone: string) => {
        const res = await apiRequest<{ challengeId: string }>('/api/admin/auth/otp/request', {
          method: 'POST',
          body: { phone },
        });
        setStep({ kind: 'otp', challengeId: res.challengeId });
      },
    },
    otp: {
      title: 'Enter the SMS code',
      label: '6-digit code',
      input: { inputMode: 'numeric' as const, autoComplete: 'one-time-code' },
      action: async (code: string) => {
        if (step.kind !== 'otp') return;
        const res = await apiRequest<{ ticket: string }>('/api/admin/auth/otp/verify', {
          method: 'POST',
          body: { challengeId: step.challengeId, code },
        });
        setStep({ kind: 'totp', ticket: res.ticket });
      },
    },
    totp: {
      title: 'Authenticator code',
      label: 'Code from your authenticator app',
      input: { inputMode: 'numeric' as const, autoComplete: 'one-time-code' },
      action: async (code: string) => {
        if (step.kind !== 'totp') return;
        await apiRequest('/api/admin/auth/totp', { method: 'POST', body: { ticket: step.ticket, code } });
        router.replace('/');
      },
    },
  }[step.kind];

  return (
    <main className="page">
      <form key={step.kind} onSubmit={(e) => submit(e, config.action)} noValidate>
        <h1>{config.title}</h1>
        <div className="field">
          <label htmlFor="value">{config.label}</label>
          <input id="value" name="value" required {...config.input} />
        </div>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : 'Continue'}
        </button>
      </form>
    </main>
  );
}
