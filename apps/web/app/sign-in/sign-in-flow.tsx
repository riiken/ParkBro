'use client';

import { ApiError, apiRequest, safeNextPath } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/field';

type Step =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string; challengeId: string; resendAt: number }
  | { kind: 'register'; ticket: string };

interface OtpRequested {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
}
type Verified = { status: 'AUTHENTICATED' } | { status: 'REGISTRATION_REQUIRED'; ticket: string };

/** Customer sign-in / sign-up by phone OTP (ux-architecture C-06; trust-and-safety V-PHONE). */
export function SignInFlow({ next }: { next: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (step.kind !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step.kind]);

  const done = () => router.replace(safeNextPath(next));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.userMessage);
        setFieldErrors(e.fieldErrors);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(phone: string) {
    const res = await apiRequest<OtpRequested>('/api/v1/auth/otp/request', {
      method: 'POST',
      body: { phone },
    });
    setStep({
      kind: 'code',
      phone,
      challengeId: res.challengeId,
      resendAt: Date.now() + res.resendAfterSeconds * 1000,
    });
  }

  function onPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phone = String(new FormData(event.currentTarget).get('phone') ?? '');
    void run(() => sendCode(phone));
  }

  function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'code') return;
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    void run(async () => {
      const res = await apiRequest<Verified>('/api/v1/auth/otp/verify', {
        method: 'POST',
        body: { challengeId: step.challengeId, code },
      });
      if (res.status === 'AUTHENTICATED') done();
      else setStep({ kind: 'register', ticket: res.ticket });
    });
  }

  function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'register') return;
    const form = new FormData(event.currentTarget);
    const missing: Record<string, string> = {};
    if (form.get('age') !== 'on') missing.ageAttested = 'You must be 18 or older to use the service.';
    if (form.get('terms') !== 'on') missing.terms = 'Accept the Terms and Privacy notice to continue.';
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      return;
    }
    void run(async () => {
      const notice = await apiRequest<{ version: string }>('/api/v1/auth/notice');
      await apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: {
          ticket: step.ticket,
          displayName: String(form.get('displayName') ?? ''),
          ageAttested: true,
          acceptedNoticeVersion: notice.version,
        },
      });
      done();
    });
  }

  if (step.kind === 'phone') {
    return (
      <form onSubmit={onPhone} noValidate>
        <h1>Sign in or create an account</h1>
        <p className="muted">We&apos;ll text you a 6-digit code. No password needed.</p>
        <Field
          id="phone"
          name="phone"
          label="Mobile number"
          hint="10-digit Indian mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          required
          error={fieldErrors.phone}
        />
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Sending code…' : 'Send code'}
        </button>
      </form>
    );
  }

  if (step.kind === 'code') {
    const wait = Math.max(0, Math.ceil((step.resendAt - now) / 1000));
    return (
      <form onSubmit={onCode} noValidate>
        <h1>Enter your code</h1>
        <p className="muted">
          We sent a code to the number ending {step.phone.replace(/\D/g, '').slice(-4)}.
        </p>
        <Field
          id="code"
          name="code"
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          error={fieldErrors.code}
        />
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <div className="row">
          <button
            type="button"
            className="link"
            disabled={busy || wait > 0}
            onClick={() => void run(() => sendCode(step.phone))}
          >
            {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
          </button>
          <button type="button" className="link" onClick={() => setStep({ kind: 'phone' })}>
            Change number
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={onRegister} noValidate>
      <h1>Create your account</h1>
      <Field
        id="displayName"
        name="displayName"
        label="Your name"
        hint="Hosts see your first name and the initial of your last name."
        autoComplete="name"
        maxLength={60}
        required
        error={fieldErrors.displayName}
      />
      <div className="check">
        <input id="age" name="age" type="checkbox" required />
        <label htmlFor="age">I am 18 or older</label>
      </div>
      {fieldErrors.ageAttested ? <p className="field-error">{fieldErrors.ageAttested}</p> : null}
      <div className="check">
        <input id="terms" name="terms" type="checkbox" required />
        <label htmlFor="terms">
          I agree to the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy notice</Link>
        </label>
      </div>
      {fieldErrors.terms ? <p className="field-error">{fieldErrors.terms}</p> : null}
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
