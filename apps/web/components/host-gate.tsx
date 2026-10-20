'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { HostAccount } from '../lib/host';
import { Field, FormError } from './field';

/**
 * Hosting-mode guard (ux-architecture §3.1): signed-out → sign in; no host account → "Become a host"; otherwise
 * renders the host screen. The API authorises every call again; this only routes the person.
 */
export function HostGate({ children }: { children: (account: HostAccount) => ReactNode }) {
  const router = useRouter();
  const [account, setAccount] = useState<HostAccount | null>(null);
  const [state, setState] = useState<'loading' | 'none' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setAccount(await apiRequest<HostAccount>('/api/v1/host/account'));
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace(`/sign-in?next=${encodeURIComponent(location.pathname)}`);
        return;
      }
      if (e instanceof ApiError && e.status === 404) return setState('none');
      setError(e instanceof ApiError ? e.userMessage : 'Could not load your host account.');
      setState('error');
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function become(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = new FormData(event.currentTarget);
      setAccount(
        await apiRequest<HostAccount>('/api/v1/host/account', {
          method: 'POST',
          body: { kind: 'INDIVIDUAL', displayName: String(form.get('displayName') ?? '') },
        }),
      );
      setState('ready');
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not create your host account.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p aria-busy="true">Loading…</p>;
  if (state === 'error') {
    return (
      <div>
        <FormError message={error} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (state === 'none' || !account) {
    return (
      <form onSubmit={become} noValidate>
        <h1>Earn from your parking space</h1>
        <p>
          List a driveway, a stilt slot or a commercial lot. You decide when it&apos;s available and what it
          costs.
        </p>
        <Field
          id="displayName"
          name="displayName"
          label="Your name as customers see it"
          hint="First name is fine."
          maxLength={80}
          required
        />
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Become a host'}
        </button>
      </form>
    );
  }
  return <>{children(account)}</>;
}
